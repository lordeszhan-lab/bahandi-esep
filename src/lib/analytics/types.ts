/**
 * Network analytics types — Prompt C (Tower / benchmarking).
 *
 * Mirror the JSONB document returned by the `tower_analytics(p_from, p_to)`
 * Postgres RPC (supabase/migrations/0006_analytics_views.sql). The RPC is
 * `security definer` and gates on `get_my_role() in ('reviewer','admin')`, so
 * the whole network is aggregated server-side in one round trip — the Tower
 * page never loops over stores client-side.
 *
 * PostgREST returns `numeric` columns as JSON numbers (occasionally strings
 * for very high precision), so every numeric field is coerced with `num()`
 * in the loader before it reaches the UI.
 */

export type StoreFormat = "kiosk" | "mall" | "magnum" | "market" | "street";

export type RiskSeverity = "clean" | "watch" | "fraud";

/** Top KPI row — the four numbers the Tower leads with. */
export interface TowerKpis {
  totalLoss: number;
  totalWriteoffs: number;
  fraudCaughtCount: number;
  fraudCaughtValue: number;
  recoveredValue: number;
  unexplainedGap: number;
}

/** One row per active store, ranked by unexplained gap then loss. */
export interface PerStore {
  storeId: string;
  name: string;
  displayName: string;
  format: StoreFormat;
  city: string;
  cityId: string | null;
  clusterId: string | null;
  clusterName: string | null;
  writeoffCount: number;
  totalLoss: number;
  documentedLoss: number;
  /** category → KZT loss (yield/quality/accidental/spoilage/return/breakage). */
  byReason: Record<string, number>;
  flaggedCount: number;
  flaggedPct: number;
  autoApproveCount: number;
  autoApproveRate: number;
  riskAvg: number;
  /** Synthesised theoretical usage (the unexplained-gap source for the demo). */
  theoreticalUsage: number | null;
  /** theoretical_usage − documented_loss, clamped ≥ 0. null when no proxy row. */
  unexplainedGap: number | null;
}

/** Format rollup — kiosk / mall / magnum / market / street. */
export interface PerFormat {
  format: StoreFormat;
  /** Stores of this format with ≥1 write-off in the window. */
  storeCount: number;
  /** Total stores of this format in the network. */
  networkStoreCount: number;
  writeoffCount: number;
  totalLoss: number;
  lossPerStore: number;
  flaggedPct: number;
  autoApproveRate: number;
}

/** City rollup — one row per city (all 11), zeros when inactive. */
export interface PerCity {
  city: string;
  cityId: string;
  storeCount: number;
  writeoffCount: number;
  totalLoss: number;
  flaggedPct: number;
  autoApproveRate: number;
}

/** Cluster rollup — Almaty drills through its 3 clusters first. */
export interface PerCluster {
  clusterId: string;
  clusterName: string;
  cityId: string | null;
  city: string;
  storeCount: number;
  writeoffCount: number;
  totalLoss: number;
  flaggedPct: number;
}

/** The whole Tower payload, one round trip. */
export interface TowerAnalytics {
  kpis: TowerKpis;
  perStore: PerStore[];
  perFormat: PerFormat[];
  perCity: PerCity[];
  perCluster: PerCluster[];
  from: string;
  to: string;
}

/** Filter option lists for the Tower controls. */
export interface TowerFilterOptions {
  cities: Array<{ id: string; name: string }>;
  formats: StoreFormat[];
}

/** A red flag rendered on a write-off row (mirrors the cockpit signal chip). */
export interface TowerRedFlag {
  feature: string;
  points: number;
  severity: RiskSeverity;
  /** Empty in the Tower projection — the cockpit's `RedFlags` component requires
   *  the field but only reads feature/points/severity. */
  detail: Record<string, string | number | boolean | null>;
}

/**
 * A single write-off in a store's drill-down list — a lightweight, read-only
 * projection of the cockpit row (photo thumb + risk meter + red flags), without
 * the per-item baseline / dup-candidate machinery. Reuses the cockpit visual
 * language, not the heavy `ReviewQueueItem` shape.
 */
export interface StoreWriteoff {
  id: string;
  status: string;
  riskScore: number;
  severity: RiskSeverity;
  redFlags: TowerRedFlag[];
  qty: number;
  unit: string;
  valueCost: number | null;
  withholding: boolean;
  createdAt: string;
  reasonLabel: string;
  reasonCategory: string;
  photoUrl: string | null;
  iikoSyncStatus: string;
  escalationTier: string | null;
}

// ── numeric coercion ──────────────────────────────────────────────────────────

/** Coerce a PostgREST-JSON numeric (number | string | null/undefined) → number. */
export function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Coerce to a nullable number (null when the source is null/missing). */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Coerce a value to a StoreFormat, falling back to "street". */
export function coerceFormat(v: unknown): StoreFormat {
  const f = typeof v === "string" ? v : "";
  if (f === "kiosk" || f === "mall" || f === "magnum" || f === "market" || f === "street") {
    return f;
  }
  return "street";
}

/** Coerce an object of category → loss (numbers may arrive as strings). */
export function coerceByReason(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const obj = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(obj)) out[k] = num(val, 0);
  return out;
}

/** Empty payload — used when the RPC hasn't been applied or returns nothing. */
export function emptyTowerAnalytics(from: string, to: string): TowerAnalytics {
  return {
    kpis: {
      totalLoss: 0,
      totalWriteoffs: 0,
      fraudCaughtCount: 0,
      fraudCaughtValue: 0,
      recoveredValue: 0,
      unexplainedGap: 0,
    },
    perStore: [],
    perFormat: [],
    perCity: [],
    perCluster: [],
    from,
    to,
  };
}
