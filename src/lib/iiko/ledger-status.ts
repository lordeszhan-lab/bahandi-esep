/**
 * Ledger status model (Prompt 17) — shared by the sync actions and the loader.
 *
 * Kept OUT of the `"use server"` action file so it can be imported by the
 * read-side loader and referenced as a plain (sync) helper. A `"use server"`
 * module may only export async functions, so the canonical status set + the
 * normalizer live here.
 */

export type LedgerStatus =
  | "pending"
  | "syncing"
  | "synced"
  | "failed"
  | "on_hold"
  | "duplicate_blocked";

/** Seed rows (Prompt C) wrote `status='success'`; treat it as synced on read. */
export function normalizeLedgerStatus(s: string): LedgerStatus {
  if (s === "success") return "synced";
  if (
    s === "pending" ||
    s === "syncing" ||
    s === "synced" ||
    s === "failed" ||
    s === "on_hold" ||
    s === "duplicate_blocked"
  ) {
    return s as LedgerStatus;
  }
  return "pending";
}
