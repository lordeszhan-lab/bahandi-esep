-- ============================================================
-- Bahandi esep — initial schema + RLS
-- Applied: 2026-06-27
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. TABLES (dependency order)
-- ──────────────────────────────────────────────────────────────

create table public.locations (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null,
  code                text        not null unique,
  lat                 double precision,
  lng                 double precision,
  geofence_radius_m   int         not null default 150,
  iiko_store_id       text,
  created_at          timestamptz not null default now()
);

create table public.employees (
  id                  uuid        primary key default gen_random_uuid(),
  full_name           text        not null,
  location_id         uuid        references public.locations(id) on delete set null,
  position            text,
  material_liability  bool        not null default false,
  created_at          timestamptz not null default now()
);

create table public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  full_name   text        not null,
  role        text        not null default 'employee'
                          check (role in ('employee','reviewer','admin')),
  location_id uuid        references public.locations(id) on delete set null,
  device_id   text,
  created_at  timestamptz not null default now()
);

create table public.reason_codes (
  id                uuid        primary key default gen_random_uuid(),
  key               text        not null unique,
  category          text        not null
                                check (category in ('yield','quality','accidental','spoilage','return','breakage')),
  label_ru          text        not null,
  label_kk          text        not null,
  deduction_default bool        not null default false,
  created_at        timestamptz not null default now()
);

create table public.writeoffs (
  id                  uuid        primary key default gen_random_uuid(),
  location_id         uuid        not null references public.locations(id)    on delete restrict,
  submitter_id        uuid        not null references auth.users(id)          on delete restrict,
  reason_code_id      uuid        not null references public.reason_codes(id) on delete restrict,
  qty                 numeric     not null check (qty > 0),
  unit                text        not null,
  comment             text,
  withholding         bool        not null default false,
  charged_employee_id uuid        references public.employees(id)             on delete set null,
  value_cost          numeric,
  status              text        not null default 'draft'
                                  check (status in ('draft','submitted','auto_approved','in_review','dual_control','on_hold','approved','rejected')),
  risk_score          int         not null default 0,
  iiko_sync_status    text        not null default 'none',
  created_at          timestamptz not null default now(),
  decided_by          uuid        references auth.users(id)                   on delete set null,
  decided_at          timestamptz
);

create table public.writeoff_photos (
  id             uuid        primary key default gen_random_uuid(),
  writeoff_id    uuid        not null references public.writeoffs(id)       on delete cascade,
  storage_path   text        not null,
  phash          text,
  exif           jsonb,
  gps_lat        double precision,
  gps_lng        double precision,
  captured_at    timestamptz,
  source         text        not null default 'camera',
  vision_result  jsonb,
  dup_of         uuid        references public.writeoff_photos(id)          on delete set null,
  created_at     timestamptz not null default now()
);

create table public.iiko_nomenclature_map (
  id               uuid    primary key default gen_random_uuid(),
  reason_code_id   uuid    references public.reason_codes(id) on delete set null,
  product_label    text    not null,
  iiko_product_id  text    not null,
  iiko_unit        text    not null,
  iiko_store_id    text    not null,
  iiko_account_id  text    not null,
  created_at       timestamptz not null default now()
);

create table public.risk_events (
  id           uuid    primary key default gen_random_uuid(),
  writeoff_id  uuid    not null references public.writeoffs(id) on delete cascade,
  feature      text    not null,
  weight       int     not null default 1,
  detail       jsonb,
  created_at   timestamptz not null default now()
);

create table public.audit_log (
  id           uuid    primary key default gen_random_uuid(),
  writeoff_id  uuid    references public.writeoffs(id) on delete set null,
  actor_id     uuid    references auth.users(id)       on delete set null,
  action       text    not null,
  prev_hash    text,
  hash         text    not null,
  payload      jsonb,
  created_at   timestamptz not null default now()
);

create table public.deductions (
  id               uuid    primary key default gen_random_uuid(),
  writeoff_id      uuid    not null references public.writeoffs(id)  on delete restrict,
  employee_id      uuid    not null references public.employees(id)  on delete restrict,
  amount           numeric not null check (amount > 0),
  basis            text    not null,
  cap_amount       numeric,
  status           text    not null default 'proposed'
                           check (status in ('proposed','acknowledged','disputed','approved','applied','cancelled')),
  acknowledged_at  timestamptz,
  dispute_reason   text,
  signature        text,
  created_at       timestamptz not null default now()
);

create table public.iiko_act_ledger (
  id               uuid    primary key default gen_random_uuid(),
  writeoff_id      uuid    not null references public.writeoffs(id) on delete restrict,
  idempotency_key  text    not null unique,
  iiko_doc_id      text,
  request          jsonb,
  response         jsonb,
  status           text    not null default 'pending',
  attempts         int     not null default 0,
  last_error       text,
  created_at       timestamptz not null default now()
);

-- ──────────────────────────────────────────────────────────────
-- 2. INDEXES  (FK + hot query columns)
-- ──────────────────────────────────────────────────────────────

create index on public.profiles (location_id);
create index on public.employees (location_id);
create index on public.writeoffs (location_id);
create index on public.writeoffs (submitter_id);
create index on public.writeoffs (status);
create index on public.writeoffs (created_at desc);
create index on public.writeoffs (reason_code_id);
create index on public.writeoffs (charged_employee_id);
create index on public.writeoffs (decided_by);
create index on public.writeoff_photos (writeoff_id);
create index on public.writeoff_photos (dup_of);
create index on public.iiko_nomenclature_map (reason_code_id);
create index on public.risk_events (writeoff_id);
create index on public.audit_log (writeoff_id);
create index on public.audit_log (actor_id);
create index on public.audit_log (created_at desc);
create index on public.deductions (writeoff_id);
create index on public.deductions (employee_id);
create index on public.iiko_act_ledger (writeoff_id);
create index on public.iiko_act_ledger (status);

-- ──────────────────────────────────────────────────────────────
-- 3. ROLE HELPER
--    security definer + empty search_path prevents schema injection.
--    No circular dep: profiles RLS uses auth.uid() directly.
-- ──────────────────────────────────────────────────────────────

create or replace function public.get_my_role()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (
    select p.role
    from   public.profiles p
    where  p.id = auth.uid()
  );
end;
$$;

-- Restrict to authenticated users only (anon must not call this)
revoke execute on function public.get_my_role() from anon;
revoke execute on function public.get_my_role() from public;
grant  execute on function public.get_my_role() to authenticated;

-- ──────────────────────────────────────────────────────────────
-- 4. ENABLE RLS
-- ──────────────────────────────────────────────────────────────

alter table public.profiles              enable row level security;
alter table public.locations             enable row level security;
alter table public.employees             enable row level security;
alter table public.reason_codes          enable row level security;
alter table public.writeoffs             enable row level security;
alter table public.writeoff_photos       enable row level security;
alter table public.iiko_nomenclature_map enable row level security;
alter table public.risk_events           enable row level security;
alter table public.audit_log             enable row level security;
alter table public.deductions            enable row level security;
alter table public.iiko_act_ledger       enable row level security;

-- ──────────────────────────────────────────────────────────────
-- 5. RLS POLICIES
--    • (select auth.uid()) avoids re-evaluation per row
--    • Write policies are INSERT/UPDATE/DELETE — NOT ALL —
--      to prevent overlapping SELECT cost
-- ──────────────────────────────────────────────────────────────

-- profiles: each user owns their own row
create policy "profiles_select_own"
  on public.profiles for select
  using ((select auth.uid()) = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check ((select auth.uid()) = id);

create policy "profiles_update_own"
  on public.profiles for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- locations: any authenticated user reads; admin writes
create policy "locations_read"
  on public.locations for select
  using ((select auth.role()) = 'authenticated');

create policy "locations_insert_admin"
  on public.locations for insert
  with check (public.get_my_role() = 'admin');

create policy "locations_update_admin"
  on public.locations for update
  using (public.get_my_role() = 'admin');

create policy "locations_delete_admin"
  on public.locations for delete
  using (public.get_my_role() = 'admin');

-- employees: any authenticated user reads; admin writes
create policy "employees_read"
  on public.employees for select
  using ((select auth.role()) = 'authenticated');

create policy "employees_insert_admin"
  on public.employees for insert
  with check (public.get_my_role() = 'admin');

create policy "employees_update_admin"
  on public.employees for update
  using (public.get_my_role() = 'admin');

create policy "employees_delete_admin"
  on public.employees for delete
  using (public.get_my_role() = 'admin');

-- reason_codes: any authenticated user reads; admin writes
create policy "reason_codes_read"
  on public.reason_codes for select
  using ((select auth.role()) = 'authenticated');

create policy "reason_codes_insert_admin"
  on public.reason_codes for insert
  with check (public.get_my_role() = 'admin');

create policy "reason_codes_update_admin"
  on public.reason_codes for update
  using (public.get_my_role() = 'admin');

create policy "reason_codes_delete_admin"
  on public.reason_codes for delete
  using (public.get_my_role() = 'admin');

-- writeoffs:
--   employee  → own submitted rows only
--   reviewer  → all rows in their assigned location
--   admin     → everything
create policy "writeoffs_select"
  on public.writeoffs for select
  using (
    (select auth.uid()) = submitter_id
    or (
      exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.role = 'reviewer'
          and p.location_id = writeoffs.location_id
      )
    )
    or public.get_my_role() = 'admin'
  );

create policy "writeoffs_insert_employee"
  on public.writeoffs for insert
  with check (
    (select auth.uid()) = submitter_id
    and location_id = (
      select p.location_id from public.profiles p
      where p.id = (select auth.uid())
    )
  );

create policy "writeoffs_update"
  on public.writeoffs for update
  using (
    ((select auth.uid()) = submitter_id and status = 'draft')
    or public.get_my_role() in ('reviewer','admin')
  );

-- writeoff_photos: mirrors parent writeoff visibility
create policy "writeoff_photos_select"
  on public.writeoff_photos for select
  using (
    exists (
      select 1 from public.writeoffs w
      where w.id = writeoff_id
        and (
          w.submitter_id = (select auth.uid())
          or public.get_my_role() in ('reviewer','admin')
        )
    )
  );

create policy "writeoff_photos_insert"
  on public.writeoff_photos for insert
  with check (
    exists (
      select 1 from public.writeoffs w
      where w.id = writeoff_id
        and w.submitter_id = (select auth.uid())
    )
  );

-- iiko_nomenclature_map: read by auth; write admin
create policy "iiko_nom_read"
  on public.iiko_nomenclature_map for select
  using ((select auth.role()) = 'authenticated');

create policy "iiko_nom_insert_admin"
  on public.iiko_nomenclature_map for insert
  with check (public.get_my_role() = 'admin');

create policy "iiko_nom_update_admin"
  on public.iiko_nomenclature_map for update
  using (public.get_my_role() = 'admin');

create policy "iiko_nom_delete_admin"
  on public.iiko_nomenclature_map for delete
  using (public.get_my_role() = 'admin');

-- risk_events: reviewer/admin only
create policy "risk_events_read"
  on public.risk_events for select
  using (public.get_my_role() in ('reviewer','admin'));

create policy "risk_events_insert"
  on public.risk_events for insert
  with check (public.get_my_role() in ('reviewer','admin'));

-- audit_log: reviewer/admin read; no direct user write (service role only)
create policy "audit_log_read"
  on public.audit_log for select
  using (public.get_my_role() in ('reviewer','admin'));

-- deductions:
--   employee  → rows where they are the charged employee
--   reviewer/admin → all
create policy "deductions_select"
  on public.deductions for select
  using (
    public.get_my_role() in ('reviewer','admin')
    or exists (
      select 1 from public.employees e
      join  public.profiles p on p.location_id = e.location_id
      where e.id = deductions.employee_id
        and p.id = (select auth.uid())
    )
  );

create policy "deductions_insert_reviewer_admin"
  on public.deductions for insert
  with check (public.get_my_role() in ('reviewer','admin'));

create policy "deductions_update_employee"
  on public.deductions for update
  using (
    public.get_my_role() in ('reviewer','admin')
    or exists (
      select 1 from public.employees e
      join  public.profiles p on p.location_id = e.location_id
      where e.id = deductions.employee_id
        and p.id = (select auth.uid())
        and deductions.status in ('proposed','acknowledged','disputed')
    )
  );

create policy "deductions_delete_admin"
  on public.deductions for delete
  using (public.get_my_role() = 'admin');

-- iiko_act_ledger: reviewer/admin read; admin write
create policy "iiko_act_ledger_read"
  on public.iiko_act_ledger for select
  using (public.get_my_role() in ('reviewer','admin'));

create policy "iiko_act_ledger_insert_admin"
  on public.iiko_act_ledger for insert
  with check (public.get_my_role() = 'admin');

create policy "iiko_act_ledger_update_admin"
  on public.iiko_act_ledger for update
  using (public.get_my_role() = 'admin');

create policy "iiko_act_ledger_delete_admin"
  on public.iiko_act_ledger for delete
  using (public.get_my_role() = 'admin');
