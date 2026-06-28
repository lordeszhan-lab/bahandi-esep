-- ============================================================
-- Bahandi esep — org hierarchy + onboarding + per-format baselines (Prompt B)
-- Applied: 2026-06-28
--
-- Turns the flat 87-store list into an operable org:
--   City → Cluster → Store, with reviewers owning clusters;
--   per-store iiko account (so 87 stores map to Iiko in bulk, not 3);
--   per-format risk baselines (cold-start reference — no history needed).
--
-- Idempotent: safe to re-run on a partially-migrated DB. Cluster + baseline
-- *data* is seeded by scripts (seed-clusters.ts / seed-baselines.ts), which
-- run after import:stores — the migration only lays down schema + RLS.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. store_clusters — City → Cluster → Store grouping
--    One cluster normally owns a slice of a city's stores; Almaty (48) is
--    split into 3 with round-robin so no single area manager rubber-stamps
--    the whole city. reviewers own clusters via reviewer_clusters.
-- ──────────────────────────────────────────────────────────────

create table if not exists public.store_clusters (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  city_id     uuid        references public.cities(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists store_clusters_city_id_idx on public.store_clusters (city_id);

-- stores.cluster_id → store_clusters(id). Nullable: a store can be unassigned.
alter table public.stores add column if not exists cluster_id uuid;

do $$ begin
  alter table public.stores
    add constraint stores_cluster_id_fkey
    foreign key (cluster_id) references public.store_clusters(id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists stores_cluster_id_idx on public.stores (cluster_id);

-- ──────────────────────────────────────────────────────────────
-- 2. reviewer_clusters — which reviewer owns which cluster
--    The unit of review ownership is the CLUSTER, not the store, so an area
--    manager's scope is a sane slice (e.g. 16 of Almaty's 48), never the whole
--    city. Many-to-many: a cluster can have several reviewers, a reviewer can
--    own several clusters.
-- ──────────────────────────────────────────────────────────────

create table if not exists public.reviewer_clusters (
  reviewer_id uuid        not null references public.profiles(id) on delete cascade,
  cluster_id  uuid        not null references public.store_clusters(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (reviewer_id, cluster_id)
);

create index if not exists reviewer_clusters_reviewer_idx on public.reviewer_clusters (reviewer_id);
create index if not exists reviewer_clusters_cluster_idx  on public.reviewer_clusters (cluster_id);

-- ──────────────────────────────────────────────────────────────
-- 3. stores.iiko_account_id — per-store posting account
--    The bulk Iiko mapping (store_id,iiko_store_id,iiko_account_id) upserts
--    BOTH the store GUID and the posting account on the store row, so each of
--    the 87 stores carries everything the posting pipeline needs without a
--    per-product override. Nullable: unmapped stores stay null until mapped.
-- ──────────────────────────────────────────────────────────────

alter table public.stores add column if not exists iiko_account_id text;

-- ──────────────────────────────────────────────────────────────
-- 4. format_baselines — cold-start risk reference per store format
--    Until a store has its own history, its FORMAT baseline is the reference
--    the risk engine judges volume + reason mix against (Prompt B). Seeded by
--    scripts/seed-baselines.ts with documented assumptions per format.
-- ──────────────────────────────────────────────────────────────

create table if not exists public.format_baselines (
  format                      store_format primary key,
  expected_writeoffs_per_day  numeric      not null check (expected_writeoffs_per_day >= 0),
  expected_accidental_share   numeric      not null check (expected_accidental_share   between 0 and 1),
  expected_breakage_share     numeric      not null check (expected_breakage_share     between 0 and 1),
  expected_spoilage_share     numeric      not null check (expected_spoilage_share     between 0 and 1),
  high_value_threshold        numeric
);

-- ──────────────────────────────────────────────────────────────
-- 5. RLS
--    • store_clusters / format_baselines: authenticated read; admin write.
--    • reviewer_clusters: a reviewer reads their own assignments; admin reads
--      all + writes. (Reviewers never write assignments — admin onboards.)
-- ──────────────────────────────────────────────────────────────

alter table public.store_clusters     enable row level security;
alter table public.reviewer_clusters  enable row level security;
alter table public.format_baselines   enable row level security;

-- store_clusters
drop policy if exists "store_clusters_select" on public.store_clusters;
create policy "store_clusters_select"
  on public.store_clusters for select
  using ((select auth.role()) = 'authenticated');

drop policy if exists "store_clusters_insert_admin" on public.store_clusters;
create policy "store_clusters_insert_admin"
  on public.store_clusters for insert
  with check (public.get_my_role() = 'admin');

drop policy if exists "store_clusters_update_admin" on public.store_clusters;
create policy "store_clusters_update_admin"
  on public.store_clusters for update
  using (public.get_my_role() = 'admin')
  with check (public.get_my_role() = 'admin');

drop policy if exists "store_clusters_delete_admin" on public.store_clusters;
create policy "store_clusters_delete_admin"
  on public.store_clusters for delete
  using (public.get_my_role() = 'admin');

-- reviewer_clusters: reviewer sees own, admin sees all
drop policy if exists "reviewer_clusters_select" on public.reviewer_clusters;
create policy "reviewer_clusters_select"
  on public.reviewer_clusters for select
  using (
    reviewer_id = (select auth.uid())
    or public.get_my_role() = 'admin'
  );

drop policy if exists "reviewer_clusters_insert_admin" on public.reviewer_clusters;
create policy "reviewer_clusters_insert_admin"
  on public.reviewer_clusters for insert
  with check (public.get_my_role() = 'admin');

drop policy if exists "reviewer_clusters_delete_admin" on public.reviewer_clusters;
create policy "reviewer_clusters_delete_admin"
  on public.reviewer_clusters for delete
  using (public.get_my_role() = 'admin');

-- format_baselines
drop policy if exists "format_baselines_select" on public.format_baselines;
create policy "format_baselines_select"
  on public.format_baselines for select
  using ((select auth.role()) = 'authenticated');

drop policy if exists "format_baselines_insert_admin" on public.format_baselines;
create policy "format_baselines_insert_admin"
  on public.format_baselines for insert
  with check (public.get_my_role() = 'admin');

drop policy if exists "format_baselines_update_admin" on public.format_baselines;
create policy "format_baselines_update_admin"
  on public.format_baselines for update
  using (public.get_my_role() = 'admin')
  with check (public.get_my_role() = 'admin');

drop policy if exists "format_baselines_delete_admin" on public.format_baselines;
create policy "format_baselines_delete_admin"
  on public.format_baselines for delete
  using (public.get_my_role() = 'admin');

-- stores: admin already had update via 0004; the new columns inherit that
-- policy (stores_update_admin uses get_my_role() = 'admin', no column list),
-- so cluster_id + iiko_account_id are writable by admin with no extra policy.

comment on table public.store_clusters is
  'City → Cluster grouping of stores; reviewers own clusters via reviewer_clusters (Prompt B).';
comment on table public.reviewer_clusters is
  'Many-to-many: which reviewer owns which cluster. Reviewer reads own; admin writes (Prompt B).';
comment on table public.format_baselines is
  'Cold-start risk baseline per store_format — the reference until a store has its own history (Prompt B).';
