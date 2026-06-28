/**
 * Review Cockpit data loader — Prompt 12.
 *
 * Server-side. Builds the context-rich queue the reviewer triages: every item
 * carries the photo, the risk score, the contributing red flags, this
 * employee's + location's rates vs their historical baselines, the side-by-side
 * duplicate candidate (when dup_of is set), and the vision analysis summary.
 *
 * The queue is "risky first" — ordered by risk_score desc — and scoped to the
 * reviewer's location (admins see all). Reads use the service role so the
 * duplicate candidate (cross-location fraud evidence) and the corpus-wide
 * baselines are visible; the main queue is manually filtered to the reviewer's
 * location to respect scope. Signed photo URLs are generated in one batch.
 */

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { computeBaselines } from "@/lib/risk/baselines";
import type { RiskBaselines } from "@/lib/risk/score";
import type {
  ContributingFeature,
} from "@/lib/risk/score";
import type {
  CurrentProfile,
} from "@/lib/auth-shared";
import type {
  EscalationTier,
  Json,
  WriteoffStatus,
} from "@/lib/db/types";

const PHOTOS_BUCKET = "writeoff-photos";
const QUEUE_LIMIT = 60;
const SIGNED_URL_TTL_SEC = 300;

// ── Item shape (serializable — passed into the client cockpit) ───────────────

export type RiskSeverity = "clean" | "watch" | "fraud";

export interface ReviewRedFlag {
  feature: string;
  points: number;
  severity: RiskSeverity;
  detail: Record<string, string | number | boolean | null>;
}

export interface ReviewRates {
  /** Charged employee's daily write-off rate. */
  employeeRate: number;
  /** Location's per-employee daily rate (the employee's baseline). */
  employeeBaseline: number;
  /** employeeRate / employeeBaseline, or null when no baseline. */
  employeeFactor: number | null;
  /** Location's total daily write-off rate. */
  locationRate: number;
  /** Chain-wide per-location daily rate (the location's baseline). */
  locationBaseline: number;
  /** locationRate / locationBaseline, or null when no baseline. */
  locationFactor: number | null;
}

export interface ReviewVisionSummary {
  verdict: "ok" | "mismatch" | "inconclusive";
  matchesProduct: boolean | null;
  matchesDefect: boolean | null;
  confidence: number | null;
  visibleQty: number | null;
  notes: string | null;
}

export interface ReviewPhoto {
  id: string;
  url: string | null;
  dupOf: string | null;
  vision: ReviewVisionSummary | null;
}

export interface ReviewDupCandidate {
  writeoffId: string;
  photoUrl: string | null;
  submittedAt: string;
  reasonLabel: string;
  submitterName: string;
  /** Hamming distance from the candidate photo's risk_event detail, if known. */
  hammingDistance: number | null;
}

export interface ReviewQueueItem {
  id: string;
  status: WriteoffStatus;
  riskScore: number;
  severity: RiskSeverity;
  redFlags: ReviewRedFlag[];
  qty: number;
  unit: string;
  comment: string | null;
  valueCost: number | null;
  withholding: boolean;
  createdAt: string;
  slaDueAt: string | null;
  escalationTier: EscalationTier | null;
  assignedQueue: string | null;
  reason: { key: string; labelRu: string; category: string };
  location: { id: string; name: string };
  chargedEmployee: { id: string; fullName: string; position: string | null } | null;
  submitter: { id: string; fullName: string };
  photo: ReviewPhoto | null;
  dupCandidate: ReviewDupCandidate | null;
  rates: ReviewRates;
  /**
   * The geofence presence signal for the capture photo — the "filed
   * off-location" guard. `fail` → GPS was outside the store's radius
   * (geofence_fail, with the capture-to-store distance); `unverified` → the
   * store has no coords (geofence_unverified); `ok` → in-geofence / not
   * flagged. The approve action shows a confirm dialog when this is not `ok`.
   */
  geofence: ReviewGeofenceSignal;
  /** True when the item is clean enough for bulk-approve (no hard-gate, low score). */
  bulkApprovable: boolean;
}

/**
 * Derived geofence signal — separates the valuable "filed off-location" flag
 * from the org/cluster access check. `distanceM` is the capture-to-store
 * distance in metres (geofence_fail only); the review UI shows it on the card
 * and in the approve-confirm dialog.
 */
export interface ReviewGeofenceSignal {
  state: "fail" | "unverified" | "ok";
  distanceM: number | null;
}

export interface ReviewQueue {
  items: ReviewQueueItem[];
  /** Total in-queue count (before limit) for the header summary. */
  total: number;
}

// ── Severity helpers ──────────────────────────────────────────────────────────

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

function aggregateSeverity(
  score: number,
  features: ContributingFeature[],
): RiskSeverity {
  if (features.some((f) => FRAUD_FEATURES.has(f.feature))) return "fraud";
  if (score >= 60) return "fraud";
  if (score >= 15) return "watch";
  if (features.some((f) => WATCH_FEATURES.has(f.feature))) return "watch";
  return "clean";
}

/**
 * Derive the geofence presence signal from the contributing features. This is
 * the "filed off-location" guard, deliberately separated from the org/cluster
 * access check: `geofence_fail` (GPS outside the store radius, with the
 * capture-to-store distance) vs `geofence_unverified` (store has no coords) vs
 * `ok`. The distance is read from the risk feature detail (`distance_m`),
 * persisted by the risk engine from the haversine of photo GPS → store coords.
 */
function deriveGeofenceSignal(
  features: ContributingFeature[],
): ReviewGeofenceSignal {
  const fail = features.find((f) => f.feature === "geofence_fail");
  if (fail) {
    const dist = fail.detail.distance_m;
    return {
      state: "fail",
      distanceM: typeof dist === "number" ? dist : null,
    };
  }
  if (features.some((f) => f.feature === "geofence_unverified")) {
    return { state: "unverified", distanceM: null };
  }
  return { state: "ok", distanceM: null };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load the reviewer's queue with full per-item context. The main queue query
 * runs under the reviewer's SESSION client (not the service client) so the
 * `writeoffs_select` RLS policy is the gate — reviewers see every row in the
 * human-review queue regardless of location, employees see only their own.
 * Reference data, duplicate candidates (cross-location fraud evidence), and
 * corpus-wide baselines still use the service client by design.
 *
 * Returns risky-first items (risk_score desc, created_at asc).
 */
export async function loadReviewQueue(
  profile: CurrentProfile,
): Promise<ReviewQueue> {
  const service = createServiceClient();
  // Session client — runs as the logged-in reviewer so auth.uid() / get_my_role()
  // are available to RLS. Using the service client here would bypass RLS and
  // hide the policy bug that emptied the queue.
  const userClient = await createClient();

  // ── Main queue rows (risky first), gated by RLS via the session client ───────
  // All three human-review statuses — NOT just one. A freshly routed unverified
  // photo lands in in_review and appears here within a refresh.
  const REVIEW_STATUSES = ["in_review", "dual_control", "on_hold"];
  const { data: rawRows, error } = await userClient
    .from("writeoffs")
    .select(
      "id, status, risk_score, risk_features, qty, unit, comment, value_cost, withholding, created_at, sla_due_at, escalation_tier, assigned_queue, charged_employee_id, submitter_id, reason_code_id, location_id",
    )
    .in("status", REVIEW_STATUSES)
    .order("risk_score", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(QUEUE_LIMIT);

  if (error || !rawRows) {
    console.error("[review-queue] writeoffs load failed:", error?.message);
    return { items: [], total: 0 };
  }
  const rows = rawRows as Array<{
    id: string;
    status: string;
    risk_score: number;
    risk_features: Json | null;
    qty: number;
    unit: string;
    comment: string | null;
    value_cost: number | null;
    withholding: boolean;
    created_at: string;
    sla_due_at: string | null;
    escalation_tier: EscalationTier | null;
    assigned_queue: string | null;
    charged_employee_id: string | null;
    submitter_id: string;
    reason_code_id: string;
    location_id: string;
  }>;

  // Dev-only: surface the raw query-result count server-side so a
  // query-returns-rows / renders-nothing mismatch is visible in the terminal.
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[review-queue] role=${profile.role} uid=${profile.id} statuses=${REVIEW_STATUSES.join(",")} returned=${rows.length}`,
    );
  }

  if (rows.length === 0) return { items: [], total: 0 };

  const ids = rows.map((r) => r.id);
  const reasonIds = Array.from(new Set(rows.map((r) => r.reason_code_id)));
  const locationIds = Array.from(new Set(rows.map((r) => r.location_id)));
  const employeeIds = Array.from(
    new Set(rows.map((r) => r.charged_employee_id).filter(Boolean) as string[]),
  );
  const submitterIds = Array.from(new Set(rows.map((r) => r.submitter_id)));

  // ── Parallel: reasons, locations, employees, submitters, photos, events ──────
  const [reasons, locations, employees, submitters, photos, events, total] =
    await Promise.all([
      fetchReasons(service, reasonIds),
      fetchStores(service, locationIds),
      fetchEmployees(service, employeeIds),
      fetchSubmitters(service, submitterIds),
      fetchPhotosForWriteoffs(service, ids),
      fetchEventsForWriteoffs(service, ids),
      countInQueue(userClient, profile),
    ]);

  // ── Index photos + events by writeoff id ─────────────────────────────────────
  const photosByWriteoff = new Map<string, Array<{
    id: string;
    storage_path: string;
    dup_of: string | null;
    vision_result: Json | null;
  }>>();
  const allQueuePhotoIds: string[] = [];
  for (const p of photos) {
    const arr = photosByWriteoff.get(p.writeoff_id) ?? [];
    arr.push(p);
    photosByWriteoff.set(p.writeoff_id, arr);
    allQueuePhotoIds.push(p.id);
  }

  const eventsByWriteoff = new Map<string, Array<{ feature: string; detail: Json | null }>>();
  for (const e of events) {
    const arr = eventsByWriteoff.get(e.writeoff_id) ?? [];
    arr.push(e);
    eventsByWriteoff.set(e.writeoff_id, arr);
  }

  // ── Resolve duplicate candidates (dup_of → candidate photo + its writeoff) ────
  const dupPhotoIds = Array.from(
    new Set(
      photos
        .map((p) => p.dup_of)
        .filter((x): x is string => x != null),
    ),
  );
  const dupCandidates = await fetchDupCandidates(service, dupPhotoIds);

  // ── Signed URLs in one batch (queue photos + candidate photos) ───────────────
  const candidatePaths = dupCandidates.map((c) => c.storagePath);
  const queuePaths = photos.map((p) => p.storage_path);
  const allPaths = Array.from(new Set([...queuePaths, ...candidatePaths]));
  const signedUrls = await createSignedUrls(userClient, allPaths);
  const urlByPath = new Map<string, string>();
  for (let i = 0; i < allPaths.length; i++) {
    urlByPath.set(allPaths[i], signedUrls[i]);
  }
  const candidatePhotoById = new Map(dupCandidates.map((c) => [c.photoId, c]));

  // ── Baselines cache (per location+employee) ──────────────────────────────────
  const baselineCache = new Map<string, RiskBaselines>();
  async function baselinesFor(
    locationId: string,
    chargedEmployeeId: string | null,
    writeoffId: string,
  ): Promise<RiskBaselines> {
    const key = `${locationId}|${chargedEmployeeId ?? "—"}`;
    const cached = baselineCache.get(key);
    if (cached) return cached;
    const b = await computeBaselines({
      writeoffId,
      locationId,
      chargedEmployeeId,
      service,
    });
    baselineCache.set(key, b);
    return b;
  }

  // ── Assemble items ───────────────────────────────────────────────────────────
  const items: ReviewQueueItem[] = [];
  for (const row of rows) {
    const reason = reasons.get(row.reason_code_id);
    const location = locations.get(row.location_id);
    const employee = row.charged_employee_id
      ? employees.get(row.charged_employee_id) ?? null
      : null;
    const submitter = submitters.get(row.submitter_id);

    const features = parseRiskFeatures(row.risk_features);
    const severity = aggregateSeverity(row.risk_score, features);
    const geofence = deriveGeofenceSignal(features);
    const redFlags: ReviewRedFlag[] = features.map((f) => ({
      feature: f.feature,
      points: f.points,
      severity: featureSeverity(f.feature),
      detail: f.detail,
    }));

    const photosForRow = photosByWriteoff.get(row.id) ?? [];
    const primaryPhoto = photosForRow[0]
      ? {
          id: photosForRow[0].id,
          url: urlByPath.get(photosForRow[0].storage_path) ?? null,
          dupOf: photosForRow[0].dup_of,
          vision: parseVisionSummary(photosForRow[0].vision_result),
        }
      : null;

    // Dup candidate for the primary photo.
    let dupCandidate: ReviewDupCandidate | null = null;
    if (primaryPhoto?.dupOf) {
      const cand = candidatePhotoById.get(primaryPhoto.dupOf);
      if (cand) {
        const ev = (eventsByWriteoff.get(row.id) ?? []).find(
          (x) => x.feature === "phash_dup_hit",
        );
        const dist = ev?.detail ? readNumber(ev.detail, "distance") : null;
        dupCandidate = {
          writeoffId: cand.writeoffId,
          photoUrl: urlByPath.get(cand.storagePath) ?? null,
          submittedAt: cand.submittedAt,
          reasonLabel: cand.reasonLabel,
          submitterName: cand.submitterName,
          hammingDistance: dist,
        };
      }
    }

    const b = await baselinesFor(
      row.location_id,
      row.charged_employee_id,
      row.id,
    );
    const rates: ReviewRates = {
      employeeRate: b.employeeRate,
      employeeBaseline: b.locationPerEmployeeRate,
      employeeFactor:
        b.locationPerEmployeeRate > 0
          ? b.employeeRate / b.locationPerEmployeeRate
          : null,
      locationRate: b.locationRate,
      locationBaseline: b.chainPerLocationRate,
      locationFactor:
        b.chainPerLocationRate > 0
          ? b.locationRate / b.chainPerLocationRate
          : null,
    };

    items.push({
      id: row.id,
      status: row.status as WriteoffStatus,
      riskScore: row.risk_score,
      severity,
      redFlags,
      qty: row.qty,
      unit: row.unit,
      comment: row.comment,
      valueCost: row.value_cost,
      withholding: row.withholding,
      createdAt: row.created_at,
      slaDueAt: row.sla_due_at,
      escalationTier: row.escalation_tier,
      assignedQueue: row.assigned_queue,
      reason: reason
        ? { key: reason.key, labelRu: reason.label_ru, category: reason.category }
        : { key: "", labelRu: "—", category: "—" },
      location: location
        ? { id: location.id, name: location.name }
        : { id: row.location_id, name: "—" },
      chargedEmployee: employee
        ? {
            id: employee.id,
            fullName: employee.full_name,
            position: employee.position,
          }
        : null,
      submitter: submitter
        ? { id: submitter.id, fullName: submitter.full_name }
        : { id: row.submitter_id, fullName: "—" },
      photo: primaryPhoto,
      dupCandidate,
      rates,
      geofence,
      bulkApprovable:
        severity === "clean" &&
        row.status !== "dual_control" &&
        !row.withholding,
    });
  }

  return { items, total };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;

async function fetchReasons(
  service: Service,
  ids: string[],
): Promise<Map<string, { key: string; label_ru: string; category: string }>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await service
    .from("reason_codes")
    .select("id, key, label_ru, category")
    .in("id", ids);
  if (error || !data) return new Map();
  const map = new Map<string, { key: string; label_ru: string; category: string }>();
  for (const r of data as Array<{ id: string; key: string; label_ru: string; category: string }>) {
    map.set(r.id, { key: r.key, label_ru: r.label_ru, category: r.category });
  }
  return map;
}

async function fetchStores(
  service: Service,
  ids: string[],
): Promise<Map<string, { id: string; name: string }>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await service
    .from("stores")
    .select("id, name")
    .in("id", ids);
  if (error || !data) return new Map();
  const map = new Map<string, { id: string; name: string }>();
  for (const r of data as Array<{ id: string; name: string }>) {
    map.set(r.id, { id: r.id, name: r.name });
  }
  return map;
}

async function fetchEmployees(
  service: Service,
  ids: string[],
): Promise<Map<string, { id: string; full_name: string; position: string | null }>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await service
    .from("employees")
    .select("id, full_name, position")
    .in("id", ids);
  if (error || !data) return new Map();
  const map = new Map<string, { id: string; full_name: string; position: string | null }>();
  for (const r of data as Array<{ id: string; full_name: string; position: string | null }>) {
    map.set(r.id, { id: r.id, full_name: r.full_name, position: r.position });
  }
  return map;
}

async function fetchSubmitters(
  service: Service,
  ids: string[],
): Promise<Map<string, { id: string; full_name: string }>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await service
    .from("profiles")
    .select("id, full_name")
    .in("id", ids);
  if (error || !data) return new Map();
  const map = new Map<string, { id: string; full_name: string }>();
  for (const r of data as Array<{ id: string; full_name: string }>) {
    map.set(r.id, { id: r.id, full_name: r.full_name });
  }
  return map;
}

async function fetchPhotosForWriteoffs(
  service: Service,
  writeoffIds: string[],
): Promise<Array<{ id: string; writeoff_id: string; storage_path: string; dup_of: string | null; vision_result: Json | null }>> {
  if (writeoffIds.length === 0) return [];
  const { data, error } = await service
    .from("writeoff_photos")
    .select("id, writeoff_id, storage_path, dup_of, vision_result")
    .in("writeoff_id", writeoffIds)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as Array<{
    id: string;
    writeoff_id: string;
    storage_path: string;
    dup_of: string | null;
    vision_result: Json | null;
  }>;
}

async function fetchEventsForWriteoffs(
  service: Service,
  writeoffIds: string[],
): Promise<Array<{ writeoff_id: string; feature: string; detail: Json | null }>> {
  if (writeoffIds.length === 0) return [];
  const { data, error } = await service
    .from("risk_events")
    .select("writeoff_id, feature, detail")
    .in("writeoff_id", writeoffIds);
  if (error || !data) return [];
  return data as Array<{ writeoff_id: string; feature: string; detail: Json | null }>;
}

interface DupCandidateRow {
  photoId: string;
  storagePath: string;
  writeoffId: string;
  submittedAt: string;
  reasonLabel: string;
  submitterName: string;
}

/**
 * Resolve dup_of photo ids → the candidate photo + its writeoff's reason,
 * submitter, and submitted-at. Cross-location by design (service role): a
 * re-used spoilage photo from another site is exactly the fraud evidence the
 * reviewer needs to see side-by-side.
 */
async function fetchDupCandidates(
  service: Service,
  photoIds: string[],
): Promise<DupCandidateRow[]> {
  if (photoIds.length === 0) return [];
  const { data: photoRows, error } = await service
    .from("writeoff_photos")
    .select("id, storage_path, writeoff_id")
    .in("id", photoIds);
  if (error || !photoRows) return [];
  const photos = photoRows as Array<{
    id: string;
    storage_path: string;
    writeoff_id: string;
  }>;
  const writeoffIds = Array.from(new Set(photos.map((p) => p.writeoff_id)));

  const { data: wRows } = await service
    .from("writeoffs")
    .select("id, created_at, reason_code_id, submitter_id")
    .in("id", writeoffIds);
  const wMap = new Map(
    (wRows ?? []).map((r) => [
      (r as { id: string }).id,
      r as { id: string; created_at: string; reason_code_id: string; submitter_id: string },
    ]),
  );

  const reasonIds = Array.from(
    new Set(
      Array.from(wMap.values()).map((w) => w.reason_code_id),
    ),
  );
  const submitterIds = Array.from(
    new Set(Array.from(wMap.values()).map((w) => w.submitter_id)),
  );
  const [reasons, submitters] = await Promise.all([
    fetchReasons(service, reasonIds),
    fetchSubmitters(service, submitterIds),
  ]);

  return photos.map((p) => {
    const w = wMap.get(p.writeoff_id);
    const reason = w ? reasons.get(w.reason_code_id) : null;
    const submitter = w ? submitters.get(w.submitter_id) : null;
    return {
      photoId: p.id,
      storagePath: p.storage_path,
      writeoffId: p.writeoff_id,
      submittedAt: w?.created_at ?? "",
      reasonLabel: reason?.label_ru ?? "—",
      submitterName: submitter?.full_name ?? "—",
    };
  });
}

async function countInQueue(
  userClient: Awaited<ReturnType<typeof createClient>>,
  _profile: CurrentProfile,
): Promise<number> {
  // Run under the session client so the count reflects what RLS lets the
  // reviewer see (the whole human-review queue, cross-location). No manual
  // location filter — that was the bug that returned 0 for reviewers.
  const { count, error } = await userClient
    .from("writeoffs")
    .select("id", { count: "exact", head: true })
    .in("status", ["in_review", "dual_control", "on_hold"]);
  if (error) {
    console.error("[review-queue] count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

async function createSignedUrls(
  userClient: Awaited<ReturnType<typeof createClient>>,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  // createSignedUrls returns one signed url per path in order.
  const { data, error } = await userClient.storage
    .from(PHOTOS_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SEC);
  if (error || !data) {
    console.error("[review-queue] signed urls failed:", error?.message);
    return paths.map(() => "");
  }
  // Map back to input order (supabase returns {path, signedUrl} per input path).
  const byPath = new Map<string, string>();
  for (const r of data as Array<{ path?: string; signedUrl?: string }>) {
    if (r.path && r.signedUrl) byPath.set(r.path, r.signedUrl);
  }
  return paths.map((p) => byPath.get(p) ?? "");
}

// ── JSON coercion ─────────────────────────────────────────────────────────────

function parseRiskFeatures(raw: Json | null): ContributingFeature[] {
  if (!raw || !Array.isArray(raw)) return [];
  const out: ContributingFeature[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const feature = typeof obj.feature === "string" ? obj.feature : "";
    const points = typeof obj.points === "number" ? obj.points : 0;
    if (!feature) continue;
    out.push({
      feature: feature as ContributingFeature["feature"],
      points,
      detail: normalizeDetail(obj.detail),
    });
  }
  return out;
}

function normalizeDetail(
  raw: unknown,
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

function readNumber(raw: Json | null, key: string): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return typeof obj[key] === "number" ? (obj[key] as number) : null;
}

function parseVisionSummary(raw: Json | null): ReviewVisionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "ok" && verdict !== "mismatch" && verdict !== "inconclusive") {
    return null;
  }
  return {
    verdict,
    matchesProduct:
      typeof obj.matches_product === "boolean" ? obj.matches_product : null,
    matchesDefect:
      typeof obj.matches_defect === "boolean" ? obj.matches_defect : null,
    confidence: typeof obj.confidence === "number" ? obj.confidence : null,
    visibleQty:
      typeof obj.visible_qty === "number" ? obj.visible_qty : null,
    notes: typeof obj.notes === "string" ? obj.notes : null,
  };
}
