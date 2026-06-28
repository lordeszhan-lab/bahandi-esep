/**
 * Compliant deduction workflow — pure config + logic (Prompt 18).
 *
 * Deductions (удержания) are the legally exposed surface of the product: a
 * write-off that withholds from an employee's pay opens a *case* the charged
 * employee must Acknowledge (e-signature) or Dispute (reason) before a single
 * tenge can be applied.
 *
 * Legal basis — Labour Code of the Republic of Kazakhstan (Law No. 414-V of
 * 2015), referenced by article constants below so the citations are never
 * hardcoded scattered:
 *   • ст. 123 ТК РК — материальная ответственность работника за ущерб
 *     (the basis to charge the employee for spoilage / shortage / damage).
 *   • ст. 115 ТК РК — удержания из заработной платы: удержание по акту
 *     работодателя допускается только при письменном согласии работника;
 *     общий размер удержаний ≤ 50% причитающейся зарплаты.
 *
 * This module is the single source of truth for the PURE pieces:
 *   • `LABOR_CODE`                — article citation constants.
 *   • `DEDUCTION_CONFIG`          — the cap fraction + default salary (env-overridable).
 *   • `computeCapAmount()`        — the statutory ceiling (50% of wages), in KZT.
 *   • `computeDeductionAmount()`  — value clamped to the cap (the actual charge).
 *   • `buildDeductionBasis()`     — the human-readable legal basis text.
 *   • `LEGAL_NEXT` / `canTransition` — the legal status graph (no skipping ack).
 *   • `DeductionStatus` literals + labels.
 *
 * The impure create-on-approve hook lives in `create.ts`; the employee/reviewer
 * actions live in `src/lib/actions/deductions.ts`. Nothing here touches the DB.
 */

import type { DeductionStatus } from "@/lib/db/types";

// ── Status model ──────────────────────────────────────────────────────────────

export type { DeductionStatus } from "@/lib/db/types";

export const DEDUCTION_STATUSES: readonly DeductionStatus[] = [
  "proposed",
  "acknowledged",
  "disputed",
  "approved",
  "applied",
  "cancelled",
];

/** Russian labels for the deduction status pills (СВЕРКА: calm, no joy). */
export const DEDUCTION_STATUS_LABEL: Record<DeductionStatus, string> = {
  proposed: "Ожидает подтверждения",
  acknowledged: "Подтверждено",
  disputed: "Оспорено",
  approved: "Утверждено",
  applied: "Применено",
  cancelled: "Отменено",
};

/**
 * Risk-semantic token for each status (drives `.pill-status[data-risk=…]`).
 * The pill colours stay inside the СВЕРКА triad — deductions are a serious
 * surface, so no info-blue playfulness: ack/approved/applied = clean (green),
 * proposed = watch (amber, awaiting action), disputed = fraud (red, blocked),
 * cancelled = neutral-muted.
 */
export const DEDUCTION_STATUS_RISK: Record<
  DeductionStatus,
  "clean" | "watch" | "fraud" | "info" | "muted"
> = {
  proposed: "watch",
  acknowledged: "clean",
  disputed: "fraud",
  approved: "clean",
  applied: "clean",
  cancelled: "muted",
};

// ── Legal transition graph ────────────────────────────────────────────────────

/**
 * Legal forward transitions. The core invariant — *only after acknowledgment
 * can status reach approved→applied* — is encoded here: `approved` is reachable
 * ONLY from `acknowledged`, never from `proposed` or `disputed`. A disputed case
 * is a hard stop until an admin re-opens it (`proposed`) or cancels it.
 *
 *   proposed      → acknowledged (employee ack) | disputed (employee dispute) | cancelled (admin)
 *   acknowledged  → approved (reviewer/admin)   | cancelled (admin)
 *   disputed      → proposed (admin re-open)    | cancelled (admin uphold)
 *   approved      → applied (admin, to payroll) | cancelled (admin)
 *   applied       → (terminal)
 *   cancelled     → (terminal)
 */
export const LEGAL_NEXT: Record<DeductionStatus, DeductionStatus[]> = {
  proposed: ["acknowledged", "disputed", "cancelled"],
  acknowledged: ["approved", "cancelled"],
  disputed: ["proposed", "cancelled"],
  approved: ["applied", "cancelled"],
  applied: [],
  cancelled: [],
};

/** True when `from → to` is a legal forward transition. Pure. */
export function canTransition(
  from: DeductionStatus,
  to: DeductionStatus,
): boolean {
  return LEGAL_NEXT[from].includes(to);
}

// ── Labour Code citations (Law No. 414-V of 2015) ─────────────────────────────

/**
 * Labour Code article citations — single source of truth so they are never
 * hardcoded scattered across the deduction flow.
 *
 *   • `liability`  — ст. 123 ТК РК: материальная ответственность работника
 *     за порчу / недостачу / повреждение продукции (the basis to charge).
 *   • `deduction`  — ст. 115 ТК РК: удержания из заработной платы — по акту
 *     работодателя только при письменном согласии работника, общий размер
 *     удержаний ≤ 50% причитающейся зарплаты (the cap + consent procedure).
 */
export const LABOR_CODE = {
  /** Material liability of the employee for damage (basis to charge). */
  liability: "ст. 123 ТК РК",
  /** Wage withholding: consent + ≤ 50% cap (the deduction procedure). */
  deduction: "ст. 115 ТК РК",
} as const;

// ── Cap enforcement (Labour Code Art. 115 — 50% of wages) ────────────────────

/**
 * The statutory ceiling for a single employer-ordered deduction is 50% of the
 * employee's monthly wages (ст. 115 ТК РК) — NOT a flat tenge figure. We read
 * the charged employee's `monthly_salary`; when it is unknown we fall back to a
 * configurable default salary and flag the case so the gap is visible.
 *
 * There is no fixed statutory tenge cap; the fraction (0.5) is the law. The
 * default salary is only a fallback for rows without a recorded wage — override
 * both via env to retune.
 */
export const DEDUCTION_CONFIG = {
  /** Statutory max fraction of one month's wages an employer may withhold (ст. 115). */
  laborCodeWithholdFraction: 0.5,
  /** Fallback monthly wage (KZT) used when an employee has no recorded salary. */
  defaultMonthlySalaryKzt: Number(process.env.DEDUCTION_DEFAULT_SALARY_KZT ?? 300_000),
} as const;

/**
 * The statutory ceiling for one deduction (KZT). When `monthlySalary` is a
 * positive number the cap is `50% × salary`; otherwise the configurable default
 * salary is used and `salaryMissing` is returned so the caller can flag it.
 * Pure.
 */
export function computeCapAmount(
  monthlySalary?: number | null,
): { capAmount: number; salaryMissing: boolean } {
  const salaryMissing =
    monthlySalary == null ||
    !Number.isFinite(monthlySalary) ||
    monthlySalary <= 0;
  const base = salaryMissing
    ? DEDUCTION_CONFIG.defaultMonthlySalaryKzt
    : monthlySalary;
  const capAmount = Math.round(base * DEDUCTION_CONFIG.laborCodeWithholdFraction);
  return { capAmount, salaryMissing };
}

/**
 * The amount actually charged: the write-off's value clamped to the cap, and
 * only when positive (the `deductions` table has `check (amount > 0)`). A
 * write-off with no value_cost or a value of 0 opens no case — there is nothing
 * to withhold. Pure.
 *
 * Returns `{ amount, capAmount, capped, salaryMissing }` so the caller can
 * record the ceiling, whether the charge was truncated to it, and whether the
 * cap fell back to the default salary (the employee's wage was unknown).
 */
export function computeDeductionAmount(
  valueCost: number | null | undefined,
  monthlySalary?: number | null,
): {
  amount: number;
  capAmount: number;
  capped: boolean;
  salaryMissing: boolean;
} {
  const { capAmount, salaryMissing } = computeCapAmount(monthlySalary);
  if (valueCost == null || !Number.isFinite(valueCost) || valueCost <= 0) {
    return { amount: 0, capAmount, capped: false, salaryMissing };
  }
  const amount = Math.min(valueCost, capAmount);
  return {
    amount: Math.round(amount),
    capAmount,
    capped: amount < valueCost,
    salaryMissing,
  };
}

// ── Basis text ────────────────────────────────────────────────────────────────

export interface BasisInput {
  /** Short write-off ref, e.g. first 8 chars of the id — for human reference. */
  writeoffRef: string;
  /** ISO timestamp the write-off was created. */
  createdAt: string;
  /** Russian reason-code label (what was written off). */
  reasonLabel: string;
  qty: number;
  unit: string;
  valueCost: number | null;
  /** The enforced cap (KZT). */
  capAmount: number;
  /** True when the charge was truncated to the cap. */
  capped: boolean;
  /** True when the employee's salary was unknown and the cap fell back to the default. */
  salaryMissing?: boolean;
  /** Name of the employee charged. */
  employeeName: string;
}

/**
 * Compose the legally-worded basis text recorded on the deduction case. Names
 * the act, the reason, the quantity/value, the charged employee, and cites both
 * Labour Code articles correctly — ст. 123 (material liability, the basis to
 * charge) and ст. 115 (written consent + the 50%-of-wages cap) — so the case
 * file is self-explanatory without the app. Pure.
 */
export function buildDeductionBasis(input: BasisInput): string {
  const date = input.createdAt.slice(0, 10);
  const valueTxt =
    input.valueCost != null
      ? `${Math.round(input.valueCost).toLocaleString("ru-RU")} ₸`
      : "оценка отсутствует";
  const capTxt = `${input.capAmount.toLocaleString("ru-RU")} ₸`;
  const capNote = input.capped
    ? ` Удержание ограничено 50% месячной зарплаты (${capTxt}).`
    : "";
  const salaryNote = input.salaryMissing
    ? ` Зарплата сотрудника не указана — расчёт по умолчанию (${capTxt}).`
    : "";
  return (
    `Акт списания №${input.writeoffRef} от ${date}: ${input.reasonLabel} — ` +
    `${input.qty} ${input.unit}, сумма ${valueTxt}.` +
    ` Виновный сотрудник: ${input.employeeName}.` +
    ` Основание — материальная ответственность работника за порчу/недостачу ` +
    `продукции (${LABOR_CODE.liability}). Удержание производится с письменного ` +
    `согласия работника, в пределах 50% зарплаты (${LABOR_CODE.deduction}).` +
    capNote +
    salaryNote
  );
}
