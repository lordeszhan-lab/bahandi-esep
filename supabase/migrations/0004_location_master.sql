-- ============================================================
-- Bahandi esep — location master (Prompt A)
-- Promotes `stores` to the single canonical location table for the
-- whole app, adds a `cities` dimension + `store_format` enum, enriches
-- it with real coordinates + a format-aware geofence radius, repoints
-- every `locations` FK to `stores`, and retires the demo `locations`
-- table. Idempotent: safe to re-run on a partially-migrated DB.
--
-- The 87 real stores + their coords are populated by:
--   npm run import:stores   (data/stores.csv → parse format/city/display_name)
--   npm run geocode:stores  (2GIS → lat/lng + format-aware radius)
-- This migration only lays down the schema, RLS, the demo→real remap,
-- the FK repoint, and the `locations` drop.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. store_format enum
-- ──────────────────────────────────────────────────────────────

do $$ begin
  create type public.store_format as enum ('kiosk','mall','magnum','market','street');
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────
-- 2. stores — canonical location table
--    Created from the CSV export if absent, else extended in place.
-- ──────────────────────────────────────────────────────────────

create table if not exists public.stores (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  address     text,
  city        text,
  created_at  timestamptz not null default now()
);

alter table public.stores
  add column if not exists display_name      text,
  add column if not exists format            store_format,
  add column if not exists city_id           uuid,
  add column if not exists lat               double precision,
  add column if not exists lng               double precision,
  add column if not exists geofence_radius_m int,
  add column if not exists iiko_store_id     text,
  add column if not exists is_active         boolean default true;

-- ──────────────────────────────────────────────────────────────
-- 3. cities dimension (normalized city for rollups + cascade)
-- ──────────────────────────────────────────────────────────────

create table if not exists public.cities (
  id      uuid        primary key default gen_random_uuid(),
  name    text        not null unique,
  region  text
);

-- stores.city_id → cities(id). Named so the generated types carry it.
do $$ begin
  alter table public.stores
    add constraint stores_city_id_fkey
    foreign key (city_id) references public.cities(id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists stores_city_id_idx on public.stores (city_id);
create index if not exists stores_format_idx   on public.stores (format);
create index if not exists stores_active_idx   on public.stores (is_active) where is_active = true;

-- ──────────────────────────────────────────────────────────────
-- 4. RLS — stores + cities
--    Authenticated users SELECT active stores (admin sees all);
--    only admin may INSERT/UPDATE/DELETE.
-- ──────────────────────────────────────────────────────────────

alter table public.stores enable row level security;
alter table public.cities enable row level security;

drop policy if exists "stores_select" on public.stores;
create policy "stores_select"
  on public.stores for select
  using (
    (select auth.role()) = 'authenticated'
    and (is_active or public.get_my_role() = 'admin')
  );

drop policy if exists "stores_insert_admin" on public.stores;
create policy "stores_insert_admin"
  on public.stores for insert
  with check (public.get_my_role() = 'admin');

drop policy if exists "stores_update_admin" on public.stores;
create policy "stores_update_admin"
  on public.stores for update
  using (public.get_my_role() = 'admin')
  with check (public.get_my_role() = 'admin');

drop policy if exists "stores_delete_admin" on public.stores;
create policy "stores_delete_admin"
  on public.stores for delete
  using (public.get_my_role() = 'admin');

-- cities: authenticated read; admin write (mirrors stores).
drop policy if exists "cities_select" on public.cities;
create policy "cities_select"
  on public.cities for select
  using ((select auth.role()) = 'authenticated');

drop policy if exists "cities_insert_admin" on public.cities;
create policy "cities_insert_admin"
  on public.cities for insert
  with check (public.get_my_role() = 'admin');

drop policy if exists "cities_update_admin" on public.cities;
create policy "cities_update_admin"
  on public.cities for update
  using (public.get_my_role() = 'admin')
  with check (public.get_my_role() = 'admin');

drop policy if exists "cities_delete_admin" on public.cities;
create policy "cities_delete_admin"
  on public.cities for delete
  using (public.get_my_role() = 'admin');

-- ──────────────────────────────────────────────────────────────
-- 5. Repoint locations → stores
--    The 3 demo `locations` rows (fixed 11111111-… ids seeded for the
--    hackathon) are mapped to 3 REAL store ids from data/stores.csv
--    first, so every referencing row (writeoffs / profiles / employees)
--    points at a store that exists before the FK is re-added. The import
--    script upserts the full row for these 3 (on conflict update).
--
--    demo  …0002 (Астана, cook)   → Bahandi Астана Молл (Астана)
--    demo  …0001 (Алматы, cook2)  → Bahandi АДК         (Алматы)
--    demo  …0003 (3rd demo)       → Bahandi Север       (Шымкент)
-- ──────────────────────────────────────────────────────────────

insert into public.stores (id, name, city) values
  ('091e5399-3e59-4d8d-87be-0371f70033a3', 'Bahandi Астана Молл', 'Астана'),
  ('0520b820-cdfb-4db0-9c16-8be18635142d', 'Bahandi АДК',         'Алматы'),
  ('126d308d-20a1-437e-8560-7c3aee4ce29c', 'Bahandi Север',       'Шымкент')
on conflict (id) do nothing;

-- Drop the old locations FKs FIRST so the remap UPDATEs below aren't rejected
-- (the new store ids don't exist in `locations`). No-op if already dropped.
alter table public.writeoffs drop constraint if exists writeoffs_location_id_fkey;
alter table public.profiles  drop constraint if exists profiles_location_id_fkey;
alter table public.employees drop constraint if exists employees_location_id_fkey;

-- Remap any rows still pointing at the demo location ids. No-ops if the demo
-- ids never existed (e.g. a fresh DB), so this is safe to re-run.
update public.writeoffs set location_id = '091e5399-3e59-4d8d-87be-0371f70033a3'
  where location_id = '11111111-0000-0000-0000-000000000002';
update public.writeoffs set location_id = '0520b820-cdfb-4db0-9c16-8be18635142d'
  where location_id = '11111111-0000-0000-0000-000000000001';
update public.writeoffs set location_id = '126d308d-20a1-437e-8560-7c3aee4ce29c'
  where location_id = '11111111-0000-0000-0000-000000000003';

update public.profiles set location_id = '091e5399-3e59-4d8d-87be-0371f70033a3'
  where location_id = '11111111-0000-0000-0000-000000000002';
update public.profiles set location_id = '0520b820-cdfb-4db0-9c16-8be18635142d'
  where location_id = '11111111-0000-0000-0000-000000000001';
update public.profiles set location_id = '126d308d-20a1-437e-8560-7c3aee4ce29c'
  where location_id = '11111111-0000-0000-0000-000000000003';

update public.employees set location_id = '091e5399-3e59-4d8d-87be-0371f70033a3'
  where location_id = '11111111-0000-0000-0000-000000000002';
update public.employees set location_id = '0520b820-cdfb-4db0-9c16-8be18635142d'
  where location_id = '11111111-0000-0000-0000-000000000001';
update public.employees set location_id = '126d308d-20a1-437e-8560-7c3aee4ce29c'
  where location_id = '11111111-0000-0000-0000-000000000003';

-- Re-add the FKs referencing stores(id). Wrapped in exception blocks so
-- re-running the migration is a no-op once they're in place.
-- writeoffs.location_id is NOT NULL → on delete restrict (matches 0001).
do $$ begin
  alter table public.writeoffs
    add constraint writeoffs_location_id_fkey
    foreign key (location_id) references public.stores(id) on delete restrict;
exception when duplicate_object then null; end $$;

-- profiles / employees: location_id nullable → on delete set null (matches 0001).
do $$ begin
  alter table public.profiles
    add constraint profiles_location_id_fkey
    foreign key (location_id) references public.stores(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.employees
    add constraint employees_location_id_fkey
    foreign key (location_id) references public.stores(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ──────────────────────────────────────────────────────────────
-- 6. Retire the demo locations table
--    Nothing references it now (all FKs repointed above). No CASCADE —
--    a leftover reference would fail loudly instead of vanishing.
-- ──────────────────────────────────────────────────────────────

drop table if exists public.locations;
