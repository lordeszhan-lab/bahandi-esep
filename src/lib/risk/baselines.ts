/**
 * Historical-rate baselines for the risk engine (Prompt 10).
 *
 * The scorer (`score.ts`) is pure and takes baselines as input; this module is
 * the DB side that produces them. "Baselines from historical rates" means we
 * look back over a fixed window and compute write-off rates (per day) for:
 *
 *   • the charged employee            — employeeRate
 *   • the location, per employee      — locationPerEmployeeRate  (employee baseline)
 *   • the location, total             — locationRate            (for location_high_rate)
 *   • the chain, per location         — chainPerLocationRate    (location baseline)
 *   • repeat-charge count for the emp — repeatedChargeCount     (short window)
 *
 * Rates are write-offs/day. The current write-off is excluded from every count
 * so it cannot inflate its own baseline. Counts use the service role (RLS would
 * hide other submitters' rows — baselines must see the whole population).
 */

import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, FormatBaseline, StoreFormat, ReasonCode } from "@/lib/db/types";
import type {
  RiskBaselines,
  RecentStats,
  BaselineComparison,
  FormatComparison,
} from "@/lib/risk/score";

// ── Tuning ────────────────────────────────────────────────────────────────────

/** Lookback for the rate baselines (days). */
export const BASELINE_WINDOW_DAYS = 30;
/** Window for the repeated-charge-target signal (hours). */
export const REPEATED_CHARGE_WINDOW_HOURS = 24;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface BaselineOptions {
  /** Exclude this write-off from every count (the one being scored). */
  writeoffId: string;
  locationId: string;
  chargedEmployeeId: string | null;
  /** Override the lookback (days) — mainly for tests. */
  windowDays?: number;
  /** Override the repeated-charge window (hours) — mainly for tests. */
  repeatedChargeWindowHours?: number;
  /** Reference time (epoch ms). Defaults to now. */
  now?: number;
  /** Inject a client (tests / shared transactions). Defaults to a service client. */
  service?: SupabaseClient<Database>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the historical-rate baselines for one write-off. Every count is
 * defensive: a query error logs and is treated as zero rather than throwing,
 * so a transient DB hiccup degrades to "no baseline → rate features don't
 * fire" instead of failing the whole recompute.
 */
export async function computeBaselines(
  opts: BaselineOptions,
): Promise<RiskBaselines> {
  const service = opts.service ?? createServiceClient();
  const windowDays = opts.windowDays ?? BASELINE_WINDOW_DAYS;
  const repeatHours =
    opts.repeatedChargeWindowHours ?? REPEATED_CHARGE_WINDOW_HOURS;
  const now = opts.now ?? Date.now();
  const windowStart = new Date(now - windowDays * MS_PER_DAY).toISOString();
  const repeatStart = new Date(now - repeatHours * MS_PER_HOUR).toISOString();

  const emp = opts.chargedEmployeeId;

  // Each count: head request with exact count, excluding the current write-off.
  const [empCount, locCount, chainCount, empAtLocCount, repeatCount, locCountRows] =
    await Promise.all([
      emp
        ? countWriteoffs(service, {
            chargedEmployeeId: emp,
            since: windowStart,
            exclude: opts.writeoffId,
          })
        : Promise.resolve(0),
      countWriteoffs(service, {
        locationId: opts.locationId,
        since: windowStart,
        exclude: opts.writeoffId,
      }),
      countWriteoffs(service, { since: windowStart, exclude: opts.writeoffId }),
      countEmployeesAtLocation(service, opts.locationId),
      emp
        ? countWriteoffs(service, {
            chargedEmployeeId: emp,
            since: repeatStart,
            exclude: opts.writeoffId,
          })
        : Promise.resolve(0),
      countStores(service),
    ]);

  const employeeRate = empCount / windowDays;
  const locationRate = locCount / windowDays;
  const chainPerLocationRate =
    locCountRows > 0 ? chainCount / locCountRows / windowDays : 0;
  const locationPerEmployeeRate =
    empAtLocCount > 0 ? locationRate / empAtLocCount : 0;

  return {
    employeeRate,
    locationPerEmployeeRate,
    locationRate,
    chainPerLocationRate,
    repeatedChargeCount: repeatCount,
  };
}

// ── Count helpers ─────────────────────────────────────────────────────────────

interface CountFilter {
  locationId?: string;
  chargedEmployeeId?: string;
  since?: string;
  exclude?: string;
}

async function countWriteoffs(
  service: SupabaseClient<Database>,
  filter: CountFilter,
): Promise<number> {
  let query = service
    .from("writeoffs")
    .select("id", { count: "exact", head: true });
  if (filter.locationId) query = query.eq("location_id", filter.locationId);
  if (filter.chargedEmployeeId)
    query = query.eq("charged_employee_id", filter.chargedEmployeeId);
  if (filter.since) query = query.gte("created_at", filter.since);
  if (filter.exclude) query = query.neq("id", filter.exclude);

  const { count, error } = await query;
  if (error) {
    console.error("[baselines] writeoffs count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

async function countEmployeesAtLocation(
  service: SupabaseClient<Database>,
  locationId: string,
): Promise<number> {
  const { count, error } = await service
    .from("employees")
    .select("id", { count: "exact", head: true })
    .eq("location_id", locationId);
  if (error) {
    console.error("[baselines] employees count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

async function countStores(
  service: SupabaseClient<Database>,
): Promise<number> {
  const { count, error } = await service
    .from("stores")
    .select("id", { count: "exact", head: true });
  if (error) {
    console.error("[baselines] stores count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

// ── Per-format baselines (Prompt B) ───────────────────────────────────────────
// Cold-start reference: until a store has its own history, its FORMAT baseline
// is the norm the risk engine judges volume + reason mix against. The pure
// types (RecentStats / BaselineComparison / FormatComparison) live in score.ts
// so the scorer stays I/O-free; this module is the DB side that produces them.

/** A store deviates "materially" when its rate/share exceeds the format norm by this factor. */
const FORMAT_VOLUME_ANOMALY_FACTOR = 1.8;
const FORMAT_REASON_ANOMALY_FACTOR = 1.8;

/**
 * Compare a store's recent stats against its FORMAT baseline. Pure: takes the
 * baseline + stats, returns the elevation flags the scorer reads, touches no
 * I/O. Fires when volume OR a tracked reason share materially exceeds the
 * format norm (the cold-start reference — no per-store history required).
 */
export function compareToBaseline(
  baseline: FormatBaseline,
  recent: RecentStats,
): BaselineComparison {
  const out: BaselineComparison = {};

  if (
    baseline.expected_writeoffs_per_day > 0 &&
    recent.writeoffsPerDay >
      baseline.expected_writeoffs_per_day * FORMAT_VOLUME_ANOMALY_FACTOR
  ) {
    out.format_volume_anomaly = {
      rate: round3(recent.writeoffsPerDay),
      baseline: round3(baseline.expected_writeoffs_per_day),
      factor: FORMAT_VOLUME_ANOMALY_FACTOR,
    };
  }

  const pairs: Array<{ key: string; share: number; expected: number }> = [
    { key: "accidental", share: recent.accidentalShare, expected: baseline.expected_accidental_share },
    { key: "breakage", share: recent.breakageShare, expected: baseline.expected_breakage_share },
    { key: "spoilage", share: recent.spoilageShare, expected: baseline.expected_spoilage_share },
  ];
  let worst: { key: string; factor: number } | null = null;
  for (const p of pairs) {
    if (p.expected > 0 && p.share > p.expected * FORMAT_REASON_ANOMALY_FACTOR) {
      const factor = p.share / p.expected;
      if (!worst || factor > worst.factor) worst = { key: p.key, factor };
    }
  }
  if (worst) {
    out.format_reason_anomaly = {
      worst: worst.key,
      factor: round3(worst.factor),
      shares: {
        accidental: round3(recent.accidentalShare),
        breakage: round3(recent.breakageShare),
        spoilage: round3(recent.spoilageShare),
      },
      baselines: {
        accidental: round3(baseline.expected_accidental_share),
        breakage: round3(baseline.expected_breakage_share),
        spoilage: round3(baseline.expected_spoilage_share),
      },
    };
  }

  return out;
}

/**
 * Load a format baseline row. Service role for consistency with the rest of
 * this module. Returns null when the format has no seeded baseline yet —
 * callers treat that as "no comparison" (the format features don't fire).
 */
export async function getFormatBaseline(
  format: StoreFormat,
  service?: SupabaseClient<Database>,
): Promise<FormatBaseline | null> {
  const svc = service ?? createServiceClient();
  const { data, error } = await svc
    .from("format_baselines")
    .select("*")
    .eq("format", format)
    .maybeSingle();
  if (error || !data) return null;
  return data as FormatBaseline;
}

/**
 * Compute a store's recent write-off stats over the window: daily volume + the
 * accidental/breakage/spoilage shares. Service role (baselines see the whole
 * population). Defensive: any query error degrades to zeros so a transient
 * hiccup can't fail a recompute. The current write-off contributes at most one
 * row to a 30-day window — never enough to flip a material spike — so it isn't
 * excluded from this count (unlike the historical-rate baselines).
 */
export async function computeRecentStats(
  locationId: string,
  opts: {
    windowDays?: number;
    now?: number;
    service?: SupabaseClient<Database>;
  } = {},
): Promise<RecentStats> {
  const svc = opts.service ?? createServiceClient();
  const windowDays = opts.windowDays ?? BASELINE_WINDOW_DAYS;
  const now = opts.now ?? Date.now();
  const since = new Date(now - windowDays * MS_PER_DAY).toISOString();

  const empty: RecentStats = {
    writeoffsPerDay: 0,
    accidentalShare: 0,
    breakageShare: 0,
    spoilageShare: 0,
  };

  const { data: rows, error } = await svc
    .from("writeoffs")
    .select("reason_code_id")
    .eq("location_id", locationId)
    .gte("created_at", since);
  if (error || !rows) {
    console.error("[baselines] recent stats load failed:", error?.message);
    return empty;
  }

  const total = rows.length;
  if (total === 0) return empty;

  // Map reason_code_id → category to bucket the shares.
  const { data: reasonRows, error: rErr } = await svc
    .from("reason_codes")
    .select("id, category");
  if (rErr || !reasonRows) {
    console.error("[baselines] reason_codes load failed:", rErr?.message);
    return empty;
  }
  const catById = new Map<string, string>(
    (reasonRows as ReasonCode[]).map((r) => [r.id, r.category]),
  );

  let accidental = 0;
  let breakage = 0;
  let spoilage = 0;
  for (const r of rows) {
    const cat = catById.get((r as { reason_code_id: string }).reason_code_id);
    if (cat === "accidental") accidental += 1;
    else if (cat === "breakage") breakage += 1;
    else if (cat === "spoilage") spoilage += 1;
  }

  return {
    writeoffsPerDay: total / windowDays,
    accidentalShare: accidental / total,
    breakageShare: breakage / total,
    spoilageShare: spoilage / total,
  };
}

/**
 * Build the full FormatComparison the scorer consumes: load the store's format
 * baseline + its recent stats, run compareToBaseline. Returns null when the
 * format has no seeded baseline (the scorer then skips the format features).
 */
export async function buildFormatComparison(
  locationId: string,
  format: StoreFormat | null,
  opts: {
    windowDays?: number;
    now?: number;
    service?: SupabaseClient<Database>;
  } = {},
): Promise<FormatComparison | null> {
  if (!format) return null;
  const svc = opts.service ?? createServiceClient();
  const baseline = await getFormatBaseline(format, svc);
  if (!baseline) return null;
  const recent = await computeRecentStats(locationId, { ...opts, service: svc });
  const flags = compareToBaseline(baseline, recent);
  return { baseline, recent, flags };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
