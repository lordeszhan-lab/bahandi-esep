/**
 * Risk recompute orchestrator (Prompt 10) + the "on any new event" hook.
 *
 * `recomputeRiskScore(writeoffId)` is the impure counterpart to the pure
 * `scoreWriteoff`: it loads the write-off, its location, its photos (for GPS +
 * vision_result) and its persisted risk_events, computes the historical-rate
 * baselines, runs the scorer, and persists `risk_score` + the `risk_features`
 * breakdown back onto the row. This is what gets called whenever a new
 * risk_event lands — "recompute on any new event".
 *
 * `recomputeAndRoute(writeoffId)` is the status hook: score, persist, then hand
 * to the policy-as-code router (Prompt 11) so a new event both moves the score
 * AND re-routes the write-off to the correct queue. `submit-writeoff` calls this
 * after the forensics pipeline has emitted its events.
 *
 * Everything here is service-role (RLS would hide other submitters' rows from
 * the corpus/baselines) and non-fatal: a recompute failure logs and never
 * throws, so it can never roll back a submission.
 */

import { createServiceClient } from "@/lib/supabase/service";
import type { Json, Writeoff, StoreFormat } from "@/lib/db/types";
import { computeBaselines, buildFormatComparison } from "@/lib/risk/baselines";
import {
  scoreWriteoff,
  type ContributingFeature,
  type RiskEventInput,
  type RiskInput,
  type RiskLocationInput,
  type RiskPhotoInput,
  type RiskScoreResult,
  type VisionSnapshot,
} from "@/lib/risk/score";
import { routeWriteoff, type RouteResult } from "@/lib/workflow/route";

// ── Public API ────────────────────────────────────────────────────────────────

export interface RecomputeResult extends RiskScoreResult {
  writeoffId: string;
}

/**
 * Recompute and persist the risk score + contributing features for one
 * write-off. Safe to call on any new risk_event. Returns the score + features,
 * or throws only on a hard failure to load the write-off (callers wrap in
 * try/catch — see `submit-writeoff`).
 */
export async function recomputeRiskScore(
  writeoffId: string,
): Promise<RecomputeResult> {
  const service = createServiceClient();

  // ── Load the write-off row ──────────────────────────────────────────────────
  const { data: rawWriteoff, error: wErr } = await service
    .from("writeoffs")
    .select(
      "id, value_cost, created_at, charged_employee_id, location_id, withholding",
    )
    .eq("id", writeoffId)
    .single();
  if (wErr || !rawWriteoff) {
    throw new Error(
      `[risk] writeoff ${writeoffId} not found: ${wErr?.message ?? "no row"}`,
    );
  }
  const writeoff = rawWriteoff as Pick<
    Writeoff,
    | "id"
    | "value_cost"
    | "created_at"
    | "charged_employee_id"
    | "location_id"
    | "withholding"
  >;

  // ── Location (geofence) + photos (GPS + vision) + risk_events, in parallel ──
  const [location, photos, events] = await Promise.all([
    loadLocation(service, writeoff.location_id),
    loadPhotos(service, writeoffId),
    loadEvents(service, writeoffId),
  ]);

  // ── Baselines from historical rates ─────────────────────────────────────────
  const baselines = await computeBaselines({
    writeoffId,
    locationId: writeoff.location_id,
    chargedEmployeeId: writeoff.charged_employee_id,
  });

  // ── Per-format baseline comparison (Prompt B) ───────────────────────────────
  // Cold-start reference: judges the store's volume + reason mix against its
  // FORMAT baseline. null when the store has no format or no baseline seeded —
  // the scorer then skips the format features.
  const formatComparison = await buildFormatComparison(
    writeoff.location_id,
    location?.format ?? null,
  );

  // ── Pure score ──────────────────────────────────────────────────────────────
  const input: RiskInput = {
    writeoff,
    location,
    photos,
    events,
    baselines,
    formatComparison,
  };
  const result = scoreWriteoff(input);

  // ── Persist score + feature breakdown ───────────────────────────────────────
  await persistScore(service, writeoffId, result);

  return { writeoffId, ...result };
}

/**
 * The status hook (Prompt 10 "status hook" + Prompt 11 routing): recompute the
 * score, persist it, then re-route the write-off so a new event both updates
 * the score and moves the write-off to the right review queue. Non-fatal — a
 * routing failure after a successful recompute logs but does not throw.
 */
export async function recomputeAndRoute(
  writeoffId: string,
): Promise<{ score: RecomputeResult; route: RouteResult | null }> {
  const score = await recomputeRiskScore(writeoffId);
  let route: RouteResult | null = null;
  try {
    route = await routeWriteoff(writeoffId);
  } catch (err) {
    // The score is already persisted; routing is a separate concern and must
    // not surface a failure to the caller (e.g. submit).
    console.error(`[risk] route after recompute failed for ${writeoffId}:`, err);
  }
  return { score, route };
}

// ── Loaders ───────────────────────────────────────────────────────────────────

async function loadLocation(
  service: ReturnType<typeof createServiceClient>,
  locationId: string,
): Promise<RiskLocationInput & { format: StoreFormat | null }> {
  const { data, error } = await service
    .from("stores")
    .select("lat, lng, geofence_radius_m, format")
    .eq("id", locationId)
    .single();
  if (error || !data) return { lat: null, lng: null, geofence_radius_m: null, format: null };
  return data as RiskLocationInput & { format: StoreFormat | null };
}

async function loadPhotos(
  service: ReturnType<typeof createServiceClient>,
  writeoffId: string,
): Promise<RiskPhotoInput[]> {
  const { data, error } = await service
    .from("writeoff_photos")
    .select("gps_lat, gps_lng, vision_result")
    .eq("writeoff_id", writeoffId);
  if (error || !data) return [];
  return (data as { gps_lat: number | null; gps_lng: number | null; vision_result: Json | null }[]).map(
    (row) => ({
      gps_lat: row.gps_lat,
      gps_lng: row.gps_lng,
      vision: parseVision(row.vision_result),
    }),
  );
}

async function loadEvents(
  service: ReturnType<typeof createServiceClient>,
  writeoffId: string,
): Promise<RiskEventInput[]> {
  const { data, error } = await service
    .from("risk_events")
    .select("feature, weight, detail")
    .eq("writeoff_id", writeoffId);
  if (error || !data) return [];
  return (data as { feature: string; weight: number; detail: Json | null }[]).map(
    (row) => ({
      feature: row.feature,
      weight: row.weight,
      detail: normalizeDetail(row.detail),
    }),
  );
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistScore(
  service: ReturnType<typeof createServiceClient>,
  writeoffId: string,
  result: RiskScoreResult,
): Promise<void> {
  const patch = {
    risk_score: result.score,
    risk_features: result.features as unknown as Json,
  };
  const { error } = await service
    .from("writeoffs")
    .update(patch as unknown as never)
    .eq("id", writeoffId);
  if (error) {
    // Non-fatal at the caller level, but persisting the score is the point of
    // the recompute — surface it loudly so it isn't silently lost.
    console.error(`[risk] persist score failed for ${writeoffId}:`, error.message);
  }
}

// ── Json coercion helpers ─────────────────────────────────────────────────────

/**
 * Pull the two fields the scorer reads out of a vision_result jsonb. The
 * forensics pipeline stores a full `VisionVerify`, but the scorer only needs
 * confidence + matches_product, so we coerce defensively.
 */
function parseVision(raw: Json | null): VisionSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const confidence = typeof obj.confidence === "number" ? obj.confidence : null;
  const matchesProduct =
    typeof obj.matches_product === "boolean" ? obj.matches_product : null;
  return { confidence, matches_product: matchesProduct };
}

/**
 * Coerce a risk_event.detail jsonb into the flat detail record the scorer /
 * cockpit expect. Drops values that aren't primitives.
 */
function normalizeDetail(
  raw: Json | null,
): Record<string, string | number | boolean | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

// Re-export so callers can import feature types from the risk barrel if desired.
export type { ContributingFeature };
