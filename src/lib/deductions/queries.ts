/**
 * Deduction view-model loaders (Prompt 18) — server-only.
 *
 * Not a "use server" module: these are plain async functions called from Server
 * Components to fetch the deduction lists with their joined employee / write-off /
 * reason / store context in one round trip. RLS does the scoping:
 *   • reviewer/admin → every deduction.
 *   • employee → only deductions for charged employees in their location.
 *
 * `numeric` columns arrive from PostgREST as numbers (occasionally strings for
 * high precision), so every numeric field is coerced before it reaches the UI.
 */

import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { computeCapAmount } from "@/lib/deductions/config";
import type { DeductionStatus } from "@/lib/db/types";

export interface DeductionView {
  id: string;
  status: DeductionStatus;
  amount: number;
  capAmount: number;
  /** True when the charge was truncated to the cap at creation time. */
  capped: boolean;
  basis: string;
  createdAt: string;
  acknowledgedAt: string | null;
  disputeReason: string | null;
  signature: string | null;
  employeeId: string;
  employeeName: string;
  writeoffId: string;
  writeoffRef: string;
  writeoffCreatedAt: string;
  qty: number;
  unit: string;
  valueCost: number | null;
  withholding: boolean;
  reasonLabel: string;
  reasonCategory: string;
  storeName: string;
  storeCity: string | null;
}

// ── coercion ──────────────────────────────────────────────────────────────────

function toNum(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function toStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function toNullableStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const SELECT = `
  id,
  status,
  amount,
  cap_amount,
  basis,
  created_at,
  acknowledged_at,
  dispute_reason,
  signature,
  employee_id,
  writeoff:writeoffs (
    id,
    created_at,
    qty,
    unit,
    value_cost,
    withholding,
    reason_code:reason_codes (
      label_ru,
      category
    ),
    store:stores (
      name,
      display_name,
      city
    ),
    charged_employee:employees!charged_employee_id (
      full_name
    )
  )
`.replace(/\s+/g, " ");

/** Shape the joined row into the flat `DeductionView` the UI renders. */
function shape(raw: unknown): DeductionView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const writeoff = (r.writeoff as Record<string, unknown> | null) ?? null;
  if (!writeoff) return null;
  const reasonCode = (writeoff.reason_code as Record<string, unknown> | null) ?? null;
  const store = (writeoff.store as Record<string, unknown> | null) ?? null;
  const chargedEmployee = (writeoff.charged_employee as Record<string, unknown> | null) ?? null;

  const amount = toNum(r.amount);
  const { capAmount: defaultCap } = computeCapAmount();
  const capAmount = toNum(r.cap_amount, defaultCap);
  const valueCost = toNullableNum(writeoff.value_cost);

  return {
    id: toStr(r.id),
    status: toStr(r.status) as DeductionStatus,
    amount,
    capAmount,
    capped: valueCost != null && amount < valueCost,
    basis: toStr(r.basis),
    createdAt: toStr(r.created_at),
    acknowledgedAt: toNullableStr(r.acknowledged_at),
    disputeReason: toNullableStr(r.dispute_reason),
    signature: toNullableStr(r.signature),
    employeeId: toStr(r.employee_id),
    employeeName: toStr(chargedEmployee?.full_name, "Сотрудник"),
    writeoffId: toStr(writeoff.id),
    writeoffRef: toStr(writeoff.id).slice(0, 8),
    writeoffCreatedAt: toStr(writeoff.created_at),
    qty: toNum(writeoff.qty),
    unit: toStr(writeoff.unit),
    valueCost,
    withholding: Boolean(writeoff.withholding),
    reasonLabel: toStr(reasonCode?.label_ru, "Списание"),
    reasonCategory: toStr(reasonCode?.category),
    storeName: toStr(store?.display_name ?? store?.name, "—"),
    storeCity: toNullableStr(store?.city),
  };
}

function toNullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ── Loaders ───────────────────────────────────────────────────────────────────

/**
 * All deductions for the reviewer/admin surface — every case across the network,
 * newest first. Returns `null` when the caller isn't reviewer/admin.
 */
export async function loadReviewerDeductions(): Promise<DeductionView[] | null> {
  const profile = await getCurrentProfile();
  if (!profile || (profile.role !== "reviewer" && profile.role !== "admin")) {
    return null;
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deductions")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[deductions] reviewer load failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown[])
    .map(shape)
    .filter((d): d is DeductionView => d !== null);
}

/**
 * The signed-in employee's own cases — deductions for charged employees in their
 * location (the `deductions_select` RLS policy). Returns `null` when the caller
 * isn't an employee or has no location.
 */
export async function loadEmployeeDeductions(): Promise<DeductionView[] | null> {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "employee" || !profile.location_id) {
    return null;
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deductions")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[deductions] employee load failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown[])
    .map(shape)
    .filter((d): d is DeductionView => d !== null);
}
