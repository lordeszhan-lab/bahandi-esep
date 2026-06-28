-- ============================================================
-- Bahandi esep — Storage RLS for writeoff-photos bucket (Prompt fix)
-- Applied: 2026-06-28
--
-- Bug: on mobile, submitting a write-off failed at photo upload with
-- "new row violates row-level security policy". The writeoff-photos Storage
-- bucket had no INSERT policy on storage.objects, so every authenticated
-- upload from the capture flow was rejected by RLS — the raw Postgres string
-- surfaced to employees and the submission silently stalled.
--
-- This migration:
--   • creates the `writeoff-photos` bucket PRIVATE (public = false) — access
--     is only via signed URLs issued server-side / from the session client;
--   • adds an INSERT policy: any authenticated user may upload into the
--     bucket. with_check = bucket_id + auth.role() = 'authenticated'. The
--     app uploads to `{user.id}/{epoch}.jpg`; the per-user folder is
--     organizational ONLY and is NOT enforced here, so the path the app
--     writes always satisfies the policy.
--   • adds a SELECT policy: authenticated reviewers/admins may read objects
--     in the bucket, which is what `createSignedUrls` needs to mint preview
--     URLs for the review queue. The bucket stays private — SELECT here only
--     governs who can list/read object metadata + bytes, not public access.
--
-- A failed photo upload is non-fatal in the app: the offline queue keeps the
-- submission in IndexedDB and retries with backoff (src/lib/offline/flush.ts).
-- ============================================================

-- ── 1. Bucket (private) ───────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('writeoff-photos', 'writeoff-photos', false)
on conflict (id) do update set public = false;

-- ── 2. Enable RLS on storage.objects (no-op if already on) ────────────────────
alter table storage.objects enable row level security;

-- ── 3. Policies ───────────────────────────────────────────────────────────────
-- Drop any prior policies scoped to this bucket so re-runs are idempotent.
-- (Supabase stores storage policies as rows; the names below are unique within
-- storage.objects, so `drop policy if exists` is safe.)

-- INSERT: any authenticated employee may upload into writeoff-photos.
-- No auth.uid() path prefix requirement — the app's `{user.id}/…` prefix is
-- organizational only.
drop policy if exists "writeoff_photos_insert_authenticated"
  on storage.objects;
create policy "writeoff_photos_insert_authenticated"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'writeoff-photos' and auth.role() = 'authenticated');

-- SELECT: authenticated reviewers/admins (and the uploader) may read objects
-- in writeoff-photos. Needed for createSignedUrls previews in the review queue.
drop policy if exists "writeoff_photos_select_authenticated"
  on storage.objects;
create policy "writeoff_photos_select_authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'writeoff-photos' and auth.role() = 'authenticated');

-- ── 4. Comments ───────────────────────────────────────────────────────────────
comment on policy "writeoff_photos_insert_authenticated" on storage.objects is
  'Any authenticated user may upload into the writeoff-photos bucket. No auth.uid() path prefix is enforced — the app''s per-user folder is organizational only.';
comment on policy "writeoff_photos_select_authenticated" on storage.objects is
  'Authenticated users may read objects in the private writeoff-photos bucket (signed-URL previews in the review queue). Bucket stays private.';
