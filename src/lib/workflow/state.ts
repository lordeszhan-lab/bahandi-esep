/**
 * Approval state machine — Prompt 13.
 *
 * Centralizes every LEGAL status transition for a write-off and rejects the
 * illegal ones, so review decisions can't land a row in a state the workflow
 * doesn't allow. `applyDecision` is the impure entry point a reviewer/admin
 * action calls: it loads the row, validates the transition + the actor's role,
 * persists the new status (and tier/SLA hand-offs), and writes a hash-chained
 * audit entry via the centralized audit module.
 *
 * Decisions (the cockpit's one-tap actions, Prompt 12):
 *
 *   approve      → status "approved"    (terminal; handed to Iiko sync)
 *   reject       → status "rejected"    (terminal)
 *   request_more → status "on_hold"     (needs more info / evidence; keeps tier)
 *   escalate     → tier bumped one rung (manager→area→finance), status preserved,
 *                  fresh SLA window. Rejects when already at the top tier.
 *
 * Role gating:
 *   • reviewer + admin may approve / reject / request_more / escalate on the
 *     active review statuses.
 *   • approving a dual_control write-off requires admin (the second pair of
 *     eyes on high-value / high-score items).
 *   • reopening a terminal state (approved / rejected) is admin-only, via
 *     `request_more` (→ on_hold). approve/reject/escalate on a terminal row are
 *     rejected — a decision already happened.
 *
 * Convention: the transition graph lives in `LEGAL_NEXT`; the action→target
 * mapping in `DECISION_TARGET`; role rules in `canDecide`. `applyDecision`
 * never silently no-ops — it throws on an illegal move so the caller surfaces
 * the rejection, and writes an audit entry on every successful move.
 */

import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  EscalationTier,
  UserRole,
  WriteoffStatus,
} from "@/lib/db/types";
import { appendAuditEntry } from "@/lib/audit";
import { ROUTING_CONFIG, computeSlaDueAt, nextTier, tierForValue } from "@/lib/workflow/route";
import { maybeCreateDeductionCase } from "@/lib/deductions/create";

// ── Transition graph ──────────────────────────────────────────────────────────

/**
 * Legal forward status transitions. Terminal states (approved/rejected) are
 * reopenable by admin via `request_more` → on_hold. The router owns the
 * submitted → auto_approved/in_review/dual_control/on_hold moves; this table
 * permits them so a manual decision on a freshly-submitted row is still legal.
 */
export const LEGAL_NEXT: Record<WriteoffStatus, WriteoffStatus[]> = {
  draft: ["submitted"],
  submitted: ["auto_approved", "in_review", "dual_control", "on_hold", "approved", "rejected"],
  auto_approved: ["in_review", "dual_control", "on_hold", "approved", "rejected"],
  in_review: ["dual_control", "on_hold", "approved", "rejected"],
  dual_control: ["on_hold", "approved", "rejected"],
  on_hold: ["in_review", "dual_control", "approved", "rejected"],
  approved: ["on_hold", "in_review"],
  rejected: ["in_review", "on_hold"],
};

/** The one-tap decision actions the cockpit exposes. */
export type DecisionAction = "approve" | "reject" | "escalate" | "request_more";

/**
 * Maps a decision to its target status. `escalate` is absent — it bumps the
 * tier and preserves the status, so it has no target status.
 */
export const DECISION_TARGET: Partial<Record<DecisionAction, WriteoffStatus>> = {
  approve: "approved",
  reject: "rejected",
  request_more: "on_hold",
};

/** Active review statuses a reviewer can act on (non-terminal, post-routing). */
const ACTIVE_REVIEW_STATUSES: readonly WriteoffStatus[] = [
  "submitted",
  "auto_approved",
  "in_review",
  "dual_control",
  "on_hold",
];

const TERMINAL_STATUSES: readonly WriteoffStatus[] = ["approved", "rejected"];

// ── Role gating (pure) ───────────────────────────────────────────────────────

export interface DecisionAuthorization {
  ok: boolean;
  /** Machine reason code, surfaced to the UI when the move is rejected. */
  reason: string | null;
}

/**
 * Is `actorRole` allowed to apply `action` to a row currently in `from`?
 * Pure — the impure checks (row scope, existence) live in `applyDecision`.
 */
export function canDecide(
  from: WriteoffStatus,
  action: DecisionAction,
  actorRole: UserRole,
): DecisionAuthorization {
  if (actorRole !== "reviewer" && actorRole !== "admin") {
    return { ok: false, reason: "not_authorized" };
  }

  // Terminal states: only admin may reopen, and only via request_more (→ on_hold).
  if (TERMINAL_STATUSES.includes(from)) {
    if (actorRole !== "admin") return { ok: false, reason: "reopen_admin_only" };
    if (action !== "request_more") return { ok: false, reason: "already_decided" };
    return { ok: true, reason: null };
  }

  // Non-terminal but not reviewable (draft hasn't been submitted).
  if (!ACTIVE_REVIEW_STATUSES.includes(from)) {
    return { ok: false, reason: "not_reviewable" };
  }

  // dual_control approval requires admin (second pair of eyes).
  if (from === "dual_control" && action === "approve" && actorRole !== "admin") {
    return { ok: false, reason: "dual_control_admin_only" };
  }

  return { ok: true, reason: null };
}

// ── Result types ─────────────────────────────────────────────────────────────

export interface DecisionResult {
  writeoffId: string;
  action: DecisionAction;
  from: WriteoffStatus;
  to: WriteoffStatus;
  tier: EscalationTier | null;
  slaDueAt: string | null;
  /** The human-facing note the reviewer attached (request_more / reject). */
  note: string | null;
  applied: boolean;
}

// ── Impure entry point ───────────────────────────────────────────────────────

export interface ApplyDecisionArgs {
  writeoffId: string;
  action: DecisionAction;
  actorId: string;
  actorRole: UserRole;
  /** Reviewer note for request_more / reject / escalate. Optional. */
  note?: string | null;
  /** Override marker recorded in the audit payload when a reviewer confirms an
   * approve past a hard signal — e.g. "approved_despite_geofence" when the
   * reviewer approves a write-off whose photo was taken outside the store's
   * geofence. The decision itself is still a normal approve; this only stamps
   * the audit trail. */
  override?: string | null;
  /** Override for tests / shared transactions. */
  service?: SupabaseClient<Database>;
  /** Reference time (epoch ms). Defaults to now. */
  now?: number;
}

/**
 * Apply a one-tap review decision to a write-off. Validates the transition +
 * role, persists the new status (and tier/SLA hand-offs for escalate), and
 * appends a hash-chained audit entry. Throws on an illegal move so the caller
 * surfaces the rejection to the reviewer.
 *
 * `approve` and `auto_approved→approved` set `iiko_sync_status='pending'` so the
 * Iiko sync (Prompt 16) picks the row up — matching the router's hand-off.
 */
export async function applyDecision(
  args: ApplyDecisionArgs,
): Promise<DecisionResult> {
  const service = args.service ?? createServiceClient();
  const now = args.now ?? Date.now();
  const note = args.note?.trim() ? args.note.trim() : null;
  const override = args.override?.trim() ? args.override.trim() : null;

  // ── Load the row ────────────────────────────────────────────────────────────
  const { data: raw, error } = await service
    .from("writeoffs")
    .select(
      "id, status, risk_score, value_cost, escalation_tier, assigned_queue, sla_due_at, location_id",
    )
    .eq("id", args.writeoffId)
    .single();
  if (error || !raw) {
    throw new Error(
      `[state] writeoff ${args.writeoffId} not found: ${error?.message ?? "no row"}`,
    );
  }
  const current = raw as {
    id: string;
    status: string;
    risk_score: number;
    value_cost: number | null;
    escalation_tier: EscalationTier | null;
    assigned_queue: string | null;
    sla_due_at: string | null;
    location_id: string;
  };
  const from = current.status as WriteoffStatus;

  // ── Authorize ───────────────────────────────────────────────────────────────
  const authz = canDecide(from, args.action, args.actorRole);
  if (!authz.ok) {
    throw new Error(`[state] ${args.action} not allowed on ${from}: ${authz.reason}`);
  }

  // ── Compute the target status + tier + SLA ──────────────────────────────────
  let toStatus: WriteoffStatus = from;
  let tier: EscalationTier | null = current.escalation_tier;
  let slaDueAt: string | null = current.sla_due_at;
  let machineReason: string = args.action;
  const patch: Record<string, unknown> = {
    decided_by: args.actorId,
    decided_at: new Date(now).toISOString(),
  };

  if (args.action === "escalate") {
    const currentTier = current.escalation_tier ?? tierForValue(current.value_cost ?? 0);
    const up = nextTier(currentTier);
    if (!up) {
      throw new Error(`[state] escalate: already at top tier (${currentTier})`);
    }
    tier = up;
    toStatus = from; // status preserved
    slaDueAt = new Date(
      now + ROUTING_CONFIG.escalationSlaHours * 60 * 60 * 1000,
    ).toISOString();
    patch.escalation_tier = up;
    patch.assigned_queue = up;
    patch.sla_due_at = slaDueAt;
    patch.sla_escalated_at = new Date(now).toISOString();
    machineReason = `escalated:${currentTier}->${up}`;
  } else {
    const target = DECISION_TARGET[args.action];
    if (!target) {
      throw new Error(`[state] no target for action ${args.action}`);
    }
    toStatus = target;
    // Validate against the legal transition graph.
    if (!LEGAL_NEXT[from].includes(target)) {
      throw new Error(
        `[state] illegal transition ${from} -> ${target} for ${args.action}`,
      );
    }
    if (target === "approved") {
      tier = null;
      slaDueAt = null;
      patch.status = target;
      patch.escalation_tier = null;
      patch.sla_due_at = null;
      patch.assigned_queue = null;
      patch.iiko_sync_status = "pending"; // hand to Iiko sync (Prompt 16)
    } else if (target === "rejected") {
      tier = null;
      slaDueAt = null;
      patch.status = target;
      patch.escalation_tier = null;
      patch.sla_due_at = null;
      patch.assigned_queue = null;
    } else if (target === "on_hold") {
      // request_more: keep the tier, reset the SLA clock for the hold window.
      slaDueAt = computeSlaDueAt("on_hold", now);
      patch.status = target;
      patch.sla_due_at = slaDueAt;
    }
    machineReason = `${args.action}:${from}->${target}`;
  }

  // ── Persist ─────────────────────────────────────────────────────────────────
  const { error: updErr } = await service
    .from("writeoffs")
    .update(patch as unknown as never)
    .eq("id", args.writeoffId);
  if (updErr) {
    throw new Error(
      `[state] persist failed for ${args.writeoffId}: ${updErr.message}`,
    );
  }

  // ── Audit (hash-chained) ────────────────────────────────────────────────────
  // `override` is included only when set, so a normal approve's payload is
  // unchanged and a geofence-override approve is stamped in the chain.
  const auditPayload: Record<string, unknown> = {
    from,
    to: toStatus,
    reason: machineReason,
    note,
    tier,
    sla_due_at: slaDueAt,
    score: current.risk_score,
    value: current.value_cost,
    queue: current.assigned_queue,
  };
  if (override) auditPayload.override = override;
  await appendAuditEntry(service, {
    writeoffId: args.writeoffId,
    actorId: args.actorId,
    action: args.action,
    payload: auditPayload,
  });

  // ── Deduction case (Prompt 18) ───────────────────────────────────────────────
  // On approval, open a deduction case iff the write-off withholds from a charged
  // employee. No-blame default: honest waste (withholding=false) opens no case.
  // Best-effort — a failed case-open must not roll back the approval; the helper
  // logs loudly and never throws.
  if (toStatus === "approved") {
    try {
      await maybeCreateDeductionCase(service, args.writeoffId, args.actorId);
    } catch (err) {
      console.error(
        "[state] deduction case open failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    writeoffId: args.writeoffId,
    action: args.action,
    from,
    to: toStatus,
    tier,
    slaDueAt,
    note,
    applied: true,
  };
}
