"use server";

/**
 * Deduction case actions — employee + reviewer/admin (Prompt 18).
 *
 * The legal transition graph lives in `deductions/config.ts`; these actions are
 * its impure counterpart. Each one authenticates the caller, authorizes against
 * the case (employee actions require the caller to be a location peer of the
 * charged employee; approve/apply/cancel require reviewer/admin), validates the
 * transition via `canTransition`, persists the new status, and appends a
 * hash-chained audit entry. `revalidatePath` refreshes the surface afterward.
 *
 * Flow:
 *   proposed → acknowledged (employee e-signature) ┐
 *   proposed → disputed     (employee reason)      ├─ only acknowledged → approved
 *   acknowledged → approved (reviewer/admin)       │   → applied (admin, to payroll).
 *   disputed → proposed/cancelled (admin)          ┘
 *   approved → applied (admin) | cancelled (admin)
 */

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getCurrentProfile } from "@/lib/auth";
import { appendAuditEntry } from "@/lib/audit";
import { canTransition } from "@/lib/deductions/config";
import type { DeductionStatus } from "@/lib/db/types";

export interface DeductionActionResult {
  ok: boolean;
  error?: string;
  deductionId?: string;
  status?: DeductionStatus;
}

// ── Shared loader ─────────────────────────────────────────────────────────────

/**
 * Load a deduction row + the charged employee's location, for authorization.
 * Service role so the caller's RLS doesn't hide the row mid-check.
 */
async function loadDeduction(service: ReturnType<typeof createServiceClient>, id: string) {
  const { data, error } = await service
    .from("deductions")
    .select("id, status, employee_id, writeoff_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string; status: string; employee_id: string; writeoff_id: string };
}

/**
 * Authorize an employee action: the caller must share a location with the charged
 * employee (mirrors the `deductions_update_employee` RLS policy, but explicit so
 * we control the error). Returns the deduction row on success.
 */
async function authorizeEmployeeAction(
  deductionId: string,
): Promise<{ ok: true; row: NonNullable<Awaited<ReturnType<typeof loadDeduction>>> } | { ok: false; error: string }> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Не авторизован" };

  const service = createServiceClient();
  const row = await loadDeduction(service, deductionId);
  if (!row) return { ok: false, error: "Удержание не найдено" };

  // Resolve the charged employee's location.
  const { data: emp } = await service
    .from("employees")
    .select("location_id")
    .eq("id", row.employee_id)
    .maybeSingle();
  const empLoc = (emp as { location_id: string | null } | null)?.location_id ?? null;

  if (!profile.location_id || profile.location_id !== empLoc) {
    return { ok: false, error: "Это удержание не относится к вашей точке" };
  }
  return { ok: true, row };
}

/** Authorize a reviewer/admin action. Admin-only actions pass `adminOnly`. */
async function authorizeStaffAction(
  adminOnly = false,
): Promise<{ ok: true; role: "reviewer" | "admin" } | { ok: false; error: string }> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Не авторизован" };
  if (profile.role === "admin") return { ok: true, role: "admin" };
  if (profile.role === "reviewer" && !adminOnly) return { ok: true, role: "reviewer" };
  return { ok: false, error: adminOnly ? "Только администратор" : "Нет прав" };
}

/** Persist a status transition + hash-chained audit entry. Throws on DB error. */
async function applyTransition(
  deductionId: string,
  from: DeductionStatus,
  to: DeductionStatus,
  actorId: string | null,
  extra: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<void> {
  const service = createServiceClient();
  const { error } = await service
    .from("deductions")
    .update({ ...patch, status: to } as unknown as never)
    .eq("id", deductionId);
  if (error) {
    throw new Error(`[deductions] persist failed: ${error.message}`);
  }

  // Load the writeoff_id for the audit entry (the chain is writeoff-scoped).
  const row = await loadDeduction(service, deductionId);
  try {
    await appendAuditEntry(service, {
      writeoffId: row?.writeoff_id ?? null,
      actorId,
      action: `deduction_${to}`,
      payload: { deduction_id: deductionId, from, to, ...extra } as unknown as Record<
        string,
        unknown
      >,
    });
  } catch (err) {
    console.error(
      "[deductions] transition audit failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Employee: Acknowledge (e-signature) ───────────────────────────────────────

/**
 * Employee acknowledges a `proposed` deduction with an e-signature. The typed
 * name must match the employee's profile name (the legal "I agree" gesture); the
 * stored signature binds the name + deduction + timestamp under a SHA-256 hash so
 * the acknowledgement is self-evident and tamper-resistant. → `acknowledged`.
 */
export async function acknowledgeDeductionAction(
  deductionId: string,
  signatureName: string,
): Promise<DeductionActionResult> {
  const name = (signatureName ?? "").trim();
  if (!name) return { ok: false, error: "Введите имя для подписи" };

  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Не авторизован" };
  // The typed signature must match the acknowledger's own name.
  if (name.toLowerCase() !== profile.full_name.trim().toLowerCase()) {
    return { ok: false, error: "Подпись должна совпадать с вашим именем в профиле" };
  }

  const authz = await authorizeEmployeeAction(deductionId);
  if (!authz.ok) return { ok: false, error: authz.error };
  const from = authz.row.status as DeductionStatus;
  const to: DeductionStatus = "acknowledged";
  if (!canTransition(from, to)) {
    return { ok: false, error: `Нельзя подтвердить из статуса «${from}»` };
  }

  const ts = new Date().toISOString();
  const hash = createHash("sha256")
    .update(`${name}|${deductionId}|${ts}`)
    .digest("hex");
  const signature = `ack:${name}|${deductionId}|${ts}|${hash.slice(0, 16)}`;

  try {
    await applyTransition(
      deductionId,
      from,
      to,
      profile.id,
      { signature_name: name, signature_hash: hash.slice(0, 16) },
      { acknowledged_at: ts, signature, dispute_reason: null },
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Не удалось подтвердить",
    };
  }

  revalidatePath("/my/deductions");
  revalidatePath("/review/deductions");
  return { ok: true, deductionId, status: to };
}

// ── Employee: Dispute (reason) ────────────────────────────────────────────────

/**
 * Employee disputes a `proposed` deduction, stating a reason. The case becomes
 * `disputed` — a hard stop: it can no longer reach `approved` until an admin
 * re-opens it (`proposed`) or upholds the dispute (`cancelled`).
 */
export async function disputeDeductionAction(
  deductionId: string,
  reason: string,
): Promise<DeductionActionResult> {
  const disputeReason = (reason ?? "").trim();
  if (disputeReason.length < 3) {
    return { ok: false, error: "Опишите причину оспаривания (мин. 3 символа)" };
  }

  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Не авторизован" };

  const authz = await authorizeEmployeeAction(deductionId);
  if (!authz.ok) return { ok: false, error: authz.error };
  const from = authz.row.status as DeductionStatus;
  const to: DeductionStatus = "disputed";
  if (!canTransition(from, to)) {
    return { ok: false, error: `Нельзя оспорить из статуса «${from}»` };
  }

  try {
    await applyTransition(
      deductionId,
      from,
      to,
      profile.id,
      { dispute_reason: disputeReason },
      { dispute_reason: disputeReason },
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Не удалось оспорить",
    };
  }

  revalidatePath("/my/deductions");
  revalidatePath("/review/deductions");
  return { ok: true, deductionId, status: to };
}

// ── Reviewer/admin: Approve (only after acknowledgment) ───────────────────────

/**
 * Reviewer/admin approves an `acknowledged` deduction → `approved`. This is the
 * gate the Labor Code demands: the case can only be approved *after* the employee
 * acknowledged; `proposed` and `disputed` are rejected here.
 */
export async function approveDeductionAction(
  deductionId: string,
): Promise<DeductionActionResult> {
  const authz = await authorizeStaffAction(false);
  if (!authz.ok) return { ok: false, error: authz.error };

  const service = createServiceClient();
  const row = await loadDeduction(service, deductionId);
  if (!row) return { ok: false, error: "Удержание не найдено" };
  const from = row.status as DeductionStatus;
  const to: DeductionStatus = "approved";
  if (!canTransition(from, to)) {
    return {
      ok: false,
      error:
        from === "disputed"
          ? "Оспоренное удержание нельзя утвердить — рассмотрите спор"
          : from === "proposed"
            ? "Сотрудник ещё не подтвердил удержание"
            : `Нельзя утвердить из статуса «${from}»`,
    };
  }

  const profile = await getCurrentProfile();
  try {
    await applyTransition(deductionId, from, to, profile?.id ?? null, {}, {});
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Не удалось утвердить",
    };
  }

  revalidatePath("/review/deductions");
  revalidatePath("/my/deductions");
  return { ok: true, deductionId, status: to };
}

// ── Admin: Apply to payroll ───────────────────────────────────────────────────

/**
 * Admin marks an `approved` deduction as `applied` — handed to payroll. Terminal.
 * Admin-only: the payroll hand-off is a finance action, not a reviewer's call.
 */
export async function applyDeductionAction(
  deductionId: string,
): Promise<DeductionActionResult> {
  const authz = await authorizeStaffAction(true);
  if (!authz.ok) return { ok: false, error: authz.error };

  const service = createServiceClient();
  const row = await loadDeduction(service, deductionId);
  if (!row) return { ok: false, error: "Удержание не найдено" };
  const from = row.status as DeductionStatus;
  const to: DeductionStatus = "applied";
  if (!canTransition(from, to)) {
    return { ok: false, error: `Нельзя применить из статуса «${from}»` };
  }

  const profile = await getCurrentProfile();
  try {
    await applyTransition(deductionId, from, to, profile?.id ?? null, {}, {});
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Не удалось применить",
    };
  }

  revalidatePath("/review/deductions");
  revalidatePath("/my/deductions");
  return { ok: true, deductionId, status: to };
}

// ── Reviewer/admin: Cancel (e.g. dispute upheld) ──────────────────────────────

/**
 * Reviewer/admin cancels a deduction — e.g. an upheld dispute, or a mistake.
 * Reachable from `proposed`, `acknowledged`, `disputed`, `approved`. Terminal.
 */
export async function cancelDeductionAction(
  deductionId: string,
  reason: string,
): Promise<DeductionActionResult> {
  const cancelReason = (reason ?? "").trim();
  if (cancelReason.length < 3) {
    return { ok: false, error: "Укажите причину отмены (мин. 3 символа)" };
  }
  const authz = await authorizeStaffAction(false);
  if (!authz.ok) return { ok: false, error: authz.error };

  const service = createServiceClient();
  const row = await loadDeduction(service, deductionId);
  if (!row) return { ok: false, error: "Удержание не найдено" };
  const from = row.status as DeductionStatus;
  const to: DeductionStatus = "cancelled";
  if (!canTransition(from, to)) {
    return { ok: false, error: `Нельзя отменить из статуса «${from}»` };
  }

  const profile = await getCurrentProfile();
  try {
    await applyTransition(
      deductionId,
      from,
      to,
      profile?.id ?? null,
      { cancel_reason: cancelReason },
      { dispute_reason: cancelReason },
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Не удалось отменить",
    };
  }

  revalidatePath("/review/deductions");
  revalidatePath("/my/deductions");
  return { ok: true, deductionId, status: to };
}

// ── Admin: Re-open a disputed case ────────────────────────────────────────────

/**
 * Admin re-opens a `disputed` case back to `proposed` — e.g. after investigating
 * the dispute and asking the employee to re-acknowledge on corrected terms.
 */
export async function reopenDeductionAction(
  deductionId: string,
): Promise<DeductionActionResult> {
  const authz = await authorizeStaffAction(true);
  if (!authz.ok) return { ok: false, error: authz.error };

  const service = createServiceClient();
  const row = await loadDeduction(service, deductionId);
  if (!row) return { ok: false, error: "Удержание не найдено" };
  const from = row.status as DeductionStatus;
  const to: DeductionStatus = "proposed";
  if (!canTransition(from, to)) {
    return { ok: false, error: `Нельзя переоткрыть из статуса «${from}»` };
  }

  const profile = await getCurrentProfile();
  try {
    await applyTransition(
      deductionId,
      from,
      to,
      profile?.id ?? null,
      { reopened_from: from },
      { acknowledged_at: null, signature: null, dispute_reason: null },
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Не удалось переоткрыть",
    };
  }

  revalidatePath("/review/deductions");
  revalidatePath("/my/deductions");
  return { ok: true, deductionId, status: to };
}
