/**
 * Iiko reconciliation dashboard loader (Prompt 17) — server-only.
 *
 * One round trip's worth of queries to build the reconciliation surface:
 *   • the recent `iiko_act_ledger` rows (with joined write-off / store / reason),
 *   • the orphaned acts — approved/auto-approved write-offs handed to Iiko
 *     (`iiko_sync_status='pending'`) that have no ledger row yet,
 *   • the KPI counts: synced / syncing / on-hold / failed / double-posts blocked
 *     / orphaned.
 *
 * RLS gates reads to reviewer/admin; the dashboard nav is admin-only. Not a
 * "use server" module — plain async functions for the Server Component.
 */

import { createClient } from "@/lib/supabase/server";
import { normalizeLedgerStatus, type LedgerStatus } from "@/lib/iiko/ledger-status";

export interface LedgerRowView {
  id: string;
  writeoffId: string;
  writeoffRef: string;
  writeoffStatus: string;
  status: LedgerStatus;
  attempts: number;
  iikoDocId: string | null;
  lastError: string | null;
  createdAt: string;
  idempotencyKey: string;
  storeName: string;
  storeCity: string | null;
  reasonLabel: string;
  qty: number;
  unit: string;
  valueCost: number | null;
}

export interface OrphanedView {
  writeoffId: string;
  writeoffRef: string;
  writeoffStatus: string;
  createdAt: string;
  storeName: string;
  storeCity: string | null;
  reasonLabel: string;
  qty: number;
  unit: string;
  valueCost: number | null;
}

export interface IikoDashboardKpis {
  synced: number;
  syncing: number;
  onHold: number;
  failed: number;
  duplicatesBlocked: number;
  orphaned: number;
}

export interface IikoDashboardData {
  rows: LedgerRowView[];
  orphaned: OrphanedView[];
  kpis: IikoDashboardKpis;
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
  if (typeof v === "string" && v.length > 0) return v;
  return null;
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

// ── Loader ────────────────────────────────────────────────────────────────────

const LEDGER_SELECT = `
  id,
  status,
  attempts,
  iiko_doc_id,
  last_error,
  created_at,
  idempotency_key,
  writeoff_id,
  writeoff:writeoffs (
    id,
    status,
    qty,
    unit,
    value_cost,
    reason_code:reason_codes (
      label_ru
    ),
    store:stores (
      name,
      display_name,
      city
    )
  )
`.replace(/\s+/g, " ");

const ORPHAN_SELECT = `
  id,
  status,
  created_at,
  qty,
  unit,
  value_cost,
  reason_code:reason_codes (
    label_ru
  ),
  store:stores (
    name,
    display_name,
    city
  )
`.replace(/\s+/g, " ");

/**
 * Build the reconciliation dashboard payload. Returns `null` when the caller
 * isn't reviewer/admin (RLS would return nothing — fail fast with a clear null).
 */
export async function loadIikoDashboard(
  limit = 100,
): Promise<IikoDashboardData | null> {
  const supabase = await createClient();

  // ── Recent ledger rows + the orphan candidates in parallel ───────────────────
  const [ledgerRes, candidateRes] = await Promise.all([
    supabase
      .from("iiko_act_ledger")
      .select(LEDGER_SELECT)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("writeoffs")
      .select(ORPHAN_SELECT)
      .in("status", ["approved", "auto_approved"])
      .eq("iiko_sync_status", "pending")
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  if (ledgerRes.error) {
    console.error("[iiko-dashboard] ledger load failed:", ledgerRes.error.message);
  }

  const rows: LedgerRowView[] = [];
  const ledgerWriteoffIds = new Set<string>();
  const kpis: IikoDashboardKpis = {
    synced: 0,
    syncing: 0,
    onHold: 0,
    failed: 0,
    duplicatesBlocked: 0,
    orphaned: 0,
  };

  for (const raw of (ledgerRes.data ?? []) as unknown[]) {
    const r = raw as Record<string, unknown>;
    const writeoff = (r.writeoff as Record<string, unknown> | null) ?? null;
    const reasonCode = (writeoff?.reason_code as Record<string, unknown> | null) ?? null;
    const store = (writeoff?.store as Record<string, unknown> | null) ?? null;
    const status = normalizeLedgerStatus(toStr(r.status, "pending"));

    const writeoffId = toStr(r.writeoff_id) || toStr(writeoff?.id);
    if (writeoffId) ledgerWriteoffIds.add(writeoffId);

    switch (status) {
      case "synced":
        kpis.synced += 1;
        break;
      case "syncing":
      case "pending":
        kpis.syncing += 1;
        break;
      case "on_hold":
        kpis.onHold += 1;
        break;
      case "failed":
        kpis.failed += 1;
        break;
      case "duplicate_blocked":
        kpis.duplicatesBlocked += 1;
        break;
    }

    rows.push({
      id: toStr(r.id),
      writeoffId,
      writeoffRef: writeoffId.slice(0, 8),
      writeoffStatus: toStr(writeoff?.status),
      status,
      attempts: toNum(r.attempts),
      iikoDocId: toNullableStr(r.iiko_doc_id),
      lastError: toNullableStr(r.last_error),
      createdAt: toStr(r.created_at),
      idempotencyKey: toStr(r.idempotency_key),
      storeName: toStr(store?.display_name ?? store?.name, "—"),
      storeCity: toNullableStr(store?.city),
      reasonLabel: toStr(reasonCode?.label_ru, "Списание"),
      qty: toNum(writeoff?.qty),
      unit: toStr(writeoff?.unit),
      valueCost: toNullableNum(writeoff?.value_cost),
    });
  }

  // ── Orphaned acts: approved+pending write-offs with NO ledger row ───────────
  const orphaned: OrphanedView[] = [];
  for (const raw of (candidateRes.data ?? []) as unknown[]) {
    const r = raw as Record<string, unknown>;
    const id = toStr(r.id);
    if (!id || ledgerWriteoffIds.has(id)) continue; // has a ledger row → not orphaned
    const reasonCode = (r.reason_code as Record<string, unknown> | null) ?? null;
    const store = (r.store as Record<string, unknown> | null) ?? null;
    orphaned.push({
      writeoffId: id,
      writeoffRef: id.slice(0, 8),
      writeoffStatus: toStr(r.status),
      createdAt: toStr(r.created_at),
      storeName: toStr(store?.display_name ?? store?.name, "—"),
      storeCity: toNullableStr(store?.city),
      reasonLabel: toStr(reasonCode?.label_ru, "Списание"),
      qty: toNum(r.qty),
      unit: toStr(r.unit),
      valueCost: toNullableNum(r.value_cost),
    });
  }
  kpis.orphaned = orphaned.length;

  return { rows, orphaned, kpis };
}
