-- ============================================================
-- Bahandi esep — risk engine + workflow fields (Prompts 10 & 11)
-- Applied: 2026-06-27
--
-- Adds the columns the risk scorer and the policy-as-code router
-- need to persist their decisions on the writeoff row itself, so the
-- cockpit (Prompt 12) can read one row and render the whole story:
-- the score, the contributing features, the assigned review queue,
-- the escalation tier, and the SLA deadline.
-- ============================================================

alter table public.writeoffs
  -- Breakdown of every feature that contributed to risk_score, with the
  -- point value and a small detail blob per feature. Written by the risk
  -- engine on every recompute (Prompt 10).
  add column risk_features    jsonb,
  -- Which human queue owns the review: a tier label, 'investigation'
  -- (on_hold), or 'auto' (auto_approved). Free text so policy can evolve
  -- without a migration.
  add column assigned_queue   text,
  -- Value-based escalation tier (Prompt 11): location_manager → area →
  -- finance. Null for auto_approved / not-yet-routed rows.
  add column escalation_tier  text
    check (escalation_tier in ('location_manager','area','finance')),
  -- When the current review status goes overdue (Prompt 11 SLA). Null for
  -- auto_approved / approved / rejected.
  add column sla_due_at       timestamptz,
  -- Timestamp of the last SLA escalation (tier bump). Null until the
  -- overdue scanner escalates for the first time.
  add column sla_escalated_at timestamptz;

-- Hot path: the overdue scanner (escalateOverdue) filters on
-- sla_due_at across the small set of active review statuses.
create index on public.writeoffs (sla_due_at)
  where sla_due_at is not null;
create index on public.writeoffs (assigned_queue)
  where assigned_queue is not null;
create index on public.writeoffs (escalation_tier)
  where escalation_tier is not null;

comment on column public.writeoffs.risk_score is
  '0–100 aggregate risk score recomputed by the risk engine on every new risk_event (Prompt 10).';
comment on column public.writeoffs.risk_features is
  'JSON array of {feature, points, detail} that contributed to risk_score — the cockpit breakdown (Prompt 10).';
