/**
 * Offline-first writeoff queue — Prompt 7.
 *
 * Persists pending submissions (photo Blob + form payload) in IndexedDB so
 * capture keeps working in a busy kitchen with bad wifi. Flush logic lives in
 * `flush.ts`; this module is the pure data layer (open DB, enqueue, read,
 * update, delete) plus the small burst-accounting helpers the flush layer uses
 * to flag end-of-shift batch bursts for the risk engine.
 */

import { openDB, type IDBPDatabase } from "idb";

// ── Types ─────────────────────────────────────────────────────────────────────

export type QueueStatus = "pending" | "syncing" | "synced" | "failed";

/**
 * One queued writeoff. The photo Blob is cloned into IDB by the structured
 * clone algorithm, so it survives reloads and powers a true offline-first
 * flush (upload + server action) on reconnect.
 */
export interface QueuedSubmission {
  /** Client-generated id (uuid) — stable across reloads. */
  id: string;
  createdAt: number;

  // ── Form payload (mirrors WriteoffPayload minus storagePath) ──
  reasonCodeId: string;
  qty: number;
  unit: string;
  comment: string | null;
  withholding: boolean;
  chargedEmployeeId: string | null;
  locationId: string;

  // ── Photo ──
  blob: Blob;
  capturedAt: string;
  gpsLat: number | null;
  gpsLng: number | null;

  // ── Sync state ──
  status: QueueStatus;
  /** True when this submission was part of an end-of-shift flush burst. */
  batchBurst: boolean;
  attempts: number;
  /** Epoch ms before which we should not retry (backoff). */
  nextAttemptAt: number | null;
  lastError: string | null;
  syncedAt: number | null;
  /** Set once the server action returns a writeoff id. */
  writeoffId: string | null;
  /** Storage path assigned during flush (after photo upload). */
  storagePath: string | null;
}

/** Fields the capture flow hands to `enqueue`. */
export interface EnqueueInput {
  reasonCodeId: string;
  qty: number;
  unit: string;
  comment: string | null;
  withholding: boolean;
  chargedEmployeeId: string | null;
  locationId: string;
  blob: Blob;
  capturedAt: string;
  gpsLat: number | null;
  gpsLng: number | null;
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────

const DB_NAME = "bahandi";
const DB_VERSION = 1;
const STORE_QUEUE = "writeoff_queue";
const STORE_META = "meta"; // small key/value table for burst accounting

let _dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("[queue] IndexedDB is only available in the browser"));
  }
  if (!_dbPromise) {
    _dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          const store = db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
          store.createIndex("by_status", "status");
          store.createIndex("by_created", "createdAt");
          store.createIndex("by_next_attempt", "nextAttemptAt");
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      },
    });
  }
  return _dbPromise;
}

// ── ID helper (crypto.randomUUID with a fallback) ─────────────────────────────

export function newQueueId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Persist a new submission as `pending`. Returns the stored record. */
export async function enqueue(input: EnqueueInput): Promise<QueuedSubmission> {
  const db = await getDB();
  const record: QueuedSubmission = {
    id: newQueueId(),
    createdAt: Date.now(),
    reasonCodeId: input.reasonCodeId,
    qty: input.qty,
    unit: input.unit,
    comment: input.comment,
    withholding: input.withholding,
    chargedEmployeeId: input.chargedEmployeeId,
    locationId: input.locationId,
    blob: input.blob,
    capturedAt: input.capturedAt,
    gpsLat: input.gpsLat,
    gpsLng: input.gpsLng,
    status: "pending",
    batchBurst: false,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    syncedAt: null,
    writeoffId: null,
    storagePath: null,
  };
  await db.put(STORE_QUEUE, record);
  return record;
}

/** All queued submissions, oldest first. */
export async function listAll(): Promise<QueuedSubmission[]> {
  const db = await getDB();
  const all = (await db.getAllFromIndex(STORE_QUEUE, "by_created")) as QueuedSubmission[];
  return all;
}

/** Fetch a single record by id (or undefined if it was pruned). */
export async function getById(id: string): Promise<QueuedSubmission | undefined> {
  const db = await getDB();
  return (await db.get(STORE_QUEUE, id)) as QueuedSubmission | undefined;
}

/**
 * Submissions due for a flush attempt: pending, or failed past their backoff
 * window. Excludes `syncing` (in progress) and `synced`.
 */
export async function listDue(): Promise<QueuedSubmission[]> {
  const all = await listAll();
  const now = Date.now();
  return all.filter(
    (r) =>
      r.status === "pending" ||
      (r.status === "failed" && (r.nextAttemptAt === null || r.nextAttemptAt <= now)),
  );
}

/** Count of submissions not yet synced (pending + syncing + failed). */
export async function pendingCount(): Promise<number> {
  const all = await listAll();
  return all.filter((r) => r.status !== "synced").length;
}

/** Patch a record by id with a partial update. */
export async function update(
  id: string,
  patch: Partial<QueuedSubmission>,
): Promise<void> {
  const db = await getDB();
  const existing = (await db.get(STORE_QUEUE, id)) as QueuedSubmission | undefined;
  if (!existing) return;
  await db.put(STORE_QUEUE, { ...existing, ...patch });
}

/** Remove a synced record (keeps the DB from growing unbounded). */
export async function remove(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_QUEUE, id);
}

/**
 * Delete synced records older than `olderThanMs` to keep IDB bounded. The photo
 * Blob is already released by the flush layer post-sync, so this just drops the
 * small metadata rows. Safe to call on every flush pass.
 */
export async function pruneSynced(olderThanMs: number): Promise<number> {
  const db = await getDB();
  const all = (await db.getAllFromIndex(STORE_QUEUE, "by_created")) as QueuedSubmission[];
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const r of all) {
    if (r.status === "synced" && (r.syncedAt ?? 0) < cutoff) {
      await db.delete(STORE_QUEUE, r.id);
      removed += 1;
    }
  }
  return removed;
}

/** Wipe the queue — used only by dev tooling. */
export async function clearAll(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_QUEUE);
  await db.clear(STORE_META);
}

// ── Burst accounting (helpers consumed by flush.ts) ────────────────────────────
// We keep a rolling log of recent flush timestamps in the meta store so the
// flush layer can detect "N submissions flushed within a short window".

const META_FLUSH_LOG = "flush_log";
const FLUSH_LOG_MAX = 32;

/** Append `at` to the rolling flush-timestamp log and return the log. */
export async function recordFlushAt(at: number): Promise<number[]> {
  const db = await getDB();
  const existing = ((await db.get(STORE_META, META_FLUSH_LOG)) as number[] | undefined) ?? [];
  const next = [...existing, at].slice(-FLUSH_LOG_MAX);
  await db.put(STORE_META, next, META_FLUSH_LOG);
  return next;
}

/** Flush timestamps within the last `windowMs`. */
export async function recentFlushTimestamps(windowMs: number): Promise<number[]> {
  const db = await getDB();
  const log = ((await db.get(STORE_META, META_FLUSH_LOG)) as number[] | undefined) ?? [];
  const cutoff = Date.now() - windowMs;
  return log.filter((t) => t >= cutoff);
}
