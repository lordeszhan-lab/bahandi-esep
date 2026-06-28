-- ============================================================
-- Bahandi esep — review action RLS: relax org/cluster ACCESS (Prompt fix)
-- Applied: 2026-06-28
--
-- Two different "вне локации" were conflated. This migration fixes (1):
--
--   (1) ORG/cluster ACCESS check — a reviewer could not ACT on a write-off
--       outside their assigned location/cluster. The old `writeoffs_update`
--       policy already let reviewer/admin update any row, but the SELECT
--       policy (0003) only exposed in_review/on_hold/dual_control to
--       reviewers, and the application layer added its own manual
--       `profile.location_id = row.location_id` check that returned
--       "Запись вне вашей локации" on every cross-location item. For the
--       demo that is noise firing on ALL items. RELAXED here: reviewer +
--       admin may act on any write-off in a review status
--       (submitted/in_review/on_hold/dual_control), any location/cluster.
--       Employees stay restricted to their own submissions.
--
--   (2) The VALUABLE signal — the write-off PHOTO was taken away from the
--       store (geofence_fail / geofence_unverified) — is NOT an access
--       block. It is surfaced as a confirm guard on the approve action in
--       the review UI (src/components/review/*), and on override the
--       decision records an audit note `approved_despite_geofence`. That
--       guard lives in the app + audit, not in RLS.
--
-- This is the ACCESS layer — it must NOT block normal review.
-- ============================================================

-- ── 1. writeoffs SELECT — reviewer sees the whole human-review queue ──────────
drop policy if exists "writeoffs_select" on public.writeoffs;

-- reviewer + admin → every row in a human-review queue (cross-location / cluster)
-- employee (and anyone) → only their own submissions (any status)
create policy "writeoffs_select"
  on public.writeoffs for select
  using (
    -- own submission: any status (draft, submitted, approved, rejected, …)
    (select auth.uid()) = submitter_id
    -- reviewers: the whole human-review queue, cross-location
    or (
      public.get_my_role() = 'reviewer'
      and writeoffs.status in ('submitted', 'in_review', 'on_hold', 'dual_control')
    )
    -- admins: everything
    or public.get_my_role() = 'admin'
  );

-- ── 2. writeoffs UPDATE — reviewer + admin act on any review-status row ───────
drop policy if exists "writeoffs_update" on public.writeoffs;

-- reviewer → any row in a human-review queue (cross-location / cross-cluster)
-- admin    → any row
-- employee → only their own draft
create policy "writeoffs_update"
  on public.writeoffs for update
  using (
    -- employee: their own draft only
    ((select auth.uid()) = submitter_id and status = 'draft')
    -- reviewer: the whole human-review queue, cross-location
    or (
      public.get_my_role() = 'reviewer'
      and status in ('submitted', 'in_review', 'on_hold', 'dual_control')
    )
    -- admin: everything
    or public.get_my_role() = 'admin'
  )
  with check (
    -- employee: still their own draft
    ((select auth.uid()) = submitter_id and status = 'draft')
    -- reviewer / admin: any resulting status. A legal decision transition
    -- lands the row in approved / rejected / on_hold; the with-check must NOT
    -- block that move, so reviewer/admin are unconstrained on the new state.
    or public.get_my_role() in ('reviewer', 'admin')
  );

alter table public.writeoffs enable row level security;

comment on policy "writeoffs_select" on public.writeoffs is
  'Reviewer + admin see every write-off in the human-review queue (submitted, in_review, on_hold, dual_control) regardless of location/cluster; employees see only their own submissions.';

comment on policy "writeoffs_update" on public.writeoffs is
  'Reviewer + admin may update any write-off in the human-review queue (submitted, in_review, on_hold, dual_control) regardless of location/cluster; employees only their own draft. The geofence guard is a UI confirm + audit note (approved_despite_geofence), not an access block.';
