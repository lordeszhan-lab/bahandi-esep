"use client";

/**
 * Queue flush — Prompt 7.
 *
 * Drains the IndexedDB queue on reconnect: uploads each photo and calls the
 * `submitWriteoff` server action with exponential backoff. Before a flush
 * pass, it checks whether N submissions are landing within a short window at
 * shift-end; if so, those submissions are tagged `batchBurst: true` so the
 * risk engine (Prompt 10) can treat them as a possible end-of-shift batch —
 * we never block, only signal.
 */

import { uploadPhoto } from "@/lib/upload";
import { submitWriteoff, type SubmitResult } from "@/lib/actions/submit-writeoff";
import {
  listDue,
  update,
  pruneSynced,
  recordFlushAt,
  recentFlushTimestamps,
  type QueuedSubmission,
} from "@/lib/offline/queue";

// ── Tuning ────────────────────────────────────────────────────────────────────

/** ≥ this many submissions flushing inside the window counts as a burst. */
export const BURST_THRESHOLD = 3;
/** Window in which to count flushes for burst detection (ms). */
export const BURST_WINDOW_MS = 120_000; // 2 min
/**
 * Local hour (0–23) at which the shift-end window opens. A flush burst that
 * lands at/after this hour is flagged for the risk engine. Override per-site
 * with NEXT_PUBLIC_SHIFT_END_START_HOUR. Default 20 (8pm) suits late-closing
 * kitchens; this is a heuristic, not a hard rule.
 */
const SHIFT_END_START_HOUR = Number(
  process.env.NEXT_PUBLIC_SHIFT_END_START_HOUR ?? 20,
);

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export interface FlushResult {
  synced: number;
  failed: number;
  flagged: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when `at` (epoch ms) falls inside the shift-end window. */
export function isShiftEnd(at: number = Date.now()): boolean {
  const hour = new Date(at).getHours();
  return hour >= SHIFT_END_START_HOUR;
}

/** Exponential backoff with full jitter, capped at BACKOFF_MAX_MS. */
export function backoffDelay(attempts: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.min(attempts, 8);
  const capped = Math.min(exp, BACKOFF_MAX_MS);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

/**
 * Decide whether the about-to-flush pass should be tagged as a batch burst.
 * A burst is ≥ BURST_THRESHOLD submissions flushing within BURST_WINDOW_MS
 * (already-synced timestamps in the window + the items about to flush), and it
 * only signals when it lands at shift-end.
 */
export async function shouldFlagBurst(
  dueCount: number,
  now: number = Date.now(),
): Promise<boolean> {
  if (dueCount <= 0) return false;
  const recent = await recentFlushTimestamps(BURST_WINDOW_MS);
  const inWindow = recent.length + dueCount;
  return inWindow >= BURST_THRESHOLD && isShiftEnd(now);
}

// ── Per-item flush ────────────────────────────────────────────────────────────

async function flushOne(
  item: QueuedSubmission,
  userId: string,
  flagBurst: boolean,
): Promise<boolean> {
  // Lock the record so concurrent flush passes skip it.
  await update(item.id, { status: "syncing", batchBurst: flagBurst });

  try {
    // 1. Upload the photo if we haven't already (idempotent across retries by
    //    path — uploadPhoto uses upsert:false, so on retry after a partial
    //    success we re-upload under a new timestamp path; that's acceptable
    //    and the orphan is harmless).
    let storagePath = item.storagePath;
    if (!storagePath) {
      const uploaded = await uploadPhoto(item.blob, userId);
      storagePath = uploaded.storagePath;
      await update(item.id, { storagePath });
    }

    // 2. Create the writeoff + photo row + audit log via the server action.
    const result: SubmitResult = await submitWriteoff({
      reasonCodeId: item.reasonCodeId,
      qty: item.qty,
      unit: item.unit,
      comment: item.comment,
      withholding: item.withholding,
      chargedEmployeeId: item.chargedEmployeeId,
      storagePath,
      gpsLat: item.gpsLat,
      gpsLng: item.gpsLng,
      capturedAt: item.capturedAt,
      locationId: item.locationId,
      batchBurst: flagBurst,
    });

    // 3. Mark synced + record the flush timestamp for burst accounting. Drop
    //    the photo Blob from the record (already in Supabase storage) so IDB
    //    doesn't retain megabytes per submission.
    await update(item.id, {
      status: "synced",
      syncedAt: Date.now(),
      writeoffId: result.id,
      storagePath,
      lastError: null,
      nextAttemptAt: null,
      blob: new Blob([]),
    });
    await recordFlushAt(Date.now());
    return true;
  } catch (err) {
    const attempts = item.attempts + 1;
    const message = err instanceof Error ? err.message : "Sync failed";
    await update(item.id, {
      status: "failed",
      attempts,
      lastError: message,
      nextAttemptAt: Date.now() + backoffDelay(attempts),
    });
    return false;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Flush all due submissions for `userId`. Safe to call repeatedly; in-flight
 * items are skipped via the `syncing` status. Returns aggregate counts so the
 * UI can report progress and burst flags.
 */
export async function flushQueue(userId: string): Promise<FlushResult> {
  // Drop metadata for synced records older than a day so IDB stays bounded.
  // (Photo blobs are already released post-sync.)
  try {
    await pruneSynced(24 * 60 * 60 * 1000);
  } catch {
    /* non-fatal */
  }

  const due = await listDue();
  if (due.length === 0) return { synced: 0, failed: 0, flagged: 0 };

  const flagBurst = await shouldFlagBurst(due.length);

  let synced = 0;
  let failed = 0;
  let flagged = 0;

  // Sequential to keep burst accounting coherent and avoid storage hammering.
  for (const item of due) {
    if (flagBurst) flagged += 1;
    const ok = await flushOne(item, userId, flagBurst);
    if (ok) synced += 1;
    else failed += 1;
  }

  return { synced, failed, flagged };
}
