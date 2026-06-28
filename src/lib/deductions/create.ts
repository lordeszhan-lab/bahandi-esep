/**
 * Deduction case creation — the impure approval hook (Prompt 18).
 *
 * `maybeCreateDeductionCase` is called from the approval state machine
 * (`applyDecision` in workflow/state.ts) the moment a write-off reaches
 * `approved`. It is the *no-blame default* made concrete:
 *
 *   • withholding = false (honest waste)            → no case, ever.
 *   • withholding = true but no charged employee    → no case (nobody to charge).
 *   • withholding = true + charged employee + value → open a `proposed` case,
 *     with the basis text + the Labor-Code cap enforced on `amount`.
 *
 * Idempotent: if a non-terminal deduction already exists for this write-off we
 * leave it alone, so re-approving after an admin `request_more` reopen does not
 * spawn a second case. Service role — `deductions` INSERT is reviewer/admin, and
 * the state machine already runs service-side.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/db/types";
import { appendAuditEntry } from "@/lib/audit";
import {
  buildDeductionBasis,
  computeDeductionAmount,
} from "@/lib/deductions/config";

export interface CreateDeductionResult {
  /** True when a new deduction row was inserted this call. */
  created: boolean;
  /** The deduction id when created, else the existing id when one was already open. */
  deductionId: string | null;
  /** Machine reason surfaced to the audit log / caller. */
  reason: string;
}

/**
 * Open a deduction case for `writeoffId` iff it is a withholding write-off with
 * a charged employee and a positive chargeable value. No-op (no case) for honest
 * waste — the no-blame default. `actorId` is the reviewer/admin who approved.
 */
export async function maybeCreateDeductionCase(
  service: SupabaseClient<Database>,
  writeoffId: string,
  actorId: string,
): Promise<CreateDeductionResult> {
  // ── Load the write-off + joined reason code + charged employee ───────────────
  // Single read via an embedded join; supabase-js returns nested objects.
  const { data: raw, error } = await service
    .from("writeoffs")
    .select(
      "id, withholding, charged_employee_id, reason_code_id, qty, unit, value_cost, comment, created_at, status",
    )
    .eq("id", writeoffId)
    .maybeSingle();

  if (error || !raw) {
    return { created: false, deductionId: null, reason: "writeoff_not_found" };
  }
  const w = raw as {
    id: string;
    withholding: boolean;
    charged_employee_id: string | null;
    reason_code_id: string;
    qty: number;
    unit: string;
    value_cost: number | null;
    comment: string | null;
    created_at: string;
    status: string;
  };

  // No-blame default: honest waste never opens a case.
  if (!w.withholding) {
    return { created: false, deductionId: null, reason: "no_withholding" };
  }
  if (!w.charged_employee_id) {
    return { created: false, deductionId: null, reason: "no_charged_employee" };
  }

  // ── Resolve reason-code label + employee (name + monthly salary) ───────────
  // Fetched before the cap compute so the statutory ceiling (50% of wages,
  // ст. 115 ТК РК) reads the employee's actual salary, falling back to the
  // configurable default when it is unknown.
  const [reasonRes, employeeRes] = await Promise.all([
    service
      .from("reason_codes")
      .select("label_ru")
      .eq("id", w.reason_code_id)
      .maybeSingle(),
    service
      .from("employees")
      .select("full_name, monthly_salary")
      .eq("id", w.charged_employee_id)
      .maybeSingle(),
  ]);
  const reasonLabel =
    (reasonRes.data as { label_ru: string } | null)?.label_ru ?? "Списание";
  const employeeRow = employeeRes.data as
    | { full_name: string; monthly_salary: number | null }
    | null;
  const employeeName = employeeRow?.full_name ?? "Сотрудник";
  const employeeMonthlySalary = employeeRow?.monthly_salary ?? null;

  const { amount, capAmount, capped, salaryMissing } = computeDeductionAmount(
    w.value_cost,
    employeeMonthlySalary,
  );
  if (amount <= 0) {
    // Nothing to withhold (no value or zero) — no case.
    return { created: false, deductionId: null, reason: "no_value" };
  }

  // ── Idempotency: skip if a non-terminal deduction already exists ─────────────
  // Terminal = applied / cancelled. A re-approve after reopen should not create a
  // duplicate; an existing proposed/acknowledged/disputed/approved case is kept.
  const { data: existing } = await service
    .from("deductions")
    .select("id, status")
    .eq("writeoff_id", writeoffId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const existingRow = existing as { id: string; status: string } | null;
  if (existingRow && !["applied", "cancelled"].includes(existingRow.status)) {
    return {
      created: false,
      deductionId: existingRow.id,
      reason: "case_already_open",
    };
  }

  const basis = buildDeductionBasis({
    writeoffRef: w.id.slice(0, 8),
    createdAt: w.created_at,
    reasonLabel,
    qty: w.qty,
    unit: w.unit,
    valueCost: w.value_cost,
    capAmount,
    capped,
    salaryMissing,
    employeeName,
  });

  // ── Insert the proposed case ─────────────────────────────────────────────────
  const insertRow = {
    writeoff_id: w.id,
    employee_id: w.charged_employee_id,
    amount,
    basis,
    cap_amount: capAmount,
    status: "proposed",
  };

  const { data: inserted, error: insertErr } = await service
    .from("deductions")
    .insert(insertRow as unknown as never)
    .select("id")
    .single();

  if (insertErr || !inserted) {
    // A failed case open must not roll back the approval — but it IS the legal
    // record, so log loudly and surface the reason.
    console.error(
      `[deductions] case insert failed for ${writeoffId}: ${insertErr?.message ?? "no row"}`,
    );
    return { created: false, deductionId: null, reason: "insert_failed" };
  }
  const deductionId = (inserted as { id: string }).id;

  // ── Audit (hash-chained) — the case-open is part of the tamper-evident trail ─
  try {
    await appendAuditEntry(service, {
      writeoffId: w.id,
      actorId,
      action: "deduction_case_opened",
      payload: {
        deduction_id: deductionId,
        employee_id: w.charged_employee_id,
        amount,
        cap_amount: capAmount,
        capped,
        salary_missing: salaryMissing,
        value_cost: w.value_cost,
        reason_label: reasonLabel,
      } as unknown as Record<string, unknown>,
    });
  } catch (err) {
    console.error(
      "[deductions] case-open audit failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return { created: true, deductionId, reason: "case_opened" };
}
