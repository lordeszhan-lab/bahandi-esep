"use server";

/**
 * Iiko act sync — the write-side of the reconciliation ledger (Prompts 16 & 17).
 *
 * Posts an approved write-off's Акт списания to iiko through the license-safe
 * resto-API client (`lib/iiko/client.ts`), recording every attempt on the
 * `iiko_act_ledger` row keyed by a deterministic `idempotency_key`. The ledger
 * is the single source of truth the reconciliation dashboard (Prompt 17) reads;
 * these actions are its write-side.
 *
 * Canonical ledger statuses (the `status` column is free text — no check constraint):
 *   pending            — row created, not yet posted (transient)
 *   syncing            — post in flight
 *   synced             — success, `iiko_doc_id` set (legacy seed rows use "success")
 *   failed             — error, `last_error` set, retryable
 *   on_hold            — blocked: missing store GUID / nomenclature mapping; retryable
 *                        once the mapping is fixed
 *   duplicate_blocked  — a double-post attempt that the idempotency guard prevented
 *
 * The idempotency_key is deterministic per write-off, so a retry reuses the SAME
 * ledger row + SAME key → iiko de-duplicates (sandbox returns the same doc id;
 * live honours X-Idempotency-Key). A second sync attempted on an already-synced
 * write-off is recorded as `duplicate_blocked` — never re-posted.
 */

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/service";
import { getCurrentProfile } from "@/lib/auth";
import { postWriteOff, IikoError } from "@/lib/iiko/client";
import { normalizeLedgerStatus, type LedgerStatus } from "@/lib/iiko/ledger-status";
import type { Json } from "@/lib/db/types";

// ── Result types ──────────────────────────────────────────────────────────────

export interface SyncActionResult {
  ok: boolean;
  status?: LedgerStatus;
  iikoDocId?: string;
  error?: string;
}

// Re-export the status model so existing imports from this module keep working
// (type-only — erased, safe in a "use server" file).
export type { LedgerStatus } from "@/lib/iiko/ledger-status";

// ── Admin guard ───────────────────────────────────────────────────────────────

async function requireAdmin(): Promise<boolean> {
  const profile = await getCurrentProfile();
  return profile?.role === "admin";
}

// ── Payload builder ───────────────────────────────────────────────────────────

interface SyncInput {
  document: Record<string, unknown>;
  reasonLabel: string;
  storeName: string;
}

interface LoadedWriteoff {
  id: string;
  status: string;
  qty: number;
  unit: string;
  value_cost: number | null;
  created_at: string;
  reason_code_id: string;
  location_id: string;
}

/**
 * Load a write-off + its reason label + store GUIDs + nomenclature mapping, and
 * build the iiko document. Returns `{ onHoldReason }` when the payload can't be
 * built (missing store GUID or mapping) — the caller parks the ledger as
 * `on_hold` rather than posting garbage.
 */
async function loadSyncInput(
  service: ReturnType<typeof createServiceClient>,
  writeoffId: string,
): Promise<{ input?: SyncInput; onHoldReason?: string }> {
  const { data: raw, error } = await service
    .from("writeoffs")
    .select(
      "id, status, qty, unit, value_cost, created_at, reason_code_id, location_id",
    )
    .eq("id", writeoffId)
    .maybeSingle();
  if (error || !raw) {
    return { onHoldReason: "акт не найден" };
  }
  const w = raw as LoadedWriteoff;

  // Reason label + store + mapping in parallel.
  const [reasonRes, storeRes, mappingRes] = await Promise.all([
    service
      .from("reason_codes")
      .select("label_ru")
      .eq("id", w.reason_code_id)
      .maybeSingle(),
    service
      .from("stores")
      .select("id, name, display_name, iiko_store_id, iiko_account_id")
      .eq("id", w.location_id)
      .maybeSingle(),
    service
      .from("iiko_nomenclature_map")
      .select("iiko_product_id, iiko_unit, iiko_account_id, product_label")
      .eq("reason_code_id", w.reason_code_id)
      .limit(1)
      .maybeSingle(),
  ]);

  const reasonLabel =
    (reasonRes.data as { label_ru: string } | null)?.label_ru ?? "Списание";
  const store = storeRes.data as {
    name: string;
    display_name: string | null;
    iiko_store_id: string | null;
    iiko_account_id: string | null;
  } | null;
  const mapping = mappingRes.data as {
    iiko_product_id: string;
    iiko_unit: string;
    iiko_account_id: string | null;
    product_label: string;
  } | null;

  if (!store?.iiko_store_id) {
    return {
      onHoldReason: `нет iiko_store_id для точки «${store?.display_name ?? store?.name ?? w.location_id.slice(0, 8)}»`,
    };
  }
  if (!mapping) {
    return {
      onHoldReason: `нет маппинга номенклатуры для reason_code «${reasonLabel}»`,
    };
  }

  const document = {
    type: "writeOffDocument",
    store: store.iiko_store_id,
    account: store.iiko_account_id ?? mapping.iiko_account_id,
    product: mapping.iiko_product_id,
    productLabel: mapping.product_label,
    qty: w.qty,
    unit: mapping.iiko_unit ?? w.unit,
    reason: reasonLabel,
    valueCost: w.value_cost,
    date: w.created_at,
    writeoffId: w.id,
  };

  return {
    input: {
      document,
      reasonLabel,
      storeName: store.display_name ?? store.name,
    },
  };
}

/** Deterministic idempotency key per write-off — stable across retries. */
function idempotencyKeyFor(writeoffId: string): string {
  return `bahandi:${writeoffId}`;
}

// ── Core post + ledger update ─────────────────────────────────────────────────

/**
 * Post the document for one ledger row and update the row + the write-off's
 * `iiko_sync_status`. Reuses the row's existing `idempotency_key` so retries are
 * idempotent. Sets `syncing` → `synced` (with iiko_doc_id) or `failed` (with
 * last_error). Returns the outcome.
 */
async function postAndUpdate(
  service: ReturnType<typeof createServiceClient>,
  ledgerId: string,
  idempotencyKey: string,
  input: SyncInput,
): Promise<SyncActionResult> {
  // ── Mark in-flight + bump attempts ───────────────────────────────────────────
  const { error: flightErr } = await service
    .from("iiko_act_ledger")
    .update({
      status: "syncing",
      attempts: await nextAttempts(service, ledgerId),
      last_error: null,
    } as unknown as never)
    .eq("id", ledgerId);
  if (flightErr) {
    return { ok: false, error: `ledger update failed: ${flightErr.message}` };
  }

  try {
    const result = await postWriteOff({
      document: input.document,
      idempotencyKey,
    });
    // ── Success → synced + iiko_doc_id ─────────────────────────────────────────
    const { error: updErr } = await service
      .from("iiko_act_ledger")
      .update({
        status: "synced",
        iiko_doc_id: result.iikoDocId,
        response: result.raw as unknown as Json,
        last_error: null,
      } as unknown as never)
      .eq("id", ledgerId);
    if (updErr) {
      return { ok: false, error: `ledger persist failed: ${updErr.message}` };
    }
    await setWriteoffSyncStatus(service, input, "synced");
    return { ok: true, status: "synced", iikoDocId: result.iikoDocId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "iiko post failed";
    const status = err instanceof IikoError ? err.status : 0;
    const { error: updErr } = await service
      .from("iiko_act_ledger")
      .update({
        status: "failed",
        last_error: status > 0 ? `[HTTP ${status}] ${message}` : message,
      } as unknown as never)
      .eq("id", ledgerId);
    if (updErr) {
      console.error("[iiko-sync] failed-state persist failed:", updErr.message);
    }
    await setWriteoffSyncStatus(service, input, "error");
    return { ok: true, status: "failed", error: message };
  }
}

/** Read current attempts and return attempts+1 (avoids a stale overwrite). */
async function nextAttempts(
  service: ReturnType<typeof createServiceClient>,
  ledgerId: string,
): Promise<number> {
  const { data } = await service
    .from("iiko_act_ledger")
    .select("attempts")
    .eq("id", ledgerId)
    .maybeSingle();
  const cur = (data as { attempts: number } | null)?.attempts ?? 0;
  return cur + 1;
}

/** Update the write-off's `iiko_sync_status` (synced / error). Best-effort. */
async function setWriteoffSyncStatus(
  service: ReturnType<typeof createServiceClient>,
  input: { document: Record<string, unknown> },
  status: "synced" | "error",
): Promise<void> {
  const writeoffId = input.document.writeoffId;
  if (typeof writeoffId !== "string") return;
  const { error } = await service
    .from("writeoffs")
    .update({ iiko_sync_status: status } as unknown as never)
    .eq("id", writeoffId);
  if (error) {
    console.error(`[iiko-sync] writeoff status update failed: ${error.message}`);
  }
}

/** Insert a `duplicate_blocked` ledger row recording a prevented double-post. */
async function recordDuplicateBlocked(
  service: ReturnType<typeof createServiceClient>,
  writeoffId: string,
  existingDocId: string | null,
): Promise<void> {
  const baseKey = idempotencyKeyFor(writeoffId);
  const { error } = await service.from("iiko_act_ledger").insert({
    writeoff_id: writeoffId,
    idempotency_key: `${baseKey}#dup-${Date.now()}`,
    status: "duplicate_blocked",
    request: { blocked: true, reason: "already_synced" } as unknown as Json,
    response: { blocked: true, existing_doc_id: existingDocId } as unknown as Json,
    attempts: 1,
  } as unknown as never);
  if (error) {
    console.error("[iiko-sync] duplicate_blocked insert failed:", error.message);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Retry one ledger row. Re-posts failed / on_hold / pending / syncing rows
 * (idempotent — same row, same key). An already-synced row is a double-post
 * attempt → recorded as `duplicate_blocked`, never re-posted.
 */
export async function retryIikoSyncAction(ledgerId: string): Promise<SyncActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Только администратор" };
  }
  const service = createServiceClient();

  const { data: raw, error } = await service
    .from("iiko_act_ledger")
    .select("id, writeoff_id, idempotency_key, status, iiko_doc_id")
    .eq("id", ledgerId)
    .maybeSingle();
  if (error || !raw) {
    return { ok: false, error: "Записьledger не найдена" };
  }
  const ledger = raw as {
    id: string;
    writeoff_id: string;
    idempotency_key: string;
    status: string;
    iiko_doc_id: string | null;
  };

  // Already synced → a repeat post is a duplicate; block + record it.
  const norm = normalizeLedgerStatus(ledger.status);
  if (norm === "synced" && ledger.iiko_doc_id) {
    await recordDuplicateBlocked(service, ledger.writeoff_id, ledger.iiko_doc_id);
    revalidatePath("/admin/iiko");
    return { ok: true, status: "duplicate_blocked" };
  }
  // A prior duplicate_blocked row isn't itself re-postable.
  if (norm === "duplicate_blocked") {
    return { ok: false, error: "Дубль нельзя повторить — исход уже синхронизирован" };
  }

  // Load the payload; park as on_hold when mapping/GUID is missing.
  const { input, onHoldReason } = await loadSyncInput(service, ledger.writeoff_id);
  if (!input) {
    const { error: updErr } = await service
      .from("iiko_act_ledger")
      .update({ status: "on_hold", last_error: onHoldReason ?? "нет маппинга" } as unknown as never)
      .eq("id", ledgerId);
    if (updErr) console.error("[iiko-sync] on_hold persist failed:", updErr.message);
    revalidatePath("/admin/iiko");
    return { ok: true, status: "on_hold", error: onHoldReason };
  }

  const res = await postAndUpdate(service, ledger.id, ledger.idempotency_key, input);
  revalidatePath("/admin/iiko");
  return res;
}

/**
 * Sync an orphaned act — an approved write-off with `iiko_sync_status='pending'`
 * and no ledger row. Creates the ledger row (deterministic idempotency key) then
 * posts. If a synced ledger already exists (race / re-click), records a
 * `duplicate_blocked` row instead of re-posting.
 */
export async function syncOrphanedAction(writeoffId: string): Promise<SyncActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Только администратор" };
  }
  const service = createServiceClient();

  // Existing ledger rows for this write-off?
  const { data: existing } = await service
    .from("iiko_act_ledger")
    .select("id, status, iiko_doc_id, idempotency_key")
    .eq("writeoff_id", writeoffId)
    .order("created_at", { ascending: false });
  const rows = (existing ?? []) as {
    id: string;
    status: string;
    iiko_doc_id: string | null;
    idempotency_key: string;
  }[];

  const synced = rows.find(
    (r) => normalizeLedgerStatus(r.status) === "synced" && r.iiko_doc_id,
  );
  if (synced) {
    await recordDuplicateBlocked(service, writeoffId, synced.iiko_doc_id);
    revalidatePath("/admin/iiko");
    return { ok: true, status: "duplicate_blocked" };
  }

  // A retryable row exists (failed / on_hold / pending / syncing) → re-post it.
  const retryable = rows.find((r) => {
    const s = normalizeLedgerStatus(r.status);
    return s === "failed" || s === "on_hold" || s === "pending" || s === "syncing";
  });

  const idempotencyKey = idempotencyKeyFor(writeoffId);

  if (retryable) {
    const { input, onHoldReason } = await loadSyncInput(service, writeoffId);
    if (!input) {
      const { error: updErr } = await service
        .from("iiko_act_ledger")
        .update({ status: "on_hold", last_error: onHoldReason ?? "нет маппинга" } as unknown as never)
        .eq("id", retryable.id);
      if (updErr) console.error("[iiko-sync] on_hold persist failed:", updErr.message);
      revalidatePath("/admin/iiko");
      return { ok: true, status: "on_hold", error: onHoldReason };
    }
    const res = await postAndUpdate(service, retryable.id, retryable.idempotency_key ?? idempotencyKey, input);
    revalidatePath("/admin/iiko");
    return res;
  }

  // No ledger row at all → create one, then post.
  const { input, onHoldReason } = await loadSyncInput(service, writeoffId);
  const { data: inserted, error: insErr } = await service
    .from("iiko_act_ledger")
    .insert({
      writeoff_id: writeoffId,
      idempotency_key: idempotencyKey,
      status: input ? "pending" : "on_hold",
      last_error: input ? null : (onHoldReason ?? "нет маппинга"),
      request: { orphaned_sync: true } as unknown as Json,
    } as unknown as never)
    .select("id")
    .single();
  if (insErr || !inserted) {
    return { ok: false, error: `ledger create failed: ${insErr?.message ?? "no row"}` };
  }
  const ledgerId = (inserted as { id: string }).id;

  if (!input) {
    revalidatePath("/admin/iiko");
    return { ok: true, status: "on_hold", error: onHoldReason };
  }

  const res = await postAndUpdate(service, ledgerId, idempotencyKey, input);
  revalidatePath("/admin/iiko");
  return res;
}
