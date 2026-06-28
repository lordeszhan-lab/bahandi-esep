/**
 * Seed a realistic 2-week write-off history across a representative slice of
 * stores — Prompt C (fast bulk edition).
 *
 * The network is real but empty: on stage the Tower, the cockpit, risk and
 * routing would all show nothing. This synthesises ~14 days of write-offs for
 * ~15 representative stores (spanning every format + the main cities, several
 * kiosks) so the whole pipeline lights up:
 *
 *   • volume per store drawn from its format baseline (kiosks low, malls higher)
 *   • reason mix follows the format profile (kiosks → accidental + breakage;
 *     malls → spoilage + quality; magnum → quality/return; market → spoilage)
 *   • realistic qty/value per reason, timestamps spread across business hours,
 *     mostly "без удержания"
 *   • ~8% adversarial cases so the risk engine visibly works:
 *       - photo-reuse (shared pHash across 2–3 write-offs at a kiosk) → phash_dup_hit
 *       - mismatch / dark-photo → vision_mismatch / vision_unverified
 *       - off-geofence → geofence_fail
 *
 * SPEED: demo data does NOT need real LLM vision or Iiko HTTP. This script makes
 * ZERO network calls — it computes each write-off's risk score + routed status
 * with the SAME pure functions the live system uses (`scoreWriteoff` +
 * `decideRoute` + `computeSlaDueAt`), writes canned `vision_result` + a sandbox
 * `iiko_act_ledger` row for auto-approved rows, builds a hash-chained audit
 * batch in memory, and bulk-inserts everything (500 rows per insert). Same
 * realistic end-state as the live pipeline, in seconds.
 *
 * One kiosk is concentrated as the "problem store": normal-looking traffic but
 * an elevated `theoretical_usage` proxy → a clear unexplained-gap outlier the
 * Tower can point at on stage.
 *
 * Idempotent: every generated row carries `seeded = true` with a deterministic
 * id. Re-runs DELETE the prior seeded cohort (iiko ledger + risk_events +
 * photos + writeoffs; audit rows are left in place so the global hash chain is
 * never broken — their writeoff_id is SET NULL by the cascade) and re-insert.
 * `store_usage_proxy` is upserted per demo store.
 *
 * Run: npm run seed:history   (tsx scripts/seed-history.ts)
 * Service-role only — never expose the key to the browser.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { createServiceClient } from "../src/lib/supabase/service";
import { deterministicFakeGuid } from "../src/lib/iiko/fake-guid";
import {
  RISK_FEATURE_WEIGHTS,
  scoreWriteoff,
  type RiskBaselines,
  type RiskEventInput,
  type RiskLocationInput,
  type RiskPhotoInput,
  type RiskWriteoffInput,
} from "../src/lib/risk/score";
import { computeSlaDueAt, decideRoute } from "../src/lib/workflow/route";
import { computeAuditHash, type AuditRecord } from "../src/lib/audit";
import {
  buildDeductionBasis,
  computeDeductionAmount,
} from "../src/lib/deductions/config";
import type { EscalationTier, Json, StoreFormat, WriteoffStatus } from "../src/lib/db/types";

// ── Tuning ────────────────────────────────────────────────────────────────────

const WINDOW_DAYS = 14;
const SEED_NAMESPACE = "bahandi-seed-history-v1";
const PHOTOS_BUCKET_NOTE = "seed/"; // storage_path prefix (no real file is uploaded)
const INSERT_CHUNK = 1000;

/** How many approved-withholding write-offs get a visible deduction case on the
 *  Удержания screen. One is seeded as `acknowledged` (e-signed), the rest as
 *  `proposed` — the pending-acknowledgment queue lights up on load. */
const DEDUCTION_CASE_COUNT = 4;

/** Reason-code ids (fixed in supabase/seed.sql). */
const REASON_ID: Record<ReasonKey, string> = {
  yield: "33333333-0000-0000-0000-000000000001",
  quality: "33333333-0000-0000-0000-000000000002",
  accidental: "33333333-0000-0000-0000-000000000003",
  spoilage: "33333333-0000-0000-0000-000000000004",
  return: "33333333-0000-0000-0000-000000000005",
  breakage: "33333333-0000-0000-0000-000000000006",
};

const DEDUCTION_REASONS: ReadonlySet<ReasonKey> = new Set(["accidental", "breakage"]);

/** Format daily volume (write-offs/day) — mirrors seed-baselines.ts. */
const VOLUME_PER_DAY: Record<StoreFormat, number> = {
  kiosk: 0.8,
  street: 1.2,
  market: 1.5,
  mall: 2.5,
  magnum: 4,
};

/** Per-format high-value cut (KZT) — mirrors seed-baselines.ts. */
const HIGH_VALUE: Record<StoreFormat, number> = {
  kiosk: 15_000,
  street: 20_000,
  market: 30_000,
  mall: 60_000,
  magnum: 120_000,
};

/** Format-aware geofence radius (m) — mirrors import-stores.ts. */
const RADIUS_BY_FORMAT: Record<StoreFormat, number> = {
  kiosk: 75,
  market: 100,
  street: 120,
  mall: 180,
  magnum: 150,
};

/** Reason mix per format (weights sum to 1). Follows the format profile. */
const REASON_MIX: Record<StoreFormat, Array<[ReasonKey, number]>> = {
  kiosk: [["accidental", 0.35], ["breakage", 0.3], ["spoilage", 0.1], ["yield", 0.15], ["quality", 0.05], ["return", 0.05]],
  street: [["accidental", 0.25], ["spoilage", 0.25], ["breakage", 0.2], ["yield", 0.15], ["quality", 0.1], ["return", 0.05]],
  market: [["spoilage", 0.35], ["accidental", 0.2], ["breakage", 0.15], ["yield", 0.15], ["quality", 0.1], ["return", 0.05]],
  mall: [["spoilage", 0.3], ["quality", 0.2], ["accidental", 0.15], ["breakage", 0.15], ["yield", 0.1], ["return", 0.1]],
  magnum: [["quality", 0.25], ["return", 0.2], ["spoilage", 0.2], ["accidental", 0.1], ["breakage", 0.1], ["yield", 0.15]],
};

/** qty range + price-per-unit per reason → realistic KZT value_cost. */
const REASON_VALUE: Record<ReasonKey, { unit: string; qtyMin: number; qtyMax: number; priceMin: number; priceMax: number }> = {
  yield: { unit: "кг", qtyMin: 0.5, qtyMax: 5, priceMin: 300, priceMax: 900 },
  quality: { unit: "кг", qtyMin: 0.3, qtyMax: 4, priceMin: 1200, priceMax: 3500 },
  accidental: { unit: "шт", qtyMin: 1, qtyMax: 6, priceMin: 1500, priceMax: 6000 },
  spoilage: { unit: "кг", qtyMin: 0.5, qtyMax: 12, priceMin: 800, priceMax: 3500 },
  return: { unit: "порц", qtyMin: 1, qtyMax: 4, priceMin: 400, priceMax: 1200 },
  breakage: { unit: "шт", qtyMin: 1, qtyMax: 10, priceMin: 1200, priceMax: 4000 },
};

const REASON_COMMENT: Record<ReasonKey, string> = {
  yield: "технологический выход по карте",
  quality: "брак по качеству, списано по акту",
  accidental: "случайное повреждение при работе",
  spoilage: "истёк срок годности",
  return: "возврат от гостя",
  breakage: "бой посуды при смене",
};

/** RU reason-code labels — mirror supabase/seed.sql (used for deduction basis text). */
const REASON_LABEL: Record<ReasonKey, string> = {
  yield: "Технологический выход",
  quality: "Брак качества",
  accidental: "Случайное повреждение",
  spoilage: "Порча / срок годности",
  return: "Возврат гостя",
  breakage: "Бой / Битая посуда",
};

/** Approximate city centres (lat, lng) — used only when a demo store has no coords yet. */
const CITY_CENTER: Record<string, [number, number]> = {
  Алматы: [43.2566, 76.9286],
  Астана: [51.1694, 71.4491],
  Шымкент: [42.3417, 69.5901],
  Караганда: [49.8047, 73.1094],
  Актау: [43.6525, 51.159],
  Костанай: [53.1959, 63.6259],
  Актобе: [50.2839, 57.167],
  Атырау: [47.0945, 51.9238],
  "Усть-Каменогорск": [49.97, 82.601],
  Кокшетау: [53.285, 69.393],
  Тараз: [42.9039, 71.367],
};

/** Representative slice: span every format + the main cities, several kiosks. */
const TARGETS: Array<{ city: string; format: StoreFormat; problem?: boolean }> = [
  { city: "Алматы", format: "kiosk", problem: true }, // the problem kiosk
  { city: "Алматы", format: "kiosk" },
  { city: "Алматы", format: "kiosk" },
  { city: "Алматы", format: "mall" },
  { city: "Алматы", format: "magnum" },
  { city: "Алматы", format: "market" },
  { city: "Астана", format: "kiosk" },
  { city: "Астана", format: "mall" },
  { city: "Шымкент", format: "kiosk" },
  { city: "Шымкент", format: "mall" },
  { city: "Караганда", format: "kiosk" },
  { city: "Актау", format: "mall" },
  { city: "Костанай", format: "mall" },
  { city: "Актобе", format: "mall" },
  { city: "Атырау", format: "mall" },
  { city: "Усть-Каменогорск", format: "mall" },
  { city: "Кокшетау", format: "mall" },
  { city: "Тараз", format: "mall" },
];

const ADVERSARIAL_RATE = 0.08;
/** Problem kiosk: theoretical_usage = documented_loss + this (the gap outlier). */
const PROBLEM_GAP_BUMP = 220_000;
/** Other demo stores: theoretical_usage = documented_loss * (1 + this). */
const NORMAL_GAP_RATE = 0.06;

/** Neutral baselines — the rate features don't fire on cold-start demo data; the
 *  adversarial events + geofence + high_value + odd_hour drive the score, exactly
 *  as the live scorer degrades when a store has no history yet. */
const NEUTRAL_BASELINES: RiskBaselines = {
  employeeRate: 0,
  locationPerEmployeeRate: 0,
  locationRate: 0,
  chainPerLocationRate: 0,
  repeatedChargeCount: 0,
};

// ── Types ─────────────────────────────────────────────────────────────────────

type ReasonKey = "yield" | "quality" | "accidental" | "spoilage" | "return" | "breakage";

interface StoreRow {
  id: string;
  name: string;
  display_name: string | null;
  format: StoreFormat | null;
  city: string | null;
  city_id: string | null;
  cluster_id: string | null;
  lat: number | null;
  lng: number | null;
  geofence_radius_m: number | null;
}

type AdvKind = "phash_orig" | "phash_reuse" | "vision_mismatch" | "vision_unverified" | "geofence_fail";

interface PlannedWriteoff {
  id: string;
  photoId: string;
  store: StoreRow;
  createdMs: number;
  createdIso: string;
  reason: ReasonKey;
  qty: number;
  unit: string;
  valueCost: number;
  withholding: boolean;
  chargedEmployeeId: string | null;
  /** GPS for the photo (in-geofence by default; far when off-geofence). */
  gpsLat: number;
  gpsLng: number;
  adv?: { kind: AdvKind; sharedPhash?: string; origPhotoId?: string };
  /** When set, this write-off is promoted to `approved` and a `deductions` row
   *  is opened against `chargedEmployeeId` so the Удержания screen has a case. */
  deductionCase?: { status: "proposed" | "acknowledged"; signatureName?: string };
}

// ── Deterministic helpers ─────────────────────────────────────────────────────

/** SHA-1 derived UUID v4-flavour (deterministic) from a kind + key. */
function detUuid(kind: string, key: string): string {
  const h = createHash("sha1").update(`${SEED_NAMESPACE}:${kind}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-a${h.slice(15, 18)}-${h.slice(18, 30)}`;
}

/** Deterministic pHash-like 16-char hex string from a seed. */
function detPhash(seed: string): string {
  return createHash("sha1").update(`phash:${seed}`).digest("hex").slice(0, 16);
}

/**
 * Realistic Kazakh full names for the per-store demo employees. Picked
 * deterministically from the store id so re-runs are stable and the Удержания
 * cards show a real charged employee, not a "Сотрудник · <store>" placeholder.
 */
const EMPLOYEE_NAMES = [
  "Асель Мамытова",
  "Серик Джаксыбеков",
  "Айгерим Бекова",
  "Даурен Сейткали",
  "Нургуль Ахметова",
  "Бахытжан Калиев",
  "Зульфия Исмаилова",
  "Темирхан Уразов",
  "Газиза Нурмаханова",
  "Адиль Рахимов",
  "Малика Серикбаева",
  "Ерлан Толепов",
  "Дана Касымова",
  "Канат Байжанов",
];

/** Deterministic real-looking full name for a store's demo employee. */
function employeeNameFor(storeId: string): string {
  const h = createHash("sha1").update(`empname:${storeId}`).digest("hex");
  return EMPLOYEE_NAMES[parseInt(h.slice(0, 8), 16) % EMPLOYEE_NAMES.length];
}

/** Deterministic monthly salary (KZT) for a store's demo employee — realistic
 *  250 000–400 000 ₸ band, stable across re-runs so the deduction cap is reproducible. */
const SALARY_BAND = [250_000, 280_000, 300_000, 320_000, 350_000, 380_000, 400_000];
function employeeSalaryFor(storeId: string): number {
  const h = createHash("sha1").update(`empsal:${storeId}`).digest("hex");
  return SALARY_BAND[parseInt(h.slice(0, 8), 16) % SALARY_BAND.length];
}

/** Mulberry32 PRNG — deterministic from a numeric seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string → a 32-bit seed for the PRNG. */
function seedFrom(s: string): number {
  const h = createHash("sha1").update(s).digest();
  return h.readUInt32BE(0);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function pickWeighted<T>(rng: () => number, items: Array<[T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r <= 0) return v;
  }
  return items[items.length - 1][0];
}
function poisson(rng: () => number, lambda: number): number {
  // Knuth's algorithm — fine for small lambda.
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// ── Main ──────────────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>;

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const service = createServiceClient();
  const t0 = Date.now();

  // ── Load stores + the admin (submitter) in parallel ─────────────────────────
  const [stores, submitterId] = await Promise.all([loadStores(service), resolveSubmitter(service)]);
  if (stores.length === 0) {
    console.error("[seed-history] no active stores — run `npm run import:stores` first.");
    process.exit(1);
  }
  if (!submitterId) {
    console.error("[seed-history] no profile found — run `npm run seed:users` first.");
    process.exit(1);
  }

  // ── Resolve the representative slice ─────────────────────────────────────────
  const picked = pickTargetStores(stores);
  if (picked.length === 0) {
    console.error("[seed-history] could not match any target (city, format) — check stores are enriched.");
    process.exit(1);
  }
  const problemStore = picked.find((p) => p.problem)?.store ?? null;
  console.log(
    `[seed-history] picked ${picked.length} stores across ${new Set(picked.map((p) => p.store.city)).size} cities` +
      (problemStore ? `; problem kiosk = ${displayName(problemStore)}` : ""),
  );

  // ── Ensure coords on every demo store so the geofence check is meaningful ────
  await Promise.all(picked.map((p) => ensureGeocoded(service, p.store)));

  // ── Ensure one charged-employee per demo store (single bulk upsert) ──────────
  // monthly_salary seeds a realistic wage so the Art. 115 deduction cap
  // (50% of salary) computes against a real number, not the default fallback.
  const empRows = picked.map((p) => {
    const empId = detUuid("emp", p.store.id);
    p.employeeId = empId;
    return {
      id: empId,
      full_name: employeeNameFor(p.store.id),
      location_id: p.store.id,
      position: "Сменный",
      material_liability: true,
      monthly_salary: employeeSalaryFor(p.store.id),
    };
  });
  const { error: empErr } = await service
    .from("employees")
    .upsert(empRows as unknown as never, { onConflict: "id" });
  if (empErr) console.error("[seed-history] employee bulk upsert failed:", empErr.message);

  // ── Build the plan, then mark ~8% adversarial ────────────────────────────────
  const plan = buildPlan(picked);
  markAdversarial(plan, picked);
  markDeductionCases(plan, picked, DEDUCTION_CASE_COUNT);
  // Chronological so phash-reuse "originals" exist before their reuses (dup_of FK).
  plan.sort((a, b) => a.createdMs - b.createdMs);
  console.log(
    `[seed-history] plan: ${plan.length} write-offs (0 network calls — bulk mode)` +
      `; ${DEDUCTION_CASE_COUNT} approved-withholding → deduction cases`,
  );

  // ── Idempotent reset: delete the prior seeded cohort ──────────────────────────
  // audit_log is intentionally NOT touched — deleting mid-chain rows would break
  // the global hash chain. writeoffs ON DELETE SET NULL orphans their audit rows
  // (harmless; the per-writeoff + global chains still verify).
  await deleteSeededCohort(service, new Set(plan.map((w) => w.id)));

  // ── Audit chain head (most recent row by created_at, then id) ────────────────
  const prevHash = await readAuditHead(service);

  // ── Compute every row in memory with the PURE pipeline functions ─────────────
  const auditBaseMs = Date.now() + 1000; // strictly after any existing audit row
  const writeoffRows: Record<string, unknown>[] = [];
  const photoRows: Record<string, unknown>[] = [];
  const riskEventRows: Record<string, unknown>[] = [];
  const iikoLedgerRows: Record<string, unknown>[] = [];
  const deductionRows: Record<string, unknown>[] = [];
  const auditRows: Record<string, unknown>[] = [];

  let auditIdx = 0;
  let prev = prevHash;
  let failed = 0;

  for (const w of plan) {
    try {
      const c = computeWriteoff(w, submitterId);
      writeoffRows.push(c.writeoffRow);
      photoRows.push(c.photoRow);
      for (const e of c.riskEventRows) riskEventRows.push(e);
      if (c.iikoLedgerRow) iikoLedgerRows.push(c.iikoLedgerRow);
      if (c.deductionRow) deductionRows.push(c.deductionRow);

      // Two hash-chained audit entries (submitted → routed/auto_approved), in order.
      prev = pushAudit(auditRows, {
        writeoffId: w.id,
        actorId: submitterId,
        action: "submitted",
        payload: {
          qty: w.qty,
          unit: w.unit,
          reason_code_id: REASON_ID[w.reason],
          withholding: w.withholding,
          batch_burst: false,
          seeded: true,
        },
        createdAtMs: auditBaseMs + auditIdx,
        prev,
      });
      auditIdx += 1;
      // approved (deduction case) is logged as the reviewer's approve decision,
      // mirroring the live state machine; everything else is the pure route.
      const routeAction =
        c.status === "auto_approved" ? "auto_approved" : c.status === "approved" ? "approved" : "routed";
      prev = pushAudit(auditRows, {
        writeoffId: w.id,
        actorId: c.status === "approved" ? submitterId : null,
        action: routeAction,
        payload: {
          from: "submitted",
          to: c.status,
          score: c.score,
          value: w.valueCost,
          tier: c.tier,
          queue: c.queue,
          sla_due_at: c.slaDueAt,
          reason: c.reason,
          hard_gate_flags: c.hardGateFlags.length > 0 ? c.hardGateFlags.join(",") : undefined,
          seeded: true,
        },
        createdAtMs: auditBaseMs + auditIdx,
        prev,
      });
      auditIdx += 1;
      // A deduction-case-open audit row mirrors maybeCreateDeductionCase, so the
      // tamper-evident trail records the legal case opening alongside the approval.
      if (c.deductionRow) {
        prev = pushAudit(auditRows, {
          writeoffId: w.id,
          actorId: submitterId,
          action: "deduction_case_opened",
          payload: {
            deduction_employee_id: w.chargedEmployeeId,
            deduction_status: w.deductionCase?.status,
            amount: c.deductionRow.amount,
            cap_amount: c.deductionRow.cap_amount,
            value_cost: w.valueCost,
            seeded: true,
          },
          createdAtMs: auditBaseMs + auditIdx,
          prev,
        });
        auditIdx += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`[seed-history] compute failed for ${w.id} (${displayName(w.store)}):`, err instanceof Error ? err.message : err);
    }
  }

  // ── Bulk insert (parents first, then dependents, then audit) ─────────────────
  const _idCounts = new Map<string, number>();
  for (const w of plan) _idCounts.set(w.id, (_idCounts.get(w.id) ?? 0) + 1);
  const _dups = [..._idCounts.entries()].filter(([, n]) => n > 1);
  if (_dups.length > 0) {
    console.error("[seed-history] PLAN HAS DUPLICATE IDS:", _dups.slice(0, 5));
    throw new Error(`[seed-history] plan has ${_dups.length} duplicate ids — first: ${_dups[0][0]} (×${_dups[0][1]})`);
  }
  await preflightNoCollisions(service, new Set(plan.map((w) => w.id)));
  await bulkInsert(service, "writeoffs", writeoffRows); // parents must land first
  // Dependents (photos / risk_events / iiko / deductions / audit) are independent
  // of each other and reference only writeoffs (+ employees, already upserted), so
  // insert them concurrently. deductions has ON DELETE RESTRICT on writeoffs, but
  // the parents are already committed above.
  await Promise.all([
    bulkInsert(service, "writeoff_photos", photoRows),
    riskEventRows.length ? bulkInsert(service, "risk_events", riskEventRows) : Promise.resolve(),
    iikoLedgerRows.length ? bulkInsert(service, "iiko_act_ledger", iikoLedgerRows) : Promise.resolve(),
    deductionRows.length ? bulkInsert(service, "deductions", deductionRows) : Promise.resolve(),
    bulkInsert(service, "audit_log", auditRows),
  ]);

  const created = writeoffRows.length;
  console.log(
    `[seed-history] inserted ${created} write-offs + ${photoRows.length} photos + ${riskEventRows.length} risk_events` +
      ` + ${iikoLedgerRows.length} iiko rows + ${deductionRows.length} deductions + ${auditRows.length} audit rows`,
  );

  // ── Upsert the unexplained-gap proxy per demo store (one bulk upsert) ────────
  const documentedByStore = await computeDocumentedLoss(service, picked.map((p) => p.store.id));
  const proxyRows = picked.map((p) => {
    const documented = documentedByStore.get(p.store.id) ?? 0;
    const theoretical = p.problem
      ? documented + PROBLEM_GAP_BUMP
      : Math.round(documented * (1 + NORMAL_GAP_RATE));
    return {
      store_id: p.store.id,
      theoretical_usage: theoretical,
      window_days: WINDOW_DAYS,
      seeded: true,
    };
  });
  const { error: proxyErr } = await service
    .from("store_usage_proxy" as never)
    .upsert(proxyRows as unknown as never, { onConflict: "store_id" });
  if (proxyErr) console.error("[seed-history] usage proxy bulk upsert failed:", proxyErr.message);

  // ── Summary ──────────────────────────────────────────────────────────────────
  await printSummary(service, { created, skipped: 0, failed, elapsed: Date.now() - t0 });
}

// ── Plan construction ─────────────────────────────────────────────────────────

function buildPlan(
  picked: Array<{ store: StoreRow; problem?: boolean; employeeId: string }>,
): PlannedWriteoff[] {
  const plan: PlannedWriteoff[] = [];
  const now = Date.now();
  const startOfTodayUtc = Math.floor(now / 86_400_000) * 86_400_000;

  for (const p of picked) {
    const store = p.store;
    const fmt = store.format ?? "street";
    const lambda = VOLUME_PER_DAY[fmt] ?? 1;
    const baseLat = store.lat ?? CITY_CENTER[store.city ?? ""]?.[0] ?? 43.2566;
    const baseLng = store.lng ?? CITY_CENTER[store.city ?? ""]?.[1] ?? 76.9286;

    let slot = 0;
    for (let day = 0; day < WINDOW_DAYS; day++) {
      // Deterministic per (store, day): same re-run → same plan.
      const dayRng = mulberry32(seedFrom(`${store.id}:day${day}`));
      const count = Math.max(0, poisson(dayRng, lambda));
      for (let i = 0; i < count; i++) {
        const reason = pickWeighted(dayRng, REASON_MIX[fmt] ?? REASON_MIX.street);
        const v = REASON_VALUE[reason];
        let qty = round1(lerp(v.qtyMin, v.qtyMax, dayRng()));
        if (dayRng() < 0.15) qty = round1(qty * lerp(3, 5, dayRng())); // occasional large write-off
        const price = Math.round(lerp(v.priceMin, v.priceMax, dayRng()));
        const valueCost = Math.max(1, Math.round(qty * price));

        const withholding = DEDUCTION_REASONS.has(reason) && dayRng() < 0.25;
        const chargedEmployeeId = withholding ? p.employeeId : null;

        // Business hours: UTC 03–16 → local 08–21 (KZ UTC+5).
        const utcHour = 3 + dayRng() * 13;
        const createdMs = startOfTodayUtc - (WINDOW_DAYS - 1 - day) * 86_400_000 + utcHour * 3_600_000;
        const createdIso = new Date(createdMs).toISOString();

        // In-geofence GPS: tiny jitter well inside the radius.
        const jitterLat = (dayRng() - 0.5) * 0.0006;
        const jitterLng = (dayRng() - 0.5) * 0.0006;

        const id = detUuid("w", `${store.id}:${day}:${slot}`);
        plan.push({
          id,
          photoId: detUuid("photo", id),
          store,
          createdMs,
          createdIso,
          reason,
          qty,
          unit: v.unit,
          valueCost,
          withholding,
          chargedEmployeeId,
          gpsLat: baseLat + jitterLat,
          gpsLng: baseLng + jitterLng,
        });
        slot += 1;
      }
    }
  }
  return plan;
}

/**
 * Tag ~8% of the plan as adversarial. phash-reuse comes in groups (one original
 * + 2 reuses sharing a pHash, at kiosks); the rest are single vision / geofence
 * cases. Adversarial rows get their value clamped below the format's high-value
 * cut so routing is driven by the hard gate, not by value.
 */
function markAdversarial(
  plan: PlannedWriteoff[],
  picked: Array<{ store: StoreRow; problem?: boolean }>,
): void {
  const total = plan.length;
  const budget = Math.max(8, Math.round(total * ADVERSARIAL_RATE));

  // Kiosks (excluding the problem store) host the phash-reuse groups.
  const kioskStores = picked
    .filter((p) => (p.store.format ?? "street") === "kiosk" && !p.problem)
    .map((p) => p.store);
  const byStore = new Map<string, PlannedWriteoff[]>();
  for (const w of plan) {
    const arr = byStore.get(w.store.id) ?? [];
    arr.push(w);
    byStore.set(w.store.id, arr);
  }

  const tagged = new Set<string>(); // writeoff ids already adversarial
  let spent = 0;

  // ── phash-reuse groups (each group = 1 original + 2 reuses = 3 writeoffs) ────
  const groupCount = Math.max(2, Math.floor((budget * 0.45) / 3));
  let groupsMade = 0;
  for (const store of kioskStores) {
    if (groupsMade >= groupCount || spent + 3 > budget + 3) break;
    const rows = (byStore.get(store.id) ?? []).slice().sort((a, b) => a.createdMs - b.createdMs);
    if (rows.length < 3) continue;
    const group = rows.slice(0, 3); // earliest = original
    const sharedPhash = detPhash(`${store.id}:reuse:${groupsMade}`);
    const [orig, ...reuses] = group;
    orig.adv = { kind: "phash_orig", sharedPhash };
    tagged.add(orig.id);
    for (const r of reuses) {
      r.adv = { kind: "phash_reuse", sharedPhash, origPhotoId: orig.photoId };
      tagged.add(r.id);
      clampValue(r, store.format ?? "kiosk");
    }
    spent += 3;
    groupsMade += 1;
  }

  // ── remaining budget → vision_mismatch / vision_unverified / geofence_fail ───
  const remaining = budget - spent;
  const pool = plan.filter((w) => !tagged.has(w.id));
  // Seeded shuffle → reproducible adversarial selection across runs.
  shuffle(pool, mulberry32(seedFrom("adv-shuffle-v1")));
  let visionMismatch = Math.ceil(remaining * 0.35);
  let visionUnverified = Math.ceil(remaining * 0.30);
  let geofence = remaining - visionMismatch - visionUnverified;
  for (const w of pool) {
    if (visionMismatch > 0) {
      w.adv = { kind: "vision_mismatch" };
      clampValue(w, w.store.format ?? "street");
      visionMismatch -= 1;
    } else if (visionUnverified > 0) {
      w.adv = { kind: "vision_unverified" };
      clampValue(w, w.store.format ?? "street");
      visionUnverified -= 1;
    } else if (geofence > 0) {
      w.adv = { kind: "geofence_fail" };
      clampValue(w, w.store.format ?? "street");
      // Move the photo well outside the geofence (~5.5km).
      w.gpsLat = (w.store.lat ?? 43.2566) + 0.05;
      w.gpsLng = (w.store.lng ?? 76.9286) + 0.05;
      geofence -= 1;
    } else {
      break;
    }
  }
}

function clampValue(w: PlannedWriteoff, fmt: StoreFormat): void {
  const cut = HIGH_VALUE[fmt] ?? 50_000;
  w.valueCost = Math.max(500, Math.round(cut * 0.4));
}

/**
 * Promote `count` clean (non-adversarial) write-offs to approved withholding
 * cases with an open deduction, so the Удержания screen has visible cases on
 * load. Cases are spread one-per-store (round-robin, chronological within a
 * store) for a representative surface. The first case is seeded as
 * `acknowledged` (e-signed, the post-ack approve queue); the rest stay
 * `proposed` (the pending-acknowledgment queue). Each chosen write-off is forced
 * to `withholding = true` against its store's seeded employee — deterministic,
 * so re-runs pick the same cases.
 */
function markDeductionCases(
  plan: PlannedWriteoff[],
  picked: Array<{ store: StoreRow; employeeId: string }>,
  count: number,
): void {
  if (count <= 0) return;
  const empByStore = new Map(picked.map((p) => [p.store.id, p.employeeId]));

  // Non-adversarial candidates grouped by store, chronological within each store.
  const byStore = new Map<string, PlannedWriteoff[]>();
  for (const w of plan) {
    if (w.adv) continue;
    const arr = byStore.get(w.store.id) ?? [];
    arr.push(w);
    byStore.set(w.store.id, arr);
  }
  for (const arr of byStore.values()) arr.sort((a, b) => a.createdMs - b.createdMs);

  // Deterministic store order → reproducible picks across runs.
  const storeOrder = [...byStore.keys()].sort();

  const chosen: PlannedWriteoff[] = [];
  let depth = 0;
  while (chosen.length < count) {
    let progressed = false;
    for (const storeId of storeOrder) {
      const arr = byStore.get(storeId) ?? [];
      if (arr.length > depth) {
        chosen.push(arr[depth]);
        progressed = true;
        if (chosen.length >= count) break;
      }
    }
    if (!progressed) break; // ran out of candidates
    depth += 1;
  }

  for (let i = 0; i < chosen.length; i++) {
    const w = chosen[i];
    w.withholding = true;
    w.chargedEmployeeId = empByStore.get(w.store.id) ?? w.chargedEmployeeId;
    w.deductionCase =
      i === 0
        ? { status: "acknowledged", signatureName: employeeNameFor(w.store.id) }
        : { status: "proposed" };
  }

  if (chosen.length < count) {
    console.warn(`[seed-history] only ${chosen.length} deduction cases could be seeded (asked ${count})`);
  }
}

/** Fisher–Yates shuffle. Pass a seeded rng for a reproducible ordering. */
function shuffle<T>(arr: T[], rng: () => number = Math.random): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── In-memory pipeline (pure functions, zero network) ─────────────────────────

interface ComputedWriteoff {
  writeoffRow: Record<string, unknown>;
  photoRow: Record<string, unknown>;
  riskEventRows: Record<string, unknown>[];
  iikoLedgerRow: Record<string, unknown> | null;
  deductionRow: Record<string, unknown> | null;
  score: number;
  status: WriteoffStatus;
  tier: EscalationTier | null;
  queue: string;
  slaDueAt: string | null;
  reason: string;
  hardGateFlags: string[];
}

/** Compute one write-off's score, route, photo, risk_events, iiko ledger — no I/O. */
function computeWriteoff(w: PlannedWriteoff, submitterId: string): ComputedWriteoff {
  const fmt = w.store.format ?? "street";

  // ── Photo row (gps, phash, dup_of, canned vision_result) ─────────────────────
  const photoRow: Record<string, unknown> = {
    id: w.photoId,
    writeoff_id: w.id,
    storage_path: `${PHOTOS_BUCKET_NOTE}${w.id}.jpg`,
    gps_lat: w.gpsLat,
    gps_lng: w.gpsLng,
    captured_at: new Date(w.createdMs - 30_000).toISOString(),
    source: "camera",
    created_at: w.createdIso,
  };
  if (w.adv?.sharedPhash) photoRow.phash = w.adv.sharedPhash;
  if (w.adv?.kind === "phash_reuse" && w.adv.origPhotoId) photoRow.dup_of = w.adv.origPhotoId;

  const vision = visionSnapshot(w);
  if (vision) {
    photoRow.vision_result = visionResultJson(w);
  }

  // ── risk_events that mimic the forensics pipeline (the scorer reads these) ───
  const riskEventRows: Record<string, unknown>[] = [];
  const hardGateFlags: string[] = [];
  const events: RiskEventInput[] = [];

  if (w.adv?.kind === "phash_reuse") {
    pushEvent(riskEventRows, events, hardGateFlags, w.id, "phash_dup_hit", {
      distance: 0,
      threshold: 5,
      matched_photo_id: w.adv.origPhotoId ?? null,
      phash: w.adv.sharedPhash ?? null,
    });
  } else if (w.adv?.kind === "vision_mismatch") {
    pushEvent(riskEventRows, events, hardGateFlags, w.id, "vision_mismatch", {
      verdict: "mismatch",
      matches_product: false,
      confidence: 0.82,
      notes: "на фото другой товар",
    });
  } else if (w.adv?.kind === "vision_unverified") {
    pushEvent(riskEventRows, events, hardGateFlags, w.id, "vision_unverified", {
      verdict: "inconclusive",
      confidence: 0.45,
      cause: "dark_photo",
    });
  } else if (w.adv?.kind === "geofence_fail") {
    const radius = w.store.geofence_radius_m ?? RADIUS_BY_FORMAT[fmt] ?? 120;
    pushEvent(riskEventRows, events, hardGateFlags, w.id, "geofence_fail", {
      photo_index: 0,
      distance_m: 5500,
      radius_m: radius,
    });
  }

  // ── Risk score via the PURE scorer (events + photo GPS + vision + value) ─────
  const writeoffInput: RiskWriteoffInput = {
    id: w.id,
    value_cost: w.valueCost,
    created_at: w.createdIso,
    charged_employee_id: w.chargedEmployeeId,
    location_id: w.store.id,
    withholding: w.withholding,
  };
  const locationInput: RiskLocationInput | null = {
    lat: w.store.lat,
    lng: w.store.lng,
    geofence_radius_m: w.store.geofence_radius_m,
  };
  const photoInput: RiskPhotoInput = {
    gps_lat: w.gpsLat,
    gps_lng: w.gpsLng,
    vision,
  };
  const { score, features } = scoreWriteoff({
    writeoff: writeoffInput,
    location: locationInput,
    photos: [photoInput],
    events,
    baselines: NEUTRAL_BASELINES,
    formatComparison: null,
  });

  // ── Route via the PURE policy (hard gates → on_hold/in_review; else numeric) ─
  const decision = decideRoute({
    score,
    value: w.valueCost,
    hardGateFlags,
  });
  const slaDueAt = computeSlaDueAt(decision.status, w.createdMs);

  // ── Deduction-case promotion: a withholding write-off that a reviewer approved
  //    opens a legal deduction case (the live `maybeCreateDeductionCase` hook runs
  //    on every approve). We mirror that end-state here: status = approved, the
  //    Iiko hand-off is pending (no ledger row yet), and a `deductions` row is
  //    opened against the charged employee — so the Удержания screen has cases.
  const isDeductionCase = !!w.deductionCase && w.withholding && !!w.chargedEmployeeId;
  const finalStatus: WriteoffStatus = isDeductionCase ? "approved" : decision.status;
  const finalQueue = isDeductionCase ? null : decision.queue;
  const finalTier = isDeductionCase ? null : decision.tier;
  const finalSlaDueAt = isDeductionCase ? null : slaDueAt;
  const iikoSyncStatus =
    isDeductionCase || decision.status === "auto_approved" ? (isDeductionCase ? "pending" : "synced") : "none";

  // ── Auto-approved → canned sandbox Iiko ledger (no HTTP) ─────────────────────
  //    (Deduction-case approvals do NOT get a ledger row — they hand to Iiko sync
  //    as `pending`, exactly like the live approve path.)
  let iikoLedgerRow: Record<string, unknown> | null = null;
  if (!isDeductionCase && decision.status === "auto_approved") {
    const iikoDocId = deterministicFakeGuid(w.id);
    iikoLedgerRow = {
      writeoff_id: w.id,
      idempotency_key: detUuid("iiko", w.id),
      iiko_doc_id: iikoDocId,
      request: { sandbox: true, writeoff_id: w.id, value_cost: w.valueCost } as unknown as Json,
      response: { sandbox: true, iiko_doc_id: iikoDocId, generated_at: w.createdIso } as unknown as Json,
      status: "success",
      attempts: 1,
      created_at: w.createdIso,
    };
  }

  // ── Deduction case row (proposed by default; one seeded as acknowledged) ─────
  let deductionRow: Record<string, unknown> | null = null;
  if (isDeductionCase) {
    const salary = employeeSalaryFor(w.store.id);
    const { amount, capAmount, capped, salaryMissing } = computeDeductionAmount(
      w.valueCost,
      salary,
    );
    const employeeName = employeeNameFor(w.store.id);
    const basis = buildDeductionBasis({
      writeoffRef: w.id.slice(0, 8),
      createdAt: w.createdIso,
      reasonLabel: REASON_LABEL[w.reason],
      qty: w.qty,
      unit: w.unit,
      valueCost: w.valueCost,
      capAmount,
      capped,
      salaryMissing,
      employeeName,
    });
    const ackStatus = w.deductionCase!.status;
    const row: Record<string, unknown> = {
      writeoff_id: w.id,
      employee_id: w.chargedEmployeeId,
      amount,
      basis,
      cap_amount: capAmount,
      status: ackStatus,
      created_at: w.createdIso,
    };
    if (ackStatus === "acknowledged") {
      // Mirror acknowledgeDeductionAction: an e-signature binding name+id+time.
      const sigName = w.deductionCase!.signatureName ?? employeeName;
      const ackTs = new Date(w.createdMs + 60_000).toISOString();
      const sigHash = createHash("sha256")
        .update(`${sigName}|${w.id}|${ackTs}`)
        .digest("hex")
        .slice(0, 16);
      row.acknowledged_at = ackTs;
      row.signature = `ack:${sigName}|${w.id}|${ackTs}|${sigHash}`;
    }
    deductionRow = row;
  }

  const writeoffRow: Record<string, unknown> = {
    id: w.id,
    location_id: w.store.id,
    submitter_id: submitterId,
    reason_code_id: REASON_ID[w.reason],
    qty: w.qty,
    unit: w.unit,
    comment: REASON_COMMENT[w.reason],
    withholding: w.withholding,
    charged_employee_id: w.chargedEmployeeId,
    value_cost: w.valueCost,
    status: finalStatus,
    risk_score: score,
    risk_features: features as unknown as Json,
    iiko_sync_status: iikoSyncStatus,
    assigned_queue: finalQueue,
    escalation_tier: finalTier,
    sla_due_at: finalSlaDueAt,
    created_at: w.createdIso,
    seeded: true,
  };

  return {
    writeoffRow,
    photoRow,
    riskEventRows,
    iikoLedgerRow,
    deductionRow,
    score,
    status: finalStatus,
    tier: finalTier,
    queue: finalQueue ?? "",
    slaDueAt: finalSlaDueAt,
    reason: decision.reason,
    hardGateFlags,
  };
}

function pushEvent(
  riskEventRows: Record<string, unknown>[],
  events: RiskEventInput[],
  hardGateFlags: string[],
  writeoffId: string,
  feature: string,
  detail: Record<string, string | number | boolean | null>,
): void {
  const weight = RISK_FEATURE_WEIGHTS[feature as keyof typeof RISK_FEATURE_WEIGHTS] ?? 1;
  riskEventRows.push({
    writeoff_id: writeoffId,
    feature,
    weight,
    detail: detail as unknown as Json,
  });
  events.push({ feature, weight, detail });
  hardGateFlags.push(feature);
}

/** Minimal vision snapshot the scorer reads (confidence + matches_product). */
function visionSnapshot(w: PlannedWriteoff): { confidence: number; matches_product: boolean | null } | null {
  if (w.adv?.kind === "vision_mismatch") return { confidence: 0.82, matches_product: false };
  if (w.adv?.kind === "vision_unverified") return { confidence: 0.45, matches_product: null };
  return null;
}

/** Full canned vision_result jsonb matching the adversarial outcome. */
function visionResultJson(w: PlannedWriteoff): Json {
  if (w.adv?.kind === "vision_mismatch") {
    return {
      verdict: "mismatch",
      matches_product: false,
      matches_defect: true,
      visible_qty: 3,
      confidence: 0.82,
      notes: "на фото другой товар",
    } as unknown as Json;
  }
  if (w.adv?.kind === "vision_unverified") {
    return {
      verdict: "inconclusive",
      matches_product: null,
      matches_defect: null,
      confidence: 0.45,
      visible_qty: null,
      notes: "тёмное фото — не удалось проверить",
    } as unknown as Json;
  }
  return null as unknown as Json;
}

/** Append one hash-chained audit row to the batch, returning the new chain head. */
function pushAudit(
  out: Record<string, unknown>[],
  entry: {
    writeoffId: string;
    actorId: string | null;
    action: string;
    payload: Record<string, unknown>;
    createdAtMs: number;
    prev: string | null;
  },
): string | null {
  const record: AuditRecord = {
    writeoff_id: entry.writeoffId,
    actor_id: entry.actorId,
    action: entry.action,
    payload: entry.payload as unknown as Json,
  };
  const hash = computeAuditHash(entry.prev, record);
  out.push({
    writeoff_id: entry.writeoffId,
    actor_id: entry.actorId,
    action: entry.action,
    prev_hash: entry.prev,
    hash,
    payload: entry.payload as unknown as Json,
    created_at: new Date(entry.createdAtMs).toISOString(),
  });
  return hash;
}

// ── Bulk insert / idempotent delete ───────────────────────────────────────────

async function bulkInsert(
  service: Service,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) chunks.push(rows.slice(i, i + INSERT_CHUNK));
  await Promise.all(
    chunks.map((chunk, idx) =>
      service
        .from(table as never)
        .insert(chunk as unknown as never)
        .then(({ error }) => {
          if (error)
            throw new Error(`[seed-history] ${table} insert [chunk ${idx}, ${chunk.length} rows]: ${error.message}`);
        }),
    ),
  );
}

/** Delete the prior seeded cohort. `deductions` + `iiko_act_ledger` have
 *  ON DELETE RESTRICT → must go before writeoffs; `risk_events` + `writeoff_photos`
 *  cascade. We clear TWO sets: every `seeded=true` writeoff, AND every writeoff
 *  whose id is in this run's plan-id set (prior seed attempts that may not carry
 *  `seeded=true` — plan ids are deterministic SHA-1 UUIDs in our namespace, and
 *  real captures use random UUIDs that cannot collide, so deleting by plan id is
 *  safe). The id lists are chunked (a single `.in()` with hundreds of uuids
 *  exceeds the request URL limit and silently no-ops). */
async function deleteSeededCohort(service: Service, planIds: Set<string>): Promise<void> {
  // Paginated read of all seeded writeoff ids (default select is one page only).
  const seededIds: string[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await service
      .from("writeoffs")
      .select("id")
      .filter("seeded", "eq", true)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[seed-history] seeded-id read failed:", error.message);
      break;
    }
    const rows = (data ?? []) as Array<{ id: string }>;
    seededIds.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  // Target ids = seeded ∪ plan ids (every prior seed attempt, however tagged).
  const targetIds = new Set<string>([...seededIds, ...planIds]);
  const targetList = [...targetIds];
  if (targetList.length === 0) return;

  const DEL_CHUNK = 100;
  const chunkList = (arr: string[]): string[][] => {
    const out: string[][] = [];
    for (let i = 0; i < arr.length; i += DEL_CHUNK) out.push(arr.slice(i, i + DEL_CHUNK));
    return out;
  };
  const targetChunks = chunkList(targetList);
  const planChunks = chunkList([...planIds]);

  // Phase A — clear RESTRICT dependents (deductions + iiko) for every target id,
  // concurrently. Must complete before the writeoffs delete (ON DELETE RESTRICT).
  await Promise.all(
    targetChunks.flatMap((chunk) => [
      service.from("deductions" as never).delete().in("writeoff_id", chunk).then(({ error }) => {
        if (error) console.error("[seed-history] deductions delete chunk failed:", error.message);
      }),
      service.from("iiko_act_ledger" as never).delete().in("writeoff_id", chunk).then(({ error }) => {
        if (error) console.error("[seed-history] iiko delete chunk failed:", error.message);
      }),
    ]),
  );

  // Phase B — delete the writeoffs themselves (seeded filter + plan-id chunks) in
  // parallel. Overlapping rows are fine: one delete wins, the other finds 0 rows.
  const writeoffDeletes: PromiseLike<void>[] = [];
  if (seededIds.length > 0) {
    writeoffDeletes.push(
      service.from("writeoffs").delete().filter("seeded", "eq", true).then(({ error }) => {
        if (error) console.error("[seed-history] writeoffs seeded delete failed:", error.message);
      }),
    );
  }
  for (const chunk of planChunks) {
    writeoffDeletes.push(
      service.from("writeoffs").delete().in("id", chunk).then(({ error }) => {
        if (error) console.error("[seed-history] writeoffs plan-id delete chunk failed:", error.message);
      }),
    );
  }
  await Promise.all(writeoffDeletes);

  // Verify via an exact count (a count can't lie about leftover seeded rows).
  const { count, error: lvErr } = await service
    .from("writeoffs")
    .select("*", { count: "exact", head: true })
    .filter("seeded", "eq", true);
  if (lvErr) console.error("[seed-history] leftover count failed:", lvErr.message);
  if (count && count > 0) {
    throw new Error(`[seed-history] ${count} seeded write-offs still present after delete — aborting before insert.`);
  }
  console.log(`[seed-history] cleared ${targetList.length} prior write-offs (${seededIds.length} seeded + ${targetList.length - seededIds.length} plan-id)`);
}

/** Abort cleanly (before any insert) if a plan id already exists in the DB —
 *  seeded leftovers the delete missed, or a non-seeded collision. Prevents the
 *  bulk insert from partial-committing then erroring on a duplicate key. */
async function preflightNoCollisions(service: Service, planIds: Set<string>): Promise<void> {
  const existing: string[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await service
      .from("writeoffs")
      .select("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`[seed-history] preflight read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string }>;
    for (const r of rows) existing.push(r.id);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  const hits = existing.filter((id) => planIds.has(id));
  if (hits.length > 0) {
    throw new Error(
      `[seed-history] preflight: ${hits.length} plan ids already exist (e.g. ${hits[0]}). Clear them before seeding.`,
    );
  }
}

/** Read the current global audit chain head (most recent row's hash). */
async function readAuditHead(service: Service): Promise<string | null> {
  const { data, error } = await service
    .from("audit_log")
    .select("hash")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[seed-history] audit head read failed:", error.message);
    return null;
  }
  return (data as { hash: string } | null)?.hash ?? null;
}

// ── Loaders ───────────────────────────────────────────────────────────────────

async function loadStores(service: Service): Promise<StoreRow[]> {
  const { data, error } = await service
    .from("stores")
    .select("id, name, display_name, format, city, city_id, cluster_id, lat, lng, geofence_radius_m, is_active")
    .eq("is_active", true);
  if (error || !data) {
    console.error("[seed-history] stores load failed:", error?.message);
    return [];
  }
  return data as StoreRow[];
}

async function resolveSubmitter(service: Service): Promise<string | null> {
  const { data: admin } = await service
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  if (admin) return (admin as { id: string }).id;
  const { data: any } = await service.from("profiles").select("id").limit(1).maybeSingle();
  return (any as { id: string } | null)?.id ?? null;
}

function pickTargetStores(stores: StoreRow[]): Array<{ store: StoreRow; problem?: boolean; employeeId: string }> {
  const out: Array<{ store: StoreRow; problem?: boolean; employeeId: string }> = [];
  const used = new Set<string>();
  for (const t of TARGETS) {
    const match = stores
      .filter((s) => s.format === t.format && (s.city ?? "") === t.city && !used.has(s.id))
      .sort((a, b) => (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name, "ru"))[0];
    if (match) {
      used.add(match.id);
      out.push({ store: match, problem: t.problem, employeeId: "" });
    }
  }
  return out;
}

async function ensureGeocoded(service: Service, store: StoreRow): Promise<void> {
  if (store.lat != null && store.lng != null && store.geofence_radius_m != null) return;
  const fmt = store.format ?? "street";
  const center = CITY_CENTER[store.city ?? ""] ?? [43.2566, 76.9286];
  // Small deterministic offset per store so co-located stores don't overlap.
  const off = (seedFrom(store.id) % 1000) / 1_000_000;
  const patch = {
    lat: center[0] + off,
    lng: center[1] + off,
    geofence_radius_m: RADIUS_BY_FORMAT[fmt],
  };
  const { error } = await service.from("stores").update(patch as unknown as never).eq("id", store.id);
  if (error) console.error(`[seed-history] geocode ensure failed for ${displayName(store)}:`, error.message);
  // Reflect on the in-memory row so plan/construction uses the real coords.
  store.lat = patch.lat;
  store.lng = patch.lng;
  store.geofence_radius_m = patch.geofence_radius_m;
}

async function computeDocumentedLoss(service: Service, storeIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (storeIds.length === 0) return out;
  const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await service
    .from("writeoffs")
    .select("location_id, value_cost")
    .filter("seeded", "eq", true)
    .gte("created_at", from);
  if (error || !data) return out;
  for (const r of data as Array<{ location_id: string; value_cost: number | null }>) {
    if (!storeIds.includes(r.location_id)) continue;
    out.set(r.location_id, (out.get(r.location_id) ?? 0) + (r.value_cost ?? 0));
  }
  return out;
}

// ── Summary ───────────────────────────────────────────────────────────────────

async function printSummary(
  service: Service,
  stats: { created: number; skipped: number; failed: number; elapsed: number },
): Promise<void> {
  const { data, error } = await service
    .from("writeoffs")
    .select("status, risk_score")
    .filter("seeded", "eq", true);
  const rows = (data ?? []) as Array<{ status: string; risk_score: number }>;
  if (error) console.error("[seed-history] summary read failed:", error.message);

  // Deduction cases opened by this seed (visible on the Удержания screen).
  const { data: dedRaw, error: dedErr } = await service
    .from("deductions" as never)
    .select("status")
    .order("created_at", { ascending: false })
    .limit(500);
  const dedRows = (dedRaw ?? []) as Array<{ status: string }>;
  if (dedErr) console.error("[seed-history] deductions summary read failed:", dedErr.message);
  const dedByStatus = new Map<string, number>();
  for (const r of dedRows) dedByStatus.set(r.status, (dedByStatus.get(r.status) ?? 0) + 1);

  const byStatus = new Map<string, number>();
  let flagged = 0;
  for (const r of rows) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const isFlagged =
      r.status === "in_review" || r.status === "on_hold" || r.status === "dual_control" || r.risk_score >= 15;
    if (isFlagged) flagged += 1;
  }
  const total = rows.length;
  const flaggedPct = total > 0 ? Math.round((flagged / total) * 100) : 0;

  console.log("\n────────── seed:history — summary ──────────");
  console.log(`write-offs (seeded)  : ${total}`);
  console.log(`this run · created   : ${stats.created}`);
  console.log(`this run · skipped   : ${stats.skipped} (delete & re-insert → always 0)`);
  console.log(`this run · failed    : ${stats.failed}`);
  console.log(`flagged              : ${flagged} (${flaggedPct}%)`);
  console.log(`deductions           : ${dedRows.length}` + (dedRows.length > 0 ? ` (proposed=${dedByStatus.get("proposed") ?? 0}, acknowledged=${dedByStatus.get("acknowledged") ?? 0})` : ""));
  console.log(`elapsed              : ${(stats.elapsed / 1000).toFixed(1)}s`);
  console.log(`network calls        : 0 (no LLM, no Iiko — pure functions + bulk insert)`);
  console.log("\nby status:");
  const order = ["auto_approved", "in_review", "on_hold", "dual_control", "approved", "rejected", "submitted", "draft"];
  for (const s of order) {
    const n = byStatus.get(s);
    if (n) console.log(`  ${s.padEnd(16)} ${n}`);
  }
  console.log("────────────────────────────────────────────\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function displayName(s: StoreRow): string {
  return s.display_name ?? s.name.replace(/^Bahandi\s+/, "").trim();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
