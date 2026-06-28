/**
 * Seed per-format risk baselines (Prompt B).
 *
 * Cold-start reference: until a store has its own history, its FORMAT baseline
 * is the norm the risk engine judges volume + reason mix against. These numbers
 * are first-principles assumptions about how each Bahandi format behaves —
 * documented inline so tuning is one read. Idempotent (upsert by format PK).
 *
 * Run: npm run seed:baselines   (tsx scripts/seed-baselines.ts)
 * Service-role only — never expose the key to the browser.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import type { Database, StoreFormat } from "../src/lib/db/types";

// ── Assumptions per format ────────────────────────────────────────────────────
// Shares are 0..1 and represent the typical fraction of write-offs in that
// reason category. They don't sum to 1 — yield/quality/return make up the rest
// and aren't tracked here (the format features only flag accidental/breakage/
// spoilage skews, the three categories where a deviation is meaningful).
//
// high_value_threshold is the KZT cut at which a single write-off is "high
// value" for that format — a magnum's threshold is higher than a kiosk's.
const BASELINES: Array<{
  format: StoreFormat;
  expected_writeoffs_per_day: number;
  expected_accidental_share: number;
  expected_breakage_share: number;
  expected_spoilage_share: number;
  high_value_threshold: number | null;
  assumption: string;
}> = [
  {
    format: "kiosk",
    // assumption: kiosks are small-footprint, low-headcount points — low daily
    // volume, and losses skew toward accidental damage + breakage (handling) over
    // spoilage (fast turnover, little storage).
    expected_writeoffs_per_day: 0.8,
    expected_accidental_share: 0.35,
    expected_breakage_share: 0.3,
    expected_spoilage_share: 0.1,
    high_value_threshold: 15_000,
    assumption: "low volume; accidental + breakage dominate",
  },
  {
    format: "street",
    // assumption: street/trade-floor points are slightly busier than kiosks with
    // more handling, so a touch more volume and a balanced accidental/breakage/
    // spoilage mix.
    expected_writeoffs_per_day: 1.2,
    expected_accidental_share: 0.25,
    expected_breakage_share: 0.2,
    expected_spoilage_share: 0.25,
    high_value_threshold: 20_000,
    assumption: "modest volume; balanced accidental/breakage/spoilage",
  },
  {
    format: "market",
    // assumption: market/bazaar points carry more fresh stock with longer dwell
    // time, so spoilage is the dominant skew; volume is moderate.
    expected_writeoffs_per_day: 1.5,
    expected_accidental_share: 0.2,
    expected_breakage_share: 0.15,
    expected_spoilage_share: 0.35,
    high_value_threshold: 30_000,
    assumption: "moderate volume; spoilage dominates",
  },
  {
    format: "mall",
    // assumption: mall points are higher-traffic, higher-volume, with more
    // storage, so spoilage rises and the absolute high-value cut is higher.
    expected_writeoffs_per_day: 2.5,
    expected_accidental_share: 0.15,
    expected_breakage_share: 0.15,
    expected_spoilage_share: 0.3,
    high_value_threshold: 60_000,
    assumption: "high volume; spoilage rises; higher value cut",
  },
  {
    format: "magnum",
    // assumption: magnum-format points are the largest footprints — highest
    // volume, highest high-value cut. Quality + return losses rise relative to
    // the small formats (tracked indirectly via lower accidental/breakage
    // shares), and spoilage stays moderate.
    expected_writeoffs_per_day: 4,
    expected_accidental_share: 0.1,
    expected_breakage_share: 0.1,
    expected_spoilage_share: 0.2,
    high_value_threshold: 120_000,
    assumption: "highest volume; quality/return rise; highest value cut",
  },
];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const supabase = createClient<Database>(url, serviceKey);

  const rows = BASELINES.map((b) => ({
    format: b.format,
    expected_writeoffs_per_day: b.expected_writeoffs_per_day,
    expected_accidental_share: b.expected_accidental_share,
    expected_breakage_share: b.expected_breakage_share,
    expected_spoilage_share: b.expected_spoilage_share,
    high_value_threshold: b.high_value_threshold,
  }));

  const { error } = await supabase
    .from("format_baselines")
    .upsert(rows, { onConflict: "format" });
  if (error) {
    console.error("[seed-baselines] upsert failed:", error.message);
    process.exit(1);
  }

  console.log(`[seed-baselines] seeded ${rows.length} format baselines:`);
  console.table(
    BASELINES.map((b) => ({
      format: b.format,
      per_day: b.expected_writeoffs_per_day,
      accidental: b.expected_accidental_share,
      breakage: b.expected_breakage_share,
      spoilage: b.expected_spoilage_share,
      high_value: b.high_value_threshold,
      assumption: b.assumption,
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
