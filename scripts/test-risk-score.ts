/**
 * Risk engine + routing proof (Prompts 10 & 11).
 *
 * No DB, no network — exercises the PURE functions only:
 *   • scoreWriteoff  — clean ⇒ low, duplicate+mismatch ⇒ high, combo ⇒ cap 100
 *   • decideRoute    — clean low-value ⇒ auto_approved, risky ⇒ right queue
 *
 * Run: npm run test:risk   (tsx scripts/test-risk-score.ts)
 * Exit code is non-zero if any assertion fails, so this doubles as a smoke test.
 */

import {
  scoreWriteoff,
  RISK_SCORE_MAX,
  type RiskBaselines,
  type RiskInput,
  type RiskPhotoInput,
  type RiskEventInput,
} from "../src/lib/risk/score";
import {
  decideRoute,
  computeSlaDueAt,
  ROUTING_CONFIG,
} from "../src/lib/workflow/route";

// ── Builders ──────────────────────────────────────────────────────────────────

const CLEAN_BASELINES: RiskBaselines = {
  employeeRate: 0.5,
  locationPerEmployeeRate: 1, // employee 0.5 < 1×1.5 → no fire
  locationRate: 2,
  chainPerLocationRate: 2, // location 2 < 2×1.5 → no fire
  repeatedChargeCount: 0,
};

function baselines(over: Partial<RiskBaselines> = {}): RiskBaselines {
  return { ...CLEAN_BASELINES, ...over };
}

function photo(over: Partial<RiskPhotoInput> = {}): RiskPhotoInput {
  return { gps_lat: null, gps_lng: null, vision: null, ...over };
}

function ev(
  feature: string,
  detail: Record<string, string | number | boolean | null> = {},
): RiskEventInput {
  return { feature, weight: 1, detail };
}

/** ISO at a given UTC hour on 2026-06-27 (local hour = UTC + 5). */
function isoAtUtcHour(hour: number): string {
  const h = String(hour).padStart(2, "0");
  return `2026-06-27T${h}:00:00.000Z`;
}

// ── Assertion harness ─────────────────────────────────────────────────────────

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

interface Scenario {
  name: string;
  score: number;
  features: string[];
  expectedScore?: { exactly: number };
  expectedAtLeast?: number;
  expectedFeatures?: string[];
}

function runScore(s: Scenario, input: RiskInput): void {
  const res = scoreWriteoff(input);
  const firedFeatures: string[] = res.features.map((f) => f.feature);
  console.log(`\n— ${s.name} —`);
  console.log(`  score: ${res.score} / ${RISK_SCORE_MAX}`);
  if (res.features.length > 0) console.table(res.features);

  if (s.expectedScore) {
    assert(res.score === s.expectedScore.exactly, `score === ${s.expectedScore.exactly} (got ${res.score})`);
  }
  if (s.expectedAtLeast !== undefined) {
    assert(res.score >= s.expectedAtLeast, `score >= ${s.expectedAtLeast} (got ${res.score})`);
  }
  if (s.expectedFeatures) {
    for (const f of s.expectedFeatures) {
      assert(firedFeatures.includes(f), `fired feature '${f}'`);
    }
  }
}

// ── Score scenarios (Prompt 10) ───────────────────────────────────────────────

// A — clean write-off: no signals, normal hours, low value, normal pace.
runScore(
  {
    name: "A · clean write-off → low (0)",
    score: 0,
    features: [],
    expectedScore: { exactly: 0 },
  },
  {
    writeoff: {
      id: "A",
      value_cost: 0,
      created_at: isoAtUtcHour(9), // 09:00 UTC → 14:00 local (operating hours)
      charged_employee_id: null,
      location_id: "loc-1",
      withholding: false,
    },
    location: { lat: 43.2566, lng: 76.9286, geofence_radius_m: 150 },
    photos: [],
    events: [],
    baselines: CLEAN_BASELINES,
  },
);

// B — duplicate photo + vision mismatch: the headline fraud case → high.
runScore(
  {
    name: "B · phash dup + vision mismatch → high (80)",
    score: 80,
    features: ["phash_dup_hit", "vision_mismatch"],
    expectedScore: { exactly: 80 },
    expectedFeatures: ["phash_dup_hit", "vision_mismatch"],
  },
  {
    writeoff: {
      id: "B",
      value_cost: 0,
      created_at: isoAtUtcHour(9),
      charged_employee_id: null,
      location_id: "loc-1",
      withholding: false,
    },
    location: { lat: 43.2566, lng: 76.9286, geofence_radius_m: 150 },
    photos: [],
    events: [ev("phash_dup_hit", { distance: 0 }), ev("vision_mismatch", {})],
    baselines: CLEAN_BASELINES,
  },
);

// B2 — vision unverified only (dark photo / LLM fail-closed). +25 is the
// Prompt 11.1 weight; the score reads elevated, but routing correctness comes
// from the HARD GATE (vision_unverified → in_review), not this number.
runScore(
  {
    name: "B2 · vision unverified → 25 (hard gate routes it, not the score)",
    score: 25,
    features: ["vision_unverified"],
    expectedScore: { exactly: 25 },
    expectedFeatures: ["vision_unverified"],
  },
  {
    writeoff: {
      id: "B2",
      value_cost: 0,
      created_at: isoAtUtcHour(9),
      charged_employee_id: null,
      location_id: "loc-1",
      withholding: false,
    },
    location: { lat: 43.2566, lng: 76.9286, geofence_radius_m: 150 },
    photos: [],
    events: [ev("vision_unverified", { verdict: "inconclusive" })],
    baselines: CLEAN_BASELINES,
  },
);

// C — everything fires at once → capped at 100.
runScore(
  {
    name: "C · every signal → capped (100)",
    score: 100,
    features: [],
    expectedScore: { exactly: 100 },
    expectedFeatures: [
      "phash_dup_hit",
      "vision_mismatch",
      "geofence_fail",
      "employee_high_rate",
      "repeated_charge_target",
      "location_high_rate",
      "high_value",
      "odd_hour",
      "batch_burst",
    ],
  },
  {
    writeoff: {
      id: "C",
      value_cost: 80_000, // high_value (≥ 50 000)
      created_at: isoAtUtcHour(18), // 18:00 UTC → 23:00 local (odd, ≥22)
      charged_employee_id: "emp-1",
      location_id: "loc-1",
      withholding: true,
    },
    location: { lat: 43.2566, lng: 76.9286, geofence_radius_m: 150 },
    photos: [
      // GPS ~10 km away → geofence_fail
      photo({ gps_lat: 43.3, gps_lng: 77.05 }),
    ],
    events: [ev("phash_dup_hit"), ev("vision_mismatch"), ev("batch_burst")],
    baselines: baselines({
      employeeRate: 5, // 5 > 1×1.5 → employee_high_rate
      locationRate: 10, // 10 > 2×1.5 → location_high_rate
      repeatedChargeCount: 4, // ≥3 → repeated_charge_target
    }),
  },
);

// D — computed-only signals (no persisted dup/mismatch): geofence + odd hour + high value.
runScore(
  {
    name: "D · computed signals (geofence + odd + high value) → 38",
    score: 38,
    features: [],
    expectedScore: { exactly: 38 }, // 20 + 10 + 8
    expectedFeatures: ["geofence_fail", "high_value", "odd_hour"],
  },
  {
    writeoff: {
      id: "D",
      value_cost: 60_000,
      created_at: isoAtUtcHour(18), // 23:00 local
      charged_employee_id: null,
      location_id: "loc-1",
      withholding: false,
    },
    location: { lat: 43.2566, lng: 76.9286, geofence_radius_m: 150 },
    photos: [photo({ gps_lat: 43.3, gps_lng: 77.05 })],
    events: [],
    baselines: CLEAN_BASELINES,
  },
);

// ── Routing scenarios (Prompt 11) ─────────────────────────────────────────────

console.log("\n=== Routing (decideRoute + SLA) ===");

function checkRoute(
  name: string,
  args: {
    score: number;
    value: number;
    hardGateFlags?: string[];
    hardGateReadFailed?: boolean;
  },
  expect: { status: string; tier: string | null; queue: string },
): void {
  const d = decideRoute({
    score: args.score,
    value: args.value,
    hardGateFlags: args.hardGateFlags ?? [],
    hardGateReadFailed: args.hardGateReadFailed,
  });
  const sla = computeSlaDueAt(d.status, Date.parse("2026-06-27T09:00:00Z"));
  const gates = args.hardGateFlags && args.hardGateFlags.length > 0
    ? args.hardGateFlags.join(",")
    : args.hardGateReadFailed
      ? "(read failed)"
      : "—";
  console.log(`\n— ${name} —`);
  console.log(
    `  score=${args.score} value=${args.value} gates=${gates} → ${d.status} / tier=${d.tier} / queue=${d.queue} / sla=${sla ?? "none"} (${d.reason})`,
  );
  assert(d.status === expect.status, `status ${expect.status} (got ${d.status})`);
  assert(d.tier === expect.tier, `tier ${expect.tier} (got ${d.tier})`);
  assert(d.queue === expect.queue, `queue ${expect.queue} (got ${d.queue})`);
}

// Clean + low value + no hard gate → auto_approved, no tier, no SLA.
checkRoute(
  "clean low-value, no gate → auto_approved",
  { score: 5, value: 1000 },
  { status: "auto_approved", tier: null, queue: "auto" },
);

// Numeric mid-band (no hard gate) → in_review, location_manager tier, SLA on.
checkRoute(
  "score 35, no gate → in_review (location_manager)",
  { score: 35, value: 1000 },
  { status: "in_review", tier: "location_manager", queue: "location_manager" },
);

// Numeric auto-approve cutoff is now 15 (Prompt 11.1). 14 → auto, 15 → review.
checkRoute(
  "score 14, no gate → auto_approved (just below the new band)",
  { score: 14, value: 1000 },
  { status: "auto_approved", tier: null, queue: "auto" },
);
checkRoute(
  "score 15, no gate → in_review (band lower bound)",
  { score: 15, value: 1000 },
  { status: "in_review", tier: "location_manager", queue: "location_manager" },
);

// High score → dual_control, location_manager (value still low).
checkRoute(
  "score 70, low value, no gate → dual_control (location_manager)",
  { score: 70, value: 1000 },
  { status: "dual_control", tier: "location_manager", queue: "location_manager" },
);

// score 60 (inclusive) → dual_control.
checkRoute(
  "score 60, low value, no gate → dual_control (band inclusive)",
  { score: 60, value: 1000 },
  { status: "dual_control", tier: "location_manager", queue: "location_manager" },
);

// High value forces dual_control even with a low score, tier area.
checkRoute(
  "low score, high value, no gate → dual_control (area)",
  { score: 5, value: 60_000 },
  { status: "dual_control", tier: "area", queue: "area" },
);

// Very high value → finance tier.
checkRoute(
  "very high value, no gate → dual_control (finance)",
  { score: 5, value: 250_000 },
  { status: "dual_control", tier: "finance", queue: "finance" },
);

// ── HARD GATES (Prompt 11.1) — bypass numeric thresholds, never auto_approved ──

// A photo the AI could not verify: even with a rock-bottom score + low value,
// the hard gate forces in_review. This is the core 11.1 guarantee.
checkRoute(
  "vision_unverified, score 5 → in_review (hard gate, NOT auto_approved)",
  { score: 5, value: 1000, hardGateFlags: ["vision_unverified"] },
  { status: "in_review", tier: "location_manager", queue: "location_manager" },
);

// geofence_fail → in_review (needs a human, not a fraud hold).
checkRoute(
  "geofence_fail, score 5 → in_review (hard gate)",
  { score: 5, value: 1000, hardGateFlags: ["geofence_fail"] },
  { status: "in_review", tier: "location_manager", queue: "location_manager" },
);

// phash_dup_hit → on_hold (fraud hold), regardless of a low score.
checkRoute(
  "phash_dup_hit, score 5 → on_hold (investigation)",
  { score: 5, value: 1000, hardGateFlags: ["phash_dup_hit"] },
  { status: "on_hold", tier: "location_manager", queue: "investigation" },
);

// vision_mismatch → on_hold (fraud hold).
checkRoute(
  "vision_mismatch, score 5 → on_hold (investigation)",
  { score: 5, value: 1000, hardGateFlags: ["vision_mismatch"] },
  { status: "on_hold", tier: "location_manager", queue: "investigation" },
);

// on_hold gate outranks in_review gate when both are present → on_hold.
checkRoute(
  "vision_unverified + vision_mismatch → on_hold (on_hold wins)",
  {
    score: 5,
    value: 1000,
    hardGateFlags: ["vision_unverified", "vision_mismatch"],
  },
  { status: "on_hold", tier: "location_manager", queue: "investigation" },
);

// A high score does NOT escape a hard gate down to dual_control: an unverified
// photo at score 70 still needs a human → in_review (not dual_control).
checkRoute(
  "vision_unverified, score 70 → in_review (gate beats numeric)",
  { score: 70, value: 1000, hardGateFlags: ["vision_unverified"] },
  { status: "in_review", tier: "location_manager", queue: "location_manager" },
);

// Fail-closed: a hard-gate read error never auto-approves → in_review.
checkRoute(
  "hard-gate read failed, score 5 → in_review (fail closed)",
  { score: 5, value: 1000, hardGateReadFailed: true },
  { status: "in_review", tier: "location_manager", queue: "location_manager" },
);

// SLA sanity: in_review gets a deadline, auto_approved does not.
{
  const reviewSla = computeSlaDueAt("in_review", 0);
  const autoSla = computeSlaDueAt("auto_approved", 0);
  assert(reviewSla !== null, "in_review has an SLA");
  assert(autoSla === null, "auto_approved has no SLA");
  assert(
    reviewSla === new Date(ROUTING_CONFIG.slaHours.in_review * 3600_000).toISOString(),
    "in_review SLA = configured hours",
  );
}

// ── Verdict ───────────────────────────────────────────────────────────────────

console.log(
  `\n${failures === 0 ? "✓ All risk/routing assertions passed" : `✗ ${failures} assertion(s) failed`}`,
);
process.exit(failures === 0 ? 0 : 1);
