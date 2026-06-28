/**
 * Smart routing / policy-as-code (Prompts 11 & 11.1).
 *
 * Humans review only the suspicious; the rest auto-flows. Given a write-off's
 * risk score, value, and hard-gate flags, the policy decides which queue it
 * lands in and stamps an SLA deadline. The decision is a PURE function
 * (`decideRoute`) so it is unit-testable; `routeWriteoff` is the impure wrapper
 * that loads the row, applies the decision, persists the status transition +
 * SLA + tier, and writes an audit entry. `rerouteWriteoff` re-evaluates an
 * existing row (the retest helper). `escalateOverdue` is the SLA scanner that
 * bumps the tier when a review goes overdue.
 *
 * Policy (Prompt 11.1 — precedence top-down):
 *
 *   HARD GATES (evaluated first; bypass all numeric thresholds):
 *     phash_dup_hit | vision_mismatch   → on_hold     (investigation — fraud hold)
 *     vision_unverified | geofence_fail → in_review   (needs a human, not a fraud hold)
 *     A write-off carrying ANY hard-gate flag can NEVER be auto_approved.
 *   NUMERIC PATH (only when no hard-gate flag is present):
 *     score ≥ 60  ||  value ≥ highValueThreshold → dual_control
 *     15 ≤ score < 60                            → in_review
 *     score < 15  &&  value < highValueThreshold → auto_approved  → proceeds to Iiko
 *
 * Correctness that an unverified photo never auto-approves comes from the HARD
 * GATES, not the score; the vision_unverified weight (+25) only makes the meter
 * read as elevated. on_hold gates are more severe than in_review gates, so if a
 * write-off carries both, on_hold wins.
 *
 * Tier escalation by value (manager → area → finance) decides WHO reviews for
 * in_review / dual_control / on_hold; auto_approved has no tier.
 *
 * SLA timers per status; an overdue review escalates one tier (manager→area→
 * finance) and gets a fresh window. Auto-approved write-offs get iiko_sync_status
 * = 'pending' so the Iiko sync (Prompt 16) picks them up.
 *
 * Convention: every threshold + the hard-gate flag list lives in
 * `ROUTING_CONFIG`; every decision is logged to `audit_log` (hash-chained).
 */

import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, EscalationTier, WriteoffStatus } from "@/lib/db/types";
import { RISK_THRESHOLDS } from "@/lib/risk/score";
import { appendAuditEntry } from "@/lib/audit";

// ── Config (the one place thresholds live) ────────────────────────────────────

/**
 * SLA hours for every write-off status. Review statuses carry a deadline;
 * draft/submitted (pre-routing), auto_approved (flows to Iiko) and the final
 * approved/rejected have no SLA. Typed as a full Record so the router can index
 * it with any WriteoffStatus without a cast.
 */
const SLA_HOURS: Record<WriteoffStatus, number> = {
  draft: 0,
  submitted: 0,
  auto_approved: 0,
  in_review: 4,
  dual_control: 24,
  on_hold: 48,
  approved: 0,
  rejected: 0,
};

/** Features that force a HARD GATE → the named status, regardless of score. */
const HOLD_GATE_FEATURES = ["phash_dup_hit", "vision_mismatch"] as const;
const REVIEW_GATE_FEATURES = ["vision_unverified", "geofence_fail", "geofence_unverified"] as const;

/** Statuses the policy is allowed to (re-)route. approved/rejected/draft are
 *  final or not-yet-submitted and are left alone. */
const ROUTABLE_STATUSES: readonly WriteoffStatus[] = [
  "submitted",
  "auto_approved",
  "in_review",
  "dual_control",
  "on_hold",
];

// TUNE — routing policy thresholds + hard-gate flag list.
//   • Numeric bands only apply when NO hard-gate flag is present.
//   • A hard-gate flag can never be auto_approved (Prompt 11.1).
//   • on_hold gates (fraud) outrank in_review gates (needs-a-human).
export const ROUTING_CONFIG = {
  /** value (KZT) at/above this forces dual_control and gates auto-approval.
   *  Kept in lockstep with the risk engine's high-value cut (single source). */
  highValueThreshold: RISK_THRESHOLDS.highValue,
  /** Auto-approval band: score strictly below this AND value below the cut. */
  autoApproveScoreMax: 15,
  /** in_review band lower bound (inclusive). */
  reviewScoreMin: 15,
  /** dual_control band lower bound (inclusive — score at/above this). */
  dualControlScoreMin: 60,
  /** Value-based tier cuts (KZT). */
  managerValueMax: 50_000, // < this → location_manager
  areaValueMax: 200_000, // < this (and ≥ managerValueMax) → area; else finance
  /** SLA hours per status. */
  slaHours: SLA_HOURS,
  /** Hard-gate flags → forced status, bypassing the numeric path (Prompt 11.1). */
  hardGates: {
    onHold: HOLD_GATE_FEATURES,
    inReview: REVIEW_GATE_FEATURES,
  },
  /** Statuses the policy may (re-)route. */
  routableStatuses: ROUTABLE_STATUSES,
  /** When an overdue review escalates, the new tier gets this many SLA hours. */
  escalationSlaHours: 12,
} as const;

/** Every feature key that triggers a hard gate (union of onHold + inReview). */
const HARD_GATE_FEATURES: readonly string[] = [
  ...HOLD_GATE_FEATURES,
  ...REVIEW_GATE_FEATURES,
];

// ── Pure decision helpers (unit-testable) ─────────────────────────────────────

export interface RouteDecision {
  status: WriteoffStatus;
  tier: EscalationTier | null;
  queue: string;
  /** Short machine reason, also stored in the audit payload. */
  reason: string;
}

/**
 * The policy, pure (Prompt 11.1).
 *
 * `hardGateFlags` is the set of hard-gate feature keys present on the write-off
 * (a subset of `ROUTING_CONFIG.hardGates.*`, checked against risk_events by the
 * caller). `hardGateReadFailed` is set when those flags couldn't be read — the
 * policy then fail-closes to in_review so an unverified write-off can never be
 * auto-approved on a transient read error.
 *
 * Precedence: hard gates (on_hold outranks in_review) → numeric path (only when
 * no hard-gate flag is present).
 */
export function decideRoute(args: {
  score: number;
  value: number;
  /** Hard-gate feature keys present on the write-off. */
  hardGateFlags: readonly string[];
  /** True when the hard-gate flags couldn't be read — fail closed to review. */
  hardGateReadFailed?: boolean;
}): RouteDecision {
  const { score, value, hardGateFlags, hardGateReadFailed } = args;
  const highValue = value >= ROUTING_CONFIG.highValueThreshold;

  // ── Fail closed: if we couldn't read the hard-gate flags, never auto-approve.
  if (hardGateReadFailed) {
    return {
      status: "in_review",
      tier: tierForValue(value),
      queue: tierForValue(value),
      reason: "hard_gate_read_failed",
    };
  }

  // ── HARD GATES (evaluated before the numeric path) ──────────────────────────
  // A write-off carrying ANY hard-gate flag can NEVER be auto_approved.
  // on_hold gates (fraud) are more severe than in_review gates (needs a human),
  // so a row carrying both kinds lands on_hold.
  const onHoldSet = new Set<string>(ROUTING_CONFIG.hardGates.onHold);
  const inReviewSet = new Set<string>(ROUTING_CONFIG.hardGates.inReview);
  const hasOnHoldGate = hardGateFlags.some((f) => onHoldSet.has(f));
  const hasInReviewGate = hardGateFlags.some((f) => inReviewSet.has(f));

  if (hasOnHoldGate) {
    return {
      status: "on_hold",
      tier: tierForValue(value),
      queue: "investigation",
      reason: "hold_feature",
    };
  }
  if (hasInReviewGate) {
    return {
      status: "in_review",
      tier: tierForValue(value),
      queue: tierForValue(value),
      reason: "hard_gate_review",
    };
  }

  // ── NUMERIC PATH (only when no hard-gate flag is present) ───────────────────
  if (score >= ROUTING_CONFIG.dualControlScoreMin || highValue) {
    return {
      status: "dual_control",
      tier: tierForValue(value),
      queue: tierForValue(value),
      reason: highValue ? "high_value" : "high_score",
    };
  }
  if (score >= ROUTING_CONFIG.reviewScoreMin) {
    return {
      status: "in_review",
      tier: tierForValue(value),
      queue: tierForValue(value),
      reason: "review_band",
    };
  }
  return {
    status: "auto_approved",
    tier: null,
    queue: "auto",
    reason: "low_risk",
  };
}

/** Value-based review tier: location_manager → area → finance. */
export function tierForValue(value: number): EscalationTier {
  if (value < ROUTING_CONFIG.managerValueMax) return "location_manager";
  if (value < ROUTING_CONFIG.areaValueMax) return "area";
  return "finance";
}

/** Next tier up the escalation ladder, or null when already at the top. */
export function nextTier(tier: EscalationTier): EscalationTier | null {
  if (tier === "location_manager") return "area";
  if (tier === "area") return "finance";
  return null;
}

/**
 * SLA deadline for a status, or null when the status has no SLA (auto_approved).
 * Pure given `now` (epoch ms).
 */
export function computeSlaDueAt(status: WriteoffStatus, now: number): string | null {
  const hours = ROUTING_CONFIG.slaHours[status];
  if (!hours) return null;
  return new Date(now + hours * 60 * 60 * 1000).toISOString();
}

// ── Impure routing ────────────────────────────────────────────────────────────

export interface RouteResult {
  writeoffId: string;
  from: WriteoffStatus;
  to: WriteoffStatus;
  tier: EscalationTier | null;
  queue: string;
  slaDueAt: string | null;
  reason: string;
  /** True when the row actually changed (status/tier/queue); false on no-op. */
  applied: boolean;
}

/**
 * Apply the policy to one write-off: load its score/value/hold features, decide
 * the target queue, and if anything changed persist the transition + SLA + tier
 * and write a hash-chained audit entry. Auto-approved rows are handed to Iiko
 * (iiko_sync_status = 'pending'). No-op (no audit spam) when the decision
 * matches what's already on the row.
 */
export async function routeWriteoff(
  writeoffId: string,
  opts: { now?: number; service?: SupabaseClient<Database> } = {},
): Promise<RouteResult> {
  const service = opts.service ?? createServiceClient();
  const now = opts.now ?? Date.now();

  // ── Load the row ────────────────────────────────────────────────────────────
  const { data: raw, error } = await service
    .from("writeoffs")
    .select(
      "id, status, risk_score, value_cost, escalation_tier, assigned_queue, sla_due_at",
    )
    .eq("id", writeoffId)
    .single();
  if (error || !raw) {
    throw new Error(
      `[route] writeoff ${writeoffId} not found: ${error?.message ?? "no row"}`,
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
  };

  const from = current.status as WriteoffStatus;

  // Final / not-yet-submitted statuses are outside the policy.
  if (!ROUTING_CONFIG.routableStatuses.includes(from)) {
    return {
      writeoffId,
      from,
      to: from,
      tier: current.escalation_tier,
      queue: current.assigned_queue ?? "",
      slaDueAt: current.sla_due_at,
      reason: "not_routable",
      applied: false,
    };
  }

  const { flags: hardGateFlags, readFailed: hardGateReadFailed } =
    await loadHardGateFlags(service, writeoffId);
  const decision = decideRoute({
    score: current.risk_score,
    value: current.value_cost ?? 0,
    hardGateFlags,
    hardGateReadFailed,
  });

  const slaDueAt = computeSlaDueAt(decision.status, now);

  const unchanged =
    decision.status === from &&
    decision.tier === current.escalation_tier &&
    decision.queue === current.assigned_queue;

  if (!unchanged) {
    const patch: Record<string, unknown> = {
      status: decision.status,
      assigned_queue: decision.queue,
      escalation_tier: decision.tier,
      sla_due_at: slaDueAt,
      // A fresh routing decision resets the escalation clock.
      sla_escalated_at: null,
    };
    // Auto-approved → hand off to the Iiko sync (Prompt 16).
    if (decision.status === "auto_approved") {
      patch.iiko_sync_status = "pending";
    }
    const { error: updErr } = await service
      .from("writeoffs")
      .update(patch as unknown as never)
      .eq("id", writeoffId);
    if (updErr) {
      throw new Error(`[route] persist failed for ${writeoffId}: ${updErr.message}`);
    }

    await writeAudit(service, {
      writeoffId,
      action: decision.status === "auto_approved" ? "auto_approved" : "routed",
      payload: {
        from,
        to: decision.status,
        score: current.risk_score,
        value: current.value_cost,
        tier: decision.tier,
        queue: decision.queue,
        sla_due_at: slaDueAt,
        reason: decision.reason,
        hard_gate_flags: hardGateFlags.length > 0 ? hardGateFlags.join(",") : undefined,
      },
    });
  }

  return {
    writeoffId,
    from,
    to: decision.status,
    tier: decision.tier,
    queue: decision.queue,
    slaDueAt: slaDueAt,
    reason: decision.reason,
    applied: !unchanged,
  };
}

/**
 * Re-evaluate an existing write-off's routing against its current persisted
 * state (score + risk_events) — the retest helper (Prompt 11.1). Use this to
 * re-route the latest row without re-uploading: it re-applies the policy to the
 * row as it stands now. To also recompute the score from current events first,
 * call `recomputeAndRoute` (recompute.ts) instead. Thin wrapper around
 * `routeWriteoff` so callers have a single, clearly-named entry point.
 */
export async function rerouteWriteoff(
  writeoffId: string,
  opts: { now?: number; service?: SupabaseClient<Database> } = {},
): Promise<RouteResult> {
  return routeWriteoff(writeoffId, opts);
}

// ── SLA escalation scanner ────────────────────────────────────────────────────

export interface EscalationResult {
  scanned: number;
  escalated: number;
  finalized: number;
}

/**
 * Find reviews past their SLA and escalate them one tier (manager→area→finance),
 * giving the next tier a fresh window. Reviews already at the finance tier are
 * marked finalized (sla_escalated_at set) so they aren't re-picked every run.
 * Intended to run on a schedule (cron / edge function). Every change is audited.
 */
export async function escalateOverdue(
  opts: { now?: number; service?: SupabaseClient<Database> } = {},
): Promise<EscalationResult> {
  const service = opts.service ?? createServiceClient();
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();

  const { data: raw, error } = await service
    .from("writeoffs")
    .select("id, status, escalation_tier, value_cost, sla_due_at")
    .in("status", ["in_review", "dual_control", "on_hold"])
    .not("sla_due_at", "is", null)
    .lt("sla_due_at", nowIso)
    .is("sla_escalated_at", null);

  if (error) {
    console.error("[route] overdue scan failed:", error.message);
    return { scanned: 0, escalated: 0, finalized: 0 };
  }
  const rows = (raw ?? []) as {
    id: string;
    status: WriteoffStatus;
    escalation_tier: EscalationTier | null;
    value_cost: number | null;
    sla_due_at: string | null;
  }[];

  let escalated = 0;
  let finalized = 0;
  for (const row of rows) {
    const tier = row.escalation_tier ?? tierForValue(row.value_cost ?? 0);
    const up = nextTier(tier);
    const newSla = new Date(
      now + ROUTING_CONFIG.escalationSlaHours * 60 * 60 * 1000,
    ).toISOString();

    if (up) {
      const { error: updErr } = await service
        .from("writeoffs")
        .update({
          escalation_tier: up,
          assigned_queue: up,
          sla_due_at: newSla,
          sla_escalated_at: nowIso,
        } as unknown as never)
        .eq("id", row.id);
      if (updErr) {
        console.error(`[route] escalate persist failed for ${row.id}:`, updErr.message);
        continue;
      }
      await writeAudit(service, {
        writeoffId: row.id,
        action: "sla_escalated",
        payload: {
          from_tier: tier,
          to_tier: up,
          sla_due_at: row.sla_due_at,
          new_sla_due_at: newSla,
          status: row.status,
        },
      });
      escalated += 1;
    } else {
      // Already at the top tier — record that we noticed, stop re-scanning it.
      const { error: updErr } = await service
        .from("writeoffs")
        .update({ sla_escalated_at: nowIso } as unknown as never)
        .eq("id", row.id);
      if (updErr) {
        console.error(`[route] finalize persist failed for ${row.id}:`, updErr.message);
        continue;
      }
      await writeAudit(service, {
        writeoffId: row.id,
        action: "sla_overdue_final",
        payload: { tier, sla_due_at: row.sla_due_at, status: row.status },
      });
      finalized += 1;
    }
  }

  return { scanned: rows.length, escalated, finalized };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load the hard-gate feature keys present on a write-off's risk_events.
 * Returns the distinct flags found plus a `readFailed` signal: on a transient
 * read error the caller fail-closes to in_review (via `decideRoute`) so an
 * unverified write-off can never be auto-approved when we can't read its flags.
 */
async function loadHardGateFlags(
  service: SupabaseClient<Database>,
  writeoffId: string,
): Promise<{ flags: string[]; readFailed: boolean }> {
  const { data, error } = await service
    .from("risk_events")
    .select("feature")
    .eq("writeoff_id", writeoffId)
    .in("feature", HARD_GATE_FEATURES as unknown as string[])
    .limit(HARD_GATE_FEATURES.length);
  if (error) {
    console.error("[route] hard-gate read failed:", error.message);
    return { flags: [], readFailed: true };
  }
  const flags = Array.from(
    new Set((data ?? []).map((r) => (r as { feature: string }).feature)),
  );
  return { flags, readFailed: false };
}

type AuditPayload = Record<string, string | number | boolean | null | undefined>;

/**
 * Append a hash-chained audit entry via the centralized audit module (Prompt 13).
 * The chain is global — `appendAuditEntry` links this row to the most recent
 * audit row overall by `prev_hash`, making the whole log tamper-evident. Service
 * role — audit_log has no user INSERT policy by design. A failed audit write
 * must not mask a successful status transition, but it is the integrity record,
 * so we log loudly instead of throwing.
 */
async function writeAudit(
  service: SupabaseClient<Database>,
  entry: { writeoffId: string; action: string; payload: AuditPayload },
): Promise<void> {
  try {
    await appendAuditEntry(service, {
      writeoffId: entry.writeoffId,
      actorId: null,
      action: entry.action,
      payload: entry.payload as Record<string, unknown>,
    });
  } catch (err) {
    console.error(
      `[route] audit insert failed for ${entry.writeoffId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
