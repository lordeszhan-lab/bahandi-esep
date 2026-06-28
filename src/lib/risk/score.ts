/**
 * Risk engine — rules scoring (Prompt 10).
 *
 * The single source of truth for "how risky is this write-off?". A PURE
 * function: given a snapshot of the write-off, its photos, its persisted
 * risk_events, and historical baselines, it returns a 0–100 score plus the
 * list of features that contributed (with the points each added) — the
 * breakdown the cockpit renders.
 *
 * Pure-ness is deliberate: the scorer takes everything it needs as input
 * and touches no I/O, so it is trivially unit-testable
 * (`npm run test:risk` / `scripts/test-risk-score.ts`) and deterministic.
 * The DB work (loading rows, computing baselines from historical rates,
 * persisting) lives in `baselines.ts` and `recompute.ts`.
 *
 * Scoring model — each contributing feature adds a fixed weight (capped at
 * 100, floored at 0). A feature fires at most once per write-off even if
 * several photos/events report it, so the score is bounded and predictable:
 *
 *   phash_dup_hit            +45  — re-used spoilage photo (the #1 fraud signal)
 *   vision_mismatch          +35  — photo doesn't match the claimed product/defect (holds)
 *   vision_unverified        +25  — vision couldn't verify the photo (dark/blurry/LLM fail)
 *   geofence_fail            +20  — photo GPS outside the location geofence
 *   geofence_unverified      +12  — store has no coords yet (soft; can't check)
 *   employee_high_rate       +15  — charged employee paces above their location's norm
 *   repeated_charge_target   +12  — same employee charged repeatedly in a short window
 *   format_volume_anomaly    +12  — store's write-off volume spikes above its FORMAT baseline
 *   format_reason_anomaly    +10  — store's reason mix skews from its FORMAT baseline (cold-start)
 *   vision_low_confidence    +10  — vision match but low confidence
 *   location_high_rate       +10  — location paces above the chain norm
 *   high_value               +10  — value at/above the high-value threshold (per-format when set)
 *   odd_hour                 +8   — filed outside operating hours
 *   batch_burst              +8   — flushed in an end-of-shift offline burst
 *
 * Two forensics liveness signals emitted by `run.ts` are not in the prompt's
 * headline list but are folded in with modest weights so they are not lost:
 *   non_camera_source         +5
 *   capture_time_skew         +6
 *
 * The first twelve are the prompt's canonical weights; the last two are
 * auxiliary. All weights live in `RISK_FEATURE_WEIGHTS` so tuning is one place.
 */

import { distanceMeters, storeIsGeocoded } from "../geo/geofence";
import type { FormatBaseline } from "@/lib/db/types";

// ── Weights ──────────────────────────────────────────────────────────────────

/**
 * Point contribution per feature. The prompt fixes the headline weights; the two
 * liveness auxiliaries are tuning constants kept here alongside them.
 */
export const RISK_FEATURE_WEIGHTS = {
  phash_dup_hit: 45,
  vision_mismatch: 35,
  vision_unverified: 25,
  geofence_fail: 20,
  geofence_unverified: 12,
  employee_high_rate: 15,
  repeated_charge_target: 12,
  format_volume_anomaly: 12,
  format_reason_anomaly: 10,
  vision_low_confidence: 10,
  location_high_rate: 10,
  high_value: 10,
  odd_hour: 8,
  batch_burst: 8,
  // forensics liveness auxiliaries (emitted by run.ts)
  non_camera_source: 5,
  capture_time_skew: 6,
} as const;

/** Every feature key the scorer knows how to weigh. */
export type RiskFeatureKey = keyof typeof RISK_FEATURE_WEIGHTS;

/** Maximum aggregate score — contributions sum then clamp to [0, 100]. */
export const RISK_SCORE_MAX = 100;

// ── Thresholds for the COMPUTED features (baselines come from history) ───────

export const RISK_THRESHOLDS = {
  /** gpt-4o-mini confidence below this (on a claimed match) is "low". */
  visionLowConfidence: 0.6,
  /** value_cost (KZT) at/above this is "high value". Matches routing's high-value cut. */
  highValue: 50_000,
  /** Local hour outside [oddHourStart, oddHourEnd) is "odd". */
  oddHourStart: 6,
  oddHourEnd: 22,
  /** UTC offset (hours) for converting created_at to local hour. Kazakhstan = +5. */
  oddHourUtcOffset: 5,
  /** employee paces faster than this × their location's per-employee baseline → high. */
  employeeRateFactor: 1.5,
  /** location paces faster than this × the chain's per-location baseline → high. */
  locationRateFactor: 1.5,
  /** ≥ this many charges of the same employee in the window → repeated target. */
  repeatedChargeMin: 3,
} as const;

// ── Input / output types ──────────────────────────────────────────────────────

/** Minimal slice of a vision_result jsonb the scorer reads. */
export interface VisionSnapshot {
  confidence: number | null;
  matches_product: boolean | null;
}

/** A photo's risk-relevant fields. */
export interface RiskPhotoInput {
  gps_lat: number | null;
  gps_lng: number | null;
  vision: VisionSnapshot | null;
}

/** A persisted risk_event row, loosened so the scorer stays DB-free. */
export interface RiskEventInput {
  feature: string;
  weight: number;
  detail: Record<string, string | number | boolean | null> | null;
}

/** The write-off's risk-relevant fields. */
export interface RiskWriteoffInput {
  id: string;
  value_cost: number | null;
  /** ISO timestamp — the write-off's created_at, used for odd_hour. */
  created_at: string;
  charged_employee_id: string | null;
  location_id: string;
  withholding: boolean;
}

/** The location's geofence, used for geofence_fail. null when unknown. */
export interface RiskLocationInput {
  lat: number | null;
  lng: number | null;
  geofence_radius_m: number | null;
}

/**
 * Historical-rate baselines (convention: baselines from historical rates),
 * computed externally by `baselines.ts` and passed in so the scorer stays pure.
 * All rates are write-offs per day over the baseline window.
 */
export interface RiskBaselines {
  /** Charged employee's daily write-off rate. */
  employeeRate: number;
  /** Location's average daily write-off rate per employee (the employee baseline). */
  locationPerEmployeeRate: number;
  /** Location's total daily write-off rate (for location_high_rate). */
  locationRate: number;
  /** Chain-wide average daily write-off rate per location (the location baseline). */
  chainPerLocationRate: number;
  /** Times the charged employee was charged in the repeated-charge window. */
  repeatedChargeCount: number;
}

// ── Per-format baseline comparison (Prompt B) ─────────────────────────────────
// Pure types — the DB side (baselines.ts) computes these and feeds them in so
// the scorer stays I/O-free. Until a store has its own history, its FORMAT
// baseline is the cold-start reference for volume + reason mix.

/** A store's recent write-off stats, compared against its format baseline. */
export interface RecentStats {
  /** Write-offs per day over the recent window. */
  writeoffsPerDay: number;
  /** Share of write-offs whose reason category is 'accidental' (0..1). */
  accidentalShare: number;
  /** Share whose reason category is 'breakage' (0..1). */
  breakageShare: number;
  /** Share whose reason category is 'spoilage' (0..1). */
  spoilageShare: number;
}

/** Elevation flags emitted by compareToBaseline (one entry per fired signal). */
export interface BaselineComparison {
  format_volume_anomaly?: {
    rate: number;
    baseline: number;
    factor: number;
  };
  format_reason_anomaly?: {
    worst: string;
    factor: number;
    shares: Record<string, number>;
    baselines: Record<string, number>;
  };
}

/** Bundle the scorer needs to turn a format comparison into features. */
export interface FormatComparison {
  baseline: FormatBaseline;
  recent: RecentStats;
  /** Precomputed by compareToBaseline — the scorer just reads the flags. */
  flags: BaselineComparison;
}

/** Everything the pure scorer needs. */
export interface RiskInput {
  writeoff: RiskWriteoffInput;
  location: RiskLocationInput | null;
  photos: RiskPhotoInput[];
  events: RiskEventInput[];
  baselines: RiskBaselines;
  /**
   * Per-format baseline comparison (Prompt B). null/undefined when the store has
   * no format or no baseline is seeded yet — the format features simply don't
   * fire, so the scorer degrades to the historical-rate model. Until a store has
   * its own history, the format baseline is the reference.
   */
  formatComparison?: FormatComparison | null;
}

export type FeatureDetail = Record<string, string | number | boolean | null>;

/** One contributing feature — what the cockpit renders per signal. */
export interface ContributingFeature {
  feature: RiskFeatureKey;
  points: number;
  detail: FeatureDetail;
}

export interface RiskScoreResult {
  score: number;
  features: ContributingFeature[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Haversine + the geofence presence-check live in @/lib/geo/geofence so the
// capture screen and the risk engine share one implementation.

/**
 * Local hour (0–23) for an ISO timestamp, shifted by the configured UTC offset.
 * Used by odd_hour so "after hours" is judged in the site's local time, not UTC.
 */
export function localHour(iso: string, utcOffset = RISK_THRESHOLDS.oddHourUtcOffset): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return -1;
  // Date.getUTCHours keeps us independent of the host's timezone.
  return (Math.floor(ms / 3_600_000) + utcOffset + 24) % 24;
}

// ── The scorer ────────────────────────────────────────────────────────────────

/**
 * Compute the aggregate risk score (0–100) and the contributing-feature
 * breakdown for a single write-off. Pure and deterministic: same input ⇒ same
 * output, no side effects, no I/O.
 *
 * Each feature fires at most once (deduped by key) even if multiple photos or
 * events report it, so the score is the sum of distinct feature weights capped
 * at 100. Features come from two sources:
 *
 *   1. Persisted `risk_events` (e.g. phash_dup_hit, vision_mismatch, batch_burst
 *      and the liveness signals) — emitted by the forensics pipeline / submit.
 *   2. Computed here from the write-off + photos + baselines (geofence_fail,
 *      vision_low_confidence, the rate features, high_value, odd_hour,
 *      repeated_charge_target).
 */
export function scoreWriteoff(input: RiskInput): RiskScoreResult {
  const features: ContributingFeature[] = [];
  const fired = new Set<RiskFeatureKey>();

  const add = (
    key: RiskFeatureKey,
    detail: FeatureDetail,
  ): void => {
    if (fired.has(key)) return; // one contribution per feature
    fired.add(key);
    features.push({ feature: key, points: RISK_FEATURE_WEIGHTS[key], detail });
  };

  const { writeoff, location, photos, events, baselines, formatComparison } = input;

  // ── Persisted events → features ─────────────────────────────────────────────
  for (const ev of events) {
    if (ev.feature in RISK_FEATURE_WEIGHTS) {
      add(ev.feature as RiskFeatureKey, ev.detail ?? {});
    }
    // Unknown feature strings are ignored by the canonical score (they may be
    // future signals); they remain persisted in risk_events for the audit trail.
  }

  // ── geofence — outside the radius → geofence_fail; store not geocoded →
  //    geofence_unverified (soft: we couldn't run the check, never a hard fail,
  //    so a not-yet-geocoded store doesn't block or hard-fail the score) ─────────
  if (location && storeIsGeocoded(location)) {
    const radius = location.geofence_radius_m as number;
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const dist = distanceMeters(
        location.lat,
        location.lng,
        p.gps_lat,
        p.gps_lng,
      );
      if (dist != null && dist > radius) {
        add("geofence_fail", {
          photo_index: i,
          distance_m: Math.round(dist),
          radius_m: radius,
        });
        break;
      }
    }
  } else {
    add("geofence_unverified", {
      reason: location ? "no_store_coords" : "no_store",
    });
  }

  // ── vision_low_confidence — a claimed match the model is unsure about ───────
  // Only fires when the photo was NOT already flagged a vision_mismatch (that
  // carries the heavier +30); low confidence on a "match" is its own mild signal.
  for (const p of photos) {
    const v = p.vision;
    if (!v || v.confidence == null) continue;
    const lowConf = v.confidence < RISK_THRESHOLDS.visionLowConfidence;
    const notMismatch = v.matches_product !== false;
    if (lowConf && notMismatch && !fired.has("vision_mismatch")) {
      add("vision_low_confidence", {
        confidence: v.confidence,
        threshold: RISK_THRESHOLDS.visionLowConfidence,
      });
      break;
    }
  }

  // ── employee_high_rate — charged employee paces above their location's norm ─
  if (writeoff.charged_employee_id && baselines.locationPerEmployeeRate > 0) {
    const baseline = baselines.locationPerEmployeeRate;
    if (baselines.employeeRate > baseline * RISK_THRESHOLDS.employeeRateFactor) {
      add("employee_high_rate", {
        employee_rate: round3(baselines.employeeRate),
        location_baseline: round3(baseline),
        factor: RISK_THRESHOLDS.employeeRateFactor,
      });
    }
  }

  // ── location_high_rate — location paces above the chain norm ────────────────
  if (baselines.chainPerLocationRate > 0) {
    const baseline = baselines.chainPerLocationRate;
    if (baselines.locationRate > baseline * RISK_THRESHOLDS.locationRateFactor) {
      add("location_high_rate", {
        location_rate: round3(baselines.locationRate),
        chain_baseline: round3(baseline),
        factor: RISK_THRESHOLDS.locationRateFactor,
      });
    }
  }

  // ── repeated_charge_target — same employee charged repeatedly ───────────────
  if (
    writeoff.charged_employee_id &&
    baselines.repeatedChargeCount >= RISK_THRESHOLDS.repeatedChargeMin
  ) {
    add("repeated_charge_target", {
      count: baselines.repeatedChargeCount,
      min: RISK_THRESHOLDS.repeatedChargeMin,
    });
  }

  // ── format_volume_anomaly — store's volume spikes above its FORMAT baseline ─
  // Cold-start reference: until a store has its own history, the format baseline
  // (e.g. "a kiosk does ~N write-offs/day") is the norm. A material spike flags
  // either a real surge or volume being pushed through one point.
  const volFlag = formatComparison?.flags.format_volume_anomaly;
  if (volFlag) {
    add("format_volume_anomaly", {
      rate: volFlag.rate,
      baseline: volFlag.baseline,
      factor: volFlag.factor,
      format: formatComparison?.baseline.format ?? null,
    });
  }

  // ── format_reason_anomaly — store's reason mix skews from its FORMAT norm ───
  // E.g. a kiosk whose 'accidental' share dwarfs the kiosk baseline (kiosks skew
  // accidental/breakage by default, so a further skew is a meaningful signal).
  const reasonFlag = formatComparison?.flags.format_reason_anomaly;
  if (reasonFlag) {
    add("format_reason_anomaly", {
      worst: reasonFlag.worst,
      factor: reasonFlag.factor,
      format: formatComparison?.baseline.format ?? null,
    });
  }

  // ── high_value — value at/above the high-value cut ──────────────────────────
  // Per-format threshold when the baseline carries one (a magnum's "high value"
  // is different from a kiosk's); fall back to the global cut otherwise.
  const highValueCut =
    formatComparison?.baseline.high_value_threshold ?? RISK_THRESHOLDS.highValue;
  if (writeoff.value_cost != null && writeoff.value_cost >= highValueCut) {
    add("high_value", {
      value: writeoff.value_cost,
      threshold: highValueCut,
      per_format: formatComparison?.baseline.high_value_threshold != null,
    });
  }

  // ── odd_hour — filed outside operating hours (site local time) ──────────────
  const hour = localHour(writeoff.created_at);
  if (
    hour >= 0 &&
    (hour < RISK_THRESHOLDS.oddHourStart || hour >= RISK_THRESHOLDS.oddHourEnd)
  ) {
    add("odd_hour", {
      local_hour: hour,
      operating_range: `${RISK_THRESHOLDS.oddHourStart}-${RISK_THRESHOLDS.oddHourEnd}`,
    });
  }

  // ── Aggregate: sum weights, clamp to [0, 100], sort by contribution ─────────
  const raw = features.reduce((sum, f) => sum + f.points, 0);
  const score = Math.max(0, Math.min(RISK_SCORE_MAX, raw));
  features.sort((a, b) => b.points - a.points);

  return { score, features };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
