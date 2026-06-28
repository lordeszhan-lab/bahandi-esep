-- ============================================================
-- Bahandi esep — reviewer queue RLS fix (Prompt 12.1)
-- Applied: 2026-06-27
--
-- Symptom: /review rendered an empty queue for reviewers even though
-- write-offs existed in in_review / on_hold / dual_control. The old
-- writeoffs_select policy scoped reviewers to rows in their assigned
-- location (p.location_id = writeoffs.location_id), so a reviewer whose
-- profile location didn't match a write-off's location saw nothing — and
-- the data loader compounded it with a manual location filter.
--
-- Fix: for the hackathon, drop the region/location scoping for reviewers.
-- A reviewer (and admin) can SELECT every write-off currently sitting in a
-- human-review queue, regardless of location. Employees stay restricted to
-- their own submissions (any status). This makes the review queue the
-- cross-location triage surface it needs to be.
-- ============================================================

-- ── 1. Replace the writeoffs SELECT policy ────────────────────────────────────

drop policy if exists "writeoffs_select" on public.writeoffs;

-- reviewer + admin → all rows in a human-review queue (any location)
-- employee (and anyone) → only their own submissions
create policy "writeoffs_select"
  on public.writeoffs for select
  using (
    -- own submission: any status (draft, submitted, approved, rejected, …)
    (select auth.uid()) = submitter_id
    -- reviewers: the whole human-review queue, cross-location
    or (
      public.get_my_role() = 'reviewer'
      and writeoffs.status in ('in_review', 'on_hold', 'dual_control')
    )
    -- admins: everything
    or public.get_my_role() = 'admin'
  );

-- RLS is already enabled on writeoffs (0001_init.sql); keep it on.
alter table public.writeoffs enable row level security;

comment on policy "writeoffs_select" on public.writeoffs is
  'Reviewer + admin see every write-off in the human-review queue (in_review, on_hold, dual_control) regardless of location; employees see only their own submissions.';
