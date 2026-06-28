/**
 * Tower analytics loaders — Prompt C.
 *
 * Server-only. `loadTowerAnalytics` calls the `tower_analytics(p_from, p_to)`
 * RPC under the SESSION client so `get_my_role()` resolves to the signed-in
 * reviewer/admin (the service role has no `auth.uid()` and would get empty
 * results from the role guard). `loadStoreWriteoffs` (the leaderboard
 * drill-down) and the filter option lists use the service client for
 * network-wide visibility.
 *
 * The RPC does all heavy aggregation in Postgres; these helpers only coerce
 * the JSONB payload into typed TS and sign photo URLs for the drill-down.
 */

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/lib/db/types";
import {
  coerceByReason,
  coerceFormat,
  emptyTowerAnalytics,
  num,
  numOrNull,
  type PerCity,
  type PerCluster,
  type PerFormat,
  type PerStore,
  type RiskSeverity,
  type StoreFormat,
  type StoreWriteoff,
  type TowerAnalytics,
  type TowerFilterOptions,
  type TowerRedFlag,
} from "./types";

const PHOTOS_BUCKET = "writeoff-photos";
const SIGNED_URL_TTL_SEC = 300;
const DRILL_DOWN_LIMIT = 80;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * The whole Tower payload for a window. Returns an empty (zero) payload on
 * any error — e.g. when the analytics migration hasn't been applied yet — so
 * the page renders a calm empty state instead of throwing.
 */
export async function loadTowerAnalytics(args: {
  from: string;
  to: string;
}): Promise<TowerAnalytics> {
  const { from, to } = args;
  const client = await createClient();

  const res = await client.rpc(
    "tower_analytics" as never,
    { p_from: from, p_to: to } as never,
  );
  const raw = res.data as unknown;
  if (res.error || !raw || typeof raw !== "object") {
    if (res.error) {
      console.error("[tower] tower_analytics rpc failed:", res.error.message);
    }
    return emptyTowerAnalytics(from, to);
  }
  return parseTowerAnalytics(raw, from, to);
}

/** City + format option lists for the Tower filter controls. */
export async function loadTowerFilterOptions(): Promise<TowerFilterOptions> {
  const service = createServiceClient();

  const [{ data: cityRows }, { data: storeRows }] = await Promise.all([
    service.from("cities").select("id, name").order("name"),
    service
      .from("stores")
      .select("format")
      .eq("is_active", true)
      .not("format", "is", null),
  ]);

  const cities = ((cityRows ?? []) as Array<{ id: string; name: string }>)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const formatSet = new Set<StoreFormat>();
  for (const r of (storeRows ?? []) as Array<{ format: StoreFormat | null }>) {
    if (r.format) formatSet.add(r.format);
  }
  const order: StoreFormat[] = ["kiosk", "mall", "magnum", "market", "street"];
  const formats = order.filter((f) => formatSet.has(f));

  return { cities, formats };
}

/**
 * A store's write-offs in the window — the leaderboard drill-down. Lightweight,
 * read-only, in the cockpit visual language (photo thumb + risk meter + red
 * flags). Service role so a reviewer/admin sees the store's full history
 * (including auto-approved rows) regardless of submitter.
 */
export async function loadStoreWriteoffs(args: {
  storeId: string;
  from: string;
  to: string;
}): Promise<StoreWriteoff[]> {
  const { storeId, from, to } = args;
  const service = createServiceClient();

  const { data: rawRows, error } = await service
    .from("writeoffs")
    .select(
      "id, status, risk_score, risk_features, qty, unit, value_cost, withholding, created_at, reason_code_id, iiko_sync_status, escalation_tier",
    )
    .eq("location_id", storeId)
    .gte("created_at", from)
    .lt("created_at", to)
    .order("created_at", { ascending: false })
    .limit(DRILL_DOWN_LIMIT);

  if (error || !rawRows) {
    console.error("[tower] store writeoffs load failed:", error?.message);
    return [];
  }
  const rows = rawRows as Array<{
    id: string;
    status: string;
    risk_score: number;
    risk_features: Json | null;
    qty: number;
    unit: string;
    value_cost: number | null;
    withholding: boolean;
    created_at: string;
    reason_code_id: string;
    iiko_sync_status: string;
    escalation_tier: string | null;
  }>;
  if (rows.length === 0) return [];

  const reasonIds = Array.from(new Set(rows.map((r) => r.reason_code_id)));
  const writeoffIds = rows.map((r) => r.id);

  const [reasons, photos] = await Promise.all([
    fetchReasons(service, reasonIds),
    fetchPhotosForWriteoffs(service, writeoffIds),
  ]);

  // One signed URL per writeoff (the capture flow files one photo per writeoff).
  const paths = Array.from(new Set(photos.map((p) => p.storage_path)));
  const signedUrls = await createSignedUrls(service, paths);
  const urlByPath = new Map<string, string>();
  for (let i = 0; i < paths.length; i++) urlByPath.set(paths[i], signedUrls[i]);

  const photoByWriteoff = new Map<string, string | null>();
  for (const p of photos) {
    if (!photoByWriteoff.has(p.writeoff_id)) {
      photoByWriteoff.set(p.writeoff_id, urlByPath.get(p.storage_path) ?? null);
    }
  }

  return rows.map((r) => {
    const reason = reasons.get(r.reason_code_id);
    const features = parseRiskFeatures(r.risk_features);
    const severity = aggregateSeverity(r.risk_score, features);
            const redFlags: TowerRedFlag[] = features.map((f) => ({
              feature: f.feature,
              points: f.points,
              severity: featureSeverity(f.feature),
              detail: {},
            }));
    return {
      id: r.id,
      status: r.status,
      riskScore: r.risk_score,
      severity,
      redFlags,
      qty: r.qty,
      unit: r.unit,
      valueCost: r.value_cost,
      withholding: r.withholding,
      createdAt: r.created_at,
      reasonLabel: reason?.label_ru ?? "—",
      reasonCategory: reason?.category ?? "—",
      photoUrl: photoByWriteoff.get(r.id) ?? null,
      iikoSyncStatus: r.iiko_sync_status,
      escalationTier: r.escalation_tier,
    };
  });
}

// ── JSONB → typed payload ─────────────────────────────────────────────────────

function parseTowerAnalytics(raw: unknown, from: string, to: string): TowerAnalytics {
  const obj = raw as Record<string, unknown>;

  const kpisRaw = (obj.kpis ?? {}) as Record<string, unknown>;
  const kpis = {
    totalLoss: num(kpisRaw.total_loss),
    totalWriteoffs: num(kpisRaw.total_writeoffs),
    fraudCaughtCount: num(kpisRaw.fraud_caught_count),
    fraudCaughtValue: num(kpisRaw.fraud_caught_value),
    recoveredValue: num(kpisRaw.recovered_value),
    unexplainedGap: num(kpisRaw.unexplained_gap),
  };

  const perStore = (obj.perStore ?? []) as Array<Record<string, unknown>>;
  const perFormat = (obj.perFormat ?? []) as Array<Record<string, unknown>>;
  const perCity = (obj.perCity ?? []) as Array<Record<string, unknown>>;
  const perCluster = (obj.perCluster ?? []) as Array<Record<string, unknown>>;

  return {
    kpis,
    perStore: perStore.map(parsePerStore),
    perFormat: perFormat.map(parsePerFormat),
    perCity: perCity.map(parsePerCity),
    perCluster: perCluster.map(parsePerCluster),
    from: typeof obj.from === "string" ? obj.from : from,
    to: typeof obj.to === "string" ? obj.to : to,
  };
}

function parsePerStore(r: Record<string, unknown>): PerStore {
  return {
    storeId: String(r.store_id ?? ""),
    name: String(r.name ?? "—"),
    displayName: String(r.display_name ?? r.name ?? "—"),
    format: coerceFormat(r.format),
    city: String(r.city ?? "—"),
    cityId: r.city_id ?? null ? String(r.city_id) : null,
    clusterId: r.cluster_id ?? null ? String(r.cluster_id) : null,
    clusterName: r.cluster_name ?? null ? String(r.cluster_name) : null,
    writeoffCount: num(r.writeoff_count),
    totalLoss: num(r.total_loss),
    documentedLoss: num(r.documented_loss),
    byReason: coerceByReason(r.by_reason),
    flaggedCount: num(r.flagged_count),
    flaggedPct: num(r.flagged_pct),
    autoApproveCount: num(r.auto_approve_count),
    autoApproveRate: num(r.auto_approve_rate),
    riskAvg: num(r.risk_avg),
    theoreticalUsage: numOrNull(r.theoretical_usage),
    unexplainedGap: numOrNull(r.unexplained_gap),
  };
}

function parsePerFormat(r: Record<string, unknown>): PerFormat {
  return {
    format: coerceFormat(r.format),
    storeCount: num(r.store_count),
    networkStoreCount: num(r.network_store_count),
    writeoffCount: num(r.writeoff_count),
    totalLoss: num(r.total_loss),
    lossPerStore: num(r.loss_per_store),
    flaggedPct: num(r.flagged_pct),
    autoApproveRate: num(r.auto_approve_rate),
  };
}

function parsePerCity(r: Record<string, unknown>): PerCity {
  return {
    city: String(r.city ?? "—"),
    cityId: String(r.city_id ?? ""),
    storeCount: num(r.store_count),
    writeoffCount: num(r.writeoff_count),
    totalLoss: num(r.total_loss),
    flaggedPct: num(r.flagged_pct),
    autoApproveRate: num(r.auto_approve_rate),
  };
}

function parsePerCluster(r: Record<string, unknown>): PerCluster {
  return {
    clusterId: String(r.cluster_id ?? ""),
    clusterName: String(r.cluster_name ?? "—"),
    cityId: r.city_id ?? null ? String(r.city_id) : null,
    city: String(r.city ?? "—"),
    storeCount: num(r.store_count),
    writeoffCount: num(r.writeoff_count),
    totalLoss: num(r.total_loss),
    flaggedPct: num(r.flagged_pct),
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;

async function fetchReasons(
  service: Service,
  ids: string[],
): Promise<Map<string, { label_ru: string; category: string }>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await service
    .from("reason_codes")
    .select("id, label_ru, category")
    .in("id", ids);
  if (error || !data) return new Map();
  const map = new Map<string, { label_ru: string; category: string }>();
  for (const r of data as Array<{ id: string; label_ru: string; category: string }>) {
    map.set(r.id, { label_ru: r.label_ru, category: r.category });
  }
  return map;
}

async function fetchPhotosForWriteoffs(
  service: Service,
  writeoffIds: string[],
): Promise<Array<{ writeoff_id: string; storage_path: string }>> {
  if (writeoffIds.length === 0) return [];
  const { data, error } = await service
    .from("writeoff_photos")
    .select("writeoff_id, storage_path")
    .in("writeoff_id", writeoffIds)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as Array<{ writeoff_id: string; storage_path: string }>;
}

async function createSignedUrls(service: Service, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { data, error } = await service.storage
    .from(PHOTOS_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SEC);
  if (error || !data) return paths.map(() => "");
  const byPath = new Map<string, string>();
  for (const r of data as Array<{ path?: string; signedUrl?: string }>) {
    if (r.path && r.signedUrl) byPath.set(r.path, r.signedUrl);
  }
  return paths.map((p) => byPath.get(p) ?? "");
}

// ── Risk-feature parsing + severity (mirrors the cockpit, minimal) ────────────

interface ParsedFeature {
  feature: string;
  points: number;
}

const FRAUD_FEATURES = new Set(["phash_dup_hit", "vision_mismatch"]);
const WATCH_FEATURES = new Set([
  "vision_unverified",
  "geofence_fail",
  "geofence_unverified",
  "employee_high_rate",
  "repeated_charge_target",
  "location_high_rate",
  "format_volume_anomaly",
  "format_reason_anomaly",
]);

function featureSeverity(feature: string): RiskSeverity {
  if (FRAUD_FEATURES.has(feature)) return "fraud";
  if (WATCH_FEATURES.has(feature)) return "watch";
  return "clean";
}

function aggregateSeverity(score: number, features: ParsedFeature[]): RiskSeverity {
  if (features.some((f) => FRAUD_FEATURES.has(f.feature))) return "fraud";
  if (score >= 60) return "fraud";
  if (score >= 15) return "watch";
  if (features.some((f) => WATCH_FEATURES.has(f.feature))) return "watch";
  return "clean";
}

function parseRiskFeatures(raw: Json | null): ParsedFeature[] {
  if (!raw || !Array.isArray(raw)) return [];
  const out: ParsedFeature[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const feature = typeof obj.feature === "string" ? obj.feature : "";
    const points = typeof obj.points === "number" ? obj.points : 0;
    if (!feature) continue;
    out.push({ feature, points });
  }
  return out;
}
