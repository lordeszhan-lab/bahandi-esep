"use server";

/**
 * Reviewer decision server actions — Prompt 12 (Prompt fix: org-access vs
 * geofence guard).
 *
 * The cockpit's one-tap Approve / Reject / Escalate / Request-more buttons call
 * these. Each action authenticates the reviewer/admin — the ORG/cluster access
 * check was relaxed: a reviewer may now act on any write-off in a review status,
 * regardless of location/cluster (the demo noise "Запись вне вашей локации" is
 * gone). Employees stay restricted to their own submissions by the
 * `writeoffs_select` RLS policy. The valuable "filed off-location" signal is
 * the GEOFENCE guard on the approve action, surfaced in the review UI; on
 * override the reviewer passes `override=approved_despite_geofence`, which
 * `applyDecision` records into the audit payload.
 *
 * `bulkApprove` approves a batch of clean write-offs in one call — the reviewer
 * selects a clean batch in the cockpit and submits it; each id is validated +
 * transitioned independently so one bad row doesn't void the batch. Bulk-approve
 * is scoped to clean rows only, so a geofence_fail row (severity watch) is never
 * bulk-approved and never needs the geofence confirm here.
 *
 * revalidatePath refreshes the queue after a decision so the card disappears
 * without a manual reload.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import {
  applyDecision,
  type DecisionAction,
} from "@/lib/workflow/state";
import type { UserRole, WriteoffStatus } from "@/lib/db/types";

export interface DecisionActionResult {
  ok: boolean;
  error?: string;
  writeoffId?: string;
  from?: WriteoffStatus;
  to?: WriteoffStatus;
}

export interface BulkApproveResult {
  ok: boolean;
  approved: string[];
  failed: { id: string; error: string }[];
}

// ── Scope guard ───────────────────────────────────────────────────────────────

/**
 * Confirm the current reviewer/admin may act on `writeoffId`. The org/cluster
 * location check was removed (Prompt fix): a reviewer may act on any write-off
 * in a review status, cross-location. The row is loaded with the user's RLS
 * client, so the `writeoffs_select` policy is still the gate — a reviewer can
 * only load rows in the human-review queue, an employee only their own. Admins
 * see everything. Returns the row's current status so the caller can
 * short-circuit on a terminal row without a second query.
 */
async function authorizeOnWriteoff(writeoffId: string): Promise<{
  ok: boolean;
  error?: string;
  status?: WriteoffStatus;
  role?: UserRole;
  actorId?: string;
}> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Не авторизован" };
  if (profile.role !== "reviewer" && profile.role !== "admin") {
    return { ok: false, error: "Нет прав на проверку" };
  }

  const supabase = await createClient();
  const { data: raw, error } = await supabase
    .from("writeoffs")
    .select("status")
    .eq("id", writeoffId)
    .single();
  if (error || !raw) {
    return { ok: false, error: "Запись не найдена" };
  }
  const row = raw as { status: string };

  return {
    ok: true,
    status: row.status as WriteoffStatus,
    role: profile.role,
    actorId: profile.id,
  };
}

// ── One-tap decision ─────────────────────────────────────────────────────────

/**
 * Apply a single one-tap decision. `formData` carries:
 *   - writeoffId
 *   - action  (approve | reject | escalate | request_more)
 *   - note    (optional, for request_more / reject / escalate)
 *   - override (optional, e.g. "approved_despite_geofence" — recorded in the
 *     audit payload when a reviewer confirms an approve past a hard signal)
 */
export async function decideReviewAction(
  formData: FormData,
): Promise<DecisionActionResult> {
  const writeoffId = String(formData.get("writeoffId") ?? "");
  const action = String(formData.get("action") ?? "") as DecisionAction;
  const note = (formData.get("note") as string | null) ?? null;
  const override = (formData.get("override") as string | null) ?? null;

  if (!writeoffId || !action) {
    return { ok: false, error: "Неверные параметры" };
  }
  if (
    action !== "approve" &&
    action !== "reject" &&
    action !== "escalate" &&
    action !== "request_more"
  ) {
    return { ok: false, error: "Неизвестное действие" };
  }

  const authz = await authorizeOnWriteoff(writeoffId);
  if (!authz.ok || !authz.role || !authz.actorId) {
    return { ok: false, error: authz.error };
  }

  try {
    const result = await applyDecision({
      writeoffId,
      action,
      actorId: authz.actorId,
      actorRole: authz.role,
      note,
      override,
    });
    revalidatePath("/review");
    return {
      ok: true,
      writeoffId: result.writeoffId,
      from: result.from,
      to: result.to,
    };
  } catch (err) {
    return {
      ok: false,
      writeoffId,
      error: err instanceof Error ? err.message : "Не удалось применить решение",
    };
  }
}

// ── Bulk-approve (clean batches) ──────────────────────────────────────────────

/**
 * Approve a batch of write-offs. Intended for clean, low-risk batches the
 * reviewer multi-selects in the cockpit. Each id is authorized + transitioned
 * independently; a failure on one row is recorded but does not abort the rest.
 * Cross-location by design (the org/cluster access check was relaxed). Bulk-
 * approve is scoped to clean rows in the UI, so the geofence confirm guard
 * never applies here.
 */
export async function bulkApproveAction(
  ids: string[],
): Promise<BulkApproveResult> {
  const profile = await getCurrentProfile();
  if (!profile) {
    return { ok: false, approved: [], failed: ids.map((id) => ({ id, error: "Не авторизован" })) };
  }
  if (profile.role !== "reviewer" && profile.role !== "admin") {
    return { ok: false, approved: [], failed: ids.map((id) => ({ id, error: "Нет прав" })) };
  }

  const approved: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of ids) {
    const authz = await authorizeOnWriteoff(id);
    if (!authz.ok || !authz.role || !authz.actorId) {
      failed.push({ id, error: authz.error ?? "Не авторизован" });
      continue;
    }
    try {
      await applyDecision({
        writeoffId: id,
        action: "approve",
        actorId: authz.actorId,
        actorRole: authz.role,
      });
      approved.push(id);
    } catch (err) {
      failed.push({
        id,
        error: err instanceof Error ? err.message : "Не удалось утвердить",
      });
    }
  }

  revalidatePath("/review");
  return { ok: failed.length === 0, approved, failed };
}
