/**
 * Photo forensics pipeline — Prompts 8, 9 & 9.1.
 *
 * Runs server-side, sequentially, after the client-side vision pre-fill. Given a
 * `writeoff_photos` row it:
 *
 *   1. pHash dedup (Prompt 8) — compute a perceptual hash, Hamming-compare it
 *      against the WHOLE corpus (not per-user), and on a near-duplicate set
 *      `dup_of` + emit `risk_event('phash_dup_hit')`. This is the #1 fraud
 *      signal: re-using one spoilage photo across many write-offs.
 *   2. Liveness / freshness (Prompt 8) — source must be camera; captured_at vs
 *      server receive-time gap sanity. Emits flags, never hard-blocks.
 *   3. Vision claim-match (Prompt 9.1) — gpt-4o-mini returns a REQUIRED `verdict`
 *      the pipeline maps to a risk_event:
 *        'ok'           → no flag
 *        'mismatch'     → risk_event('vision_mismatch')   (+35, forces on_hold)
 *        'inconclusive' → risk_event('vision_unverified') (+20, → in_review)
 *      ANY failure to obtain a parsed verdict (LLM error / timeout / parse-fail
 *      / no image bytes) is FAIL-CLOSED: store an inconclusive `vision_result`
 *      and emit `vision_unverified` — a doubtful write-off goes to review, never
 *      auto-approved unverified. The full parsed object (with verdict) is always
 *      persisted to `writeoff_photos.vision_result`.
 *
 * Stages run strictly in order (never in parallel) and each is non-fatal: a
 * failure in one logs and the next still runs. The whole call is itself wrapped
 * by the caller (`submit-writeoff`) so submit never blocks on forensics.
 *
 * `rerunVisionVerification(writeoffId)` is the backfill entry point — it re-runs
 * ONLY the vision stage for an existing write-off's photo (no re-upload needed),
 * deleting prior vision_* risk_events first so re-emit doesn't duplicate.
 *
 * Uses the service role throughout — corpus-wide reads and post-insert photo
 * enrichment bypass RLS by design (risk_events INSERT is reviewer/admin only,
 * and dedup must see every photo regardless of submitter). Emitted risk_event
 * weights use the canonical `RISK_FEATURE_WEIGHTS` so the persisted weight
 * matches the points the scorer counts.
 */

import { createServiceClient } from "@/lib/supabase/service";
import { computePHash, hammingDistance } from "@/lib/forensics/phash";
import {
  visionVerifyFromImage,
  inconclusiveVisionResult,
  type VisionClaim,
  type VisionVerify,
} from "@/lib/llm/vision-verify";
import { bufferToDataUrl } from "@/lib/llm/vision-prefill";
import { RISK_FEATURE_WEIGHTS } from "@/lib/risk/score";
import type { Json, RiskEventInsert, WriteoffPhoto } from "@/lib/db/types";

// ── Tuning ────────────────────────────────────────────────────────────────────

/**
 * Hamming distance at/below which two photos count as the same image. 5 is
 * strict: an exact re-upload is distance 0, a JPEG re-encode a couple of bits.
 * Override per-environment with PHASH_DUP_THRESHOLD.
 */
export const PHASH_DUP_THRESHOLD = Number(process.env.PHASH_DUP_THRESHOLD ?? 5);

/**
 * Captured-at may legitimately run a little ahead of the server clock (device
 * skew). Only flag when it is ahead by more than this tolerance.
 */
const CAPTURE_CLOCK_TOLERANCE_MS = 60_000; // 1 min
/** A photo captured more than this long before receive is "stale" — possibly reused. */
const CAPTURE_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/** risk_events dropped before re-emitting during a vision backfill. */
const VISION_EVENT_FEATURES = ["vision_mismatch", "vision_unverified"] as const;

// ── Report types ──────────────────────────────────────────────────────────────

export type ForensicsFlag =
  | "phash_dup_hit"
  | "non_camera_source"
  | "capture_time_skew"
  | "vision_mismatch"
  | "vision_unverified";

export interface ForensicsReport {
  photoId: string;
  phash: string | null;
  dupOf: string | null;
  dupDistance: number | null;
  flags: ForensicsFlag[];
  /** Always set — a parsed result, or a fail-closed inconclusive object. */
  vision: VisionVerify;
}

// ── Shared context shapes ─────────────────────────────────────────────────────

type ServiceClient = ReturnType<typeof createServiceClient>;
type RiskDetail = Record<string, string | number | boolean | null>;

/** Minimal slice of a writeoff_photos row the pipeline reads. */
type PhotoRow = Pick<
  WriteoffPhoto,
  "id" | "storage_path" | "source" | "captured_at" | "created_at" | "writeoff_id"
>;

/** Claim context loaded from the writeoff + its reason code. */
type WriteoffClaim = {
  qty: number;
  unit: string;
  comment: string | null;
  reason_code_id: string;
} | null;

type ReasonRow = { label_ru: string; category: string } | null;

const PHOTOS_BUCKET = "writeoff-photos";

function mimeFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// ── Risk-event emitter (shared by the pipeline + the backfill helper) ─────────

type EmitRisk = (
  writeoffId: string,
  feature: ForensicsFlag,
  weight: number,
  detail: RiskDetail,
) => Promise<void>;

/**
 * Build an emitter that inserts a `risk_events` row and records the flag. A
 * failed insert logs and does NOT throw — the photo row update + audit log
 * still carry the signal, and the rest of the pipeline keeps running.
 */
function makeEmitter(service: ServiceClient, flags: ForensicsFlag[]): EmitRisk {
  return async (writeoffId, feature, weight, detail) => {
    const entry: RiskEventInsert = {
      writeoff_id: writeoffId,
      feature,
      weight,
      detail: detail as unknown as Json,
    };
    try {
      await service.from("risk_events").insert(entry as unknown as never);
      flags.push(feature);
    } catch (err) {
      console.error(`[forensics] risk_event '${feature}' insert failed:`, err);
    }
  };
}

// ── Loaders ───────────────────────────────────────────────────────────────────

async function loadPhoto(service: ServiceClient, photoId: string): Promise<PhotoRow> {
  const { data, error } = await service
    .from("writeoff_photos")
    .select("id, storage_path, source, captured_at, created_at, writeoff_id")
    .eq("id", photoId)
    .single();
  if (error || !data) {
    throw new Error(`[forensics] photo ${photoId} not found: ${error?.message ?? "no row"}`);
  }
  return data as PhotoRow;
}

async function loadWriteoffClaim(
  service: ServiceClient,
  writeoffId: string,
): Promise<WriteoffClaim> {
  const { data } = await service
    .from("writeoffs")
    .select("qty, unit, comment, reason_code_id")
    .eq("id", writeoffId)
    .single();
  return data as WriteoffClaim;
}

async function loadReason(
  service: ServiceClient,
  reasonCodeId: string,
): Promise<ReasonRow> {
  const { data } = await service
    .from("reason_codes")
    .select("label_ru, category")
    .eq("id", reasonCodeId)
    .single();
  return data as ReasonRow;
}

async function downloadPhotoBytes(
  service: ServiceClient,
  storagePath: string,
): Promise<Buffer | null> {
  try {
    const { data: blob, error } = await service
      .storage.from(PHOTOS_BUCKET)
      .download(storagePath);
    if (error || !blob) throw new Error(error?.message ?? "no data");
    return Buffer.from(await blob.arrayBuffer());
  } catch (err) {
    // No bytes → no pHash, and vision fail-closes to vision_unverified.
    console.error("[forensics] storage download failed:", err);
    return null;
  }
}

// ── Stage 3 — vision claim-match (verdict → risk_event, fail-closed) ─────────

interface VisionStageInput {
  service: ServiceClient;
  emit: EmitRisk;
  writeoffId: string;
  storagePath: string;
  writeoff: WriteoffClaim;
  reason: ReasonRow;
  bytes: Buffer | null;
}

/**
 * Run the vision verify call and map the verdict to a risk_event. Always
 * returns a `VisionVerify` (parsed, or fail-closed inconclusive) and always
 * persists-worthy: 'ok' emits nothing, 'mismatch' → vision_mismatch (+35),
 * 'inconclusive' → vision_unverified (+20), and ANY failure to obtain a parsed
 * verdict → fail-closed vision_unverified (+20).
 */
async function runVisionStage(input: VisionStageInput): Promise<VisionVerify> {
  const { emit, writeoffId, storagePath, writeoff, reason, bytes } = input;

  const failClosed = async (cause: string): Promise<VisionVerify> => {
    const vision = inconclusiveVisionResult(cause);
    await emit(writeoffId, "vision_unverified", RISK_FEATURE_WEIGHTS.vision_unverified, {
      verdict: vision.verdict,
      confidence: vision.confidence,
      cause,
    });
    return vision;
  };

  // Can't verify without bytes or claim context → fail closed.
  if (!bytes) return failClosed("photo bytes unavailable");
  if (!writeoff) return failClosed("writeoff claim context unavailable");

  try {
    const claim: VisionClaim = {
      productLabel:
        writeoff.comment?.trim() || reason?.label_ru || "неизвестный продукт",
      defectLabel: reason ? `${reason.label_ru} (${reason.category})` : "—",
      declaredQty: writeoff.qty,
      unit: writeoff.unit,
    };
    const dataUrl = bufferToDataUrl(bytes, mimeFromPath(storagePath));
    const vision = await visionVerifyFromImage(dataUrl, claim);

    if (vision.verdict === "mismatch") {
      await emit(writeoffId, "vision_mismatch", RISK_FEATURE_WEIGHTS.vision_mismatch, {
        verdict: vision.verdict,
        matches_product: vision.matches_product,
        matches_defect: vision.matches_defect,
        visible_qty: vision.visible_qty,
        declared_qty: writeoff.qty,
        confidence: vision.confidence,
        notes: vision.notes,
      });
    } else if (vision.verdict === "inconclusive") {
      await emit(writeoffId, "vision_unverified", RISK_FEATURE_WEIGHTS.vision_unverified, {
        verdict: vision.verdict,
        matches_product: vision.matches_product,
        confidence: vision.confidence,
        notes: vision.notes,
      });
    }
    // 'ok' → no flag.
    return vision;
  } catch (err) {
    // LLM error / timeout / parse-fail → fail closed. The strict schema makes a
    // notes-only reply impossible (the parser throws), so this also covers the
    // original prod bug where no verdict was returned.
    const cause = `vision call failed: ${err instanceof Error ? err.message : "unknown error"}`;
    return failClosed(cause);
  }
}

// ── Public API: full pipeline ─────────────────────────────────────────────────

/**
 * Run the full forensics pipeline against a stored photo and persist results.
 *
 * @param photoId  the `writeoff_photos.id` just inserted by the submit action
 * @returns        a report summarising the hash, dup link, emitted flags, and
 *                 the vision verdict (always present)
 */
export async function runPhotoForensics(photoId: string): Promise<ForensicsReport> {
  const service = createServiceClient();
  const flags: ForensicsFlag[] = [];
  const emit = makeEmitter(service, flags);

  // ── Load the photo row + the claim context (writeoff + reason code) ─────────
  const photo = await loadPhoto(service, photoId);
  const writeoffId = photo.writeoff_id;
  const writeoff = await loadWriteoffClaim(service, writeoffId);
  const reason = writeoff ? await loadReason(service, writeoff.reason_code_id) : null;

  // ── Download the image once — reused by pHash and vision verify ────────────
  const bytes = await downloadPhotoBytes(service, photo.storage_path);

  // ── Stage 1 — pHash dedup (whole corpus) ───────────────────────────────────
  let phash: string | null = null;
  let dupOf: string | null = null;
  let dupDistance: number | null = null;

  if (bytes) {
    try {
      phash = await computePHash(bytes);

      // Read every hashed photo in the corpus except this one. No user filter —
      // re-using a spoilage photo across employees/locations is the exact fraud
      // we want to catch. (Full scan is fine at current scale; an LSH/index can
      // be added later without changing this contract.)
      const { data: rawCorpus, error: corpusErr } = await service
        .from("writeoff_photos")
        .select("id, phash")
        .not("phash", "is", null)
        .neq("id", photoId);

      if (corpusErr) {
        console.error("[forensics] corpus read failed:", corpusErr.message);
      } else {
        const corpus = (rawCorpus ?? []) as Pick<WriteoffPhoto, "id" | "phash">[];
        let bestId: string | null = null;
        let bestDist = Number.MAX_SAFE_INTEGER;
        for (const row of corpus) {
          if (!row.phash) continue;
          const d = hammingDistance(phash, row.phash);
          if (d < bestDist) {
            bestDist = d;
            bestId = row.id;
          }
        }
        if (bestId !== null && bestDist <= PHASH_DUP_THRESHOLD) {
          dupOf = bestId;
          dupDistance = bestDist;
          await emit(writeoffId, "phash_dup_hit", RISK_FEATURE_WEIGHTS.phash_dup_hit, {
            distance: bestDist,
            threshold: PHASH_DUP_THRESHOLD,
            matched_photo_id: bestId,
            phash,
          });
        }
      }
    } catch (err) {
      console.error("[forensics] pHash stage failed:", err);
    }
  }

  // ── Stage 2 — liveness / freshness (flags only, never block) ───────────────
  try {
    if (photo.source !== "camera") {
      await emit(writeoffId, "non_camera_source", RISK_FEATURE_WEIGHTS.non_camera_source, {
        source: photo.source,
      });
    }

    if (photo.captured_at) {
      const capturedMs = Date.parse(photo.captured_at);
      const receivedMs = Date.parse(photo.created_at);
      if (!Number.isNaN(capturedMs) && !Number.isNaN(receivedMs)) {
        const gapMs = receivedMs - capturedMs; // >0: captured before receive (normal)
        if (gapMs < -CAPTURE_CLOCK_TOLERANCE_MS) {
          // captured_at is ahead of the server clock beyond tolerance → spoofed/future.
          await emit(writeoffId, "capture_time_skew", RISK_FEATURE_WEIGHTS.capture_time_skew, {
            reason: "future",
            gap_ms: gapMs,
            captured_at: photo.captured_at,
            received_at: photo.created_at,
          });
        } else if (gapMs > CAPTURE_STALE_MS) {
          // captured long before receive → possibly an old photo re-used.
          await emit(writeoffId, "capture_time_skew", RISK_FEATURE_WEIGHTS.capture_time_skew, {
            reason: "stale",
            gap_ms: gapMs,
            captured_at: photo.captured_at,
            received_at: photo.created_at,
          });
        }
      }
    }
  } catch (err) {
    console.error("[forensics] liveness stage failed:", err);
  }

  // ── Stage 3 — vision claim-match (runs after pre-fill, sequential) ─────────
  // Always runs; fail-closes to vision_unverified if no bytes / no claim / LLM
  // failure, so an unverified write-off is never silently auto-approved.
  const vision = await runVisionStage({
    service,
    emit,
    writeoffId,
    storagePath: photo.storage_path,
    writeoff,
    reason,
    bytes,
  });

  // ── Persist enrichment on the photo row ────────────────────────────────────
  try {
    const patch: Partial<WriteoffPhoto> = {
      phash,
      dup_of: dupOf,
      vision_result: vision as unknown as Json,
    };
    await service
      .from("writeoff_photos")
      .update(patch as unknown as never)
      .eq("id", photoId);
  } catch (err) {
    console.error("[forensics] photo row update failed:", err);
  }

  return { photoId, phash, dupOf, dupDistance, flags, vision };
}

// ── Public API: backfill (re-run vision only, no re-upload) ──────────────────

export interface VisionBackfillReport {
  writeoffId: string;
  photoId: string;
  flags: ForensicsFlag[];
  vision: VisionVerify;
}

/**
 * Re-run ONLY the vision stage for an existing write-off's photo — the backfill
 * helper (Prompt 9.1) so a verdict can be forced / retested without re-uploading.
 *
 * Drops any prior `vision_mismatch` / `vision_unverified` risk_events for the
 * write-off first so the re-emit doesn't double-count rows (the scorer dedupes
 * by feature anyway, but the table stays clean). `phash` / `dup_of` and any
 * `phash_dup_hit` event are left untouched — this is a vision-only re-run. The
 * caller (`scripts/backfill-vision-verify.ts`) re-runs `recomputeAndRoute`
 * afterwards so the score + queue reflect the new verdict.
 */
export async function rerunVisionVerification(
  writeoffId: string,
): Promise<VisionBackfillReport> {
  const service = createServiceClient();
  const flags: ForensicsFlag[] = [];
  const emit = makeEmitter(service, flags);

  // Load the write-off's first photo (the capture flow files one photo per writeoff).
  const { data: rawPhoto, error: photoErr } = await service
    .from("writeoff_photos")
    .select("id, storage_path, source, captured_at, created_at, writeoff_id")
    .eq("writeoff_id", writeoffId)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (photoErr || !rawPhoto) {
    throw new Error(
      `[forensics] no photo for writeoff ${writeoffId}: ${photoErr?.message ?? "no row"}`,
    );
  }
  const photo = rawPhoto as PhotoRow;

  const writeoff = await loadWriteoffClaim(service, writeoffId);
  const reason = writeoff ? await loadReason(service, writeoff.reason_code_id) : null;
  const bytes = await downloadPhotoBytes(service, photo.storage_path);

  // Drop prior vision verdict events so the re-emit is the single source of truth.
  try {
    await service
      .from("risk_events")
      .delete()
      .eq("writeoff_id", writeoffId)
      .in("feature", VISION_EVENT_FEATURES as unknown as string[]);
  } catch (err) {
    // Non-fatal: the scorer dedupes by feature, so stale rows would at worst
    // duplicate the same signal. Log and continue.
    console.error("[forensics] backfill: delete prior vision events failed:", err);
  }

  const vision = await runVisionStage({
    service,
    emit,
    writeoffId,
    storagePath: photo.storage_path,
    writeoff,
    reason,
    bytes,
  });

  // Persist the fresh vision_result (phash / dup_of untouched).
  try {
    await service
      .from("writeoff_photos")
      .update({ vision_result: vision as unknown as Json } as unknown as never)
      .eq("id", photo.id);
  } catch (err) {
    console.error("[forensics] backfill: vision_result update failed:", err);
  }

  return { writeoffId, photoId: photo.id, flags, vision };
}
