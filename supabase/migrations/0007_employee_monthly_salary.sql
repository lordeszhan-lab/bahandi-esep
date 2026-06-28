-- ============================================================
-- 0007 — employee monthly_salary
--
-- The deduction cap is statutorily 50% of the charged employee's
-- monthly wages (Art. 115 ТК РК), not a flat 50 000 ₸. To compute
-- that cap we need each employee's monthly salary on record.
--
-- Nullable + defaults to NULL: legacy rows keep working; the
-- deduction logic falls back to a configurable default salary and
-- flags the case when the real wage is unknown.
-- ============================================================

alter table public.employees
  add column if not exists monthly_salary numeric(12,2) check (monthly_salary is null or monthly_salary > 0);

comment on column public.employees.monthly_salary is
  'Monthly wage in KZT — the basis for the Art. 115 ТК РК deduction cap (50% of salary). Nullable; deduction logic falls back to a default when unknown.';
