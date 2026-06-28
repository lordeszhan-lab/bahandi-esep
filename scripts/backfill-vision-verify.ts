/**
 * Vision-verify backfill — Prompt 9.1.
 *
 * Re-runs the vision verification for the LATEST write-off (no re-upload needed)
 * so the new verdict-based schema + fail-closed mapping can be retested against
 * an existing photo. It:
 *   1. picks the most recent photo → its write-off,
 *   2. calls `rerunVisionVerification` (re-runs the vision stage, writes the
 *      verdict into `vision_result`, emits the matching risk_event, dropping any
 *      prior vision_* event first),
 *   3. calls `recomputeAndRoute` so risk_score + the review queue reflect the
 *      fresh verdict.
 *
 * Run: npm run backfill:vision   (tsx scripts/backfill-vision-verify.ts)
 * Needs .env.local with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * and OPENAI_API_KEY.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createServiceClient } from "../src/lib/supabase/service";
import { rerunVisionVerification } from "../src/lib/forensics/run";
import { recomputeAndRoute } from "../src/lib/risk/recompute";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY in .env.local");
    process.exit(1);
  }

  const service = createServiceClient();

  // Latest photo → its write-off is the latest write-off we can re-verify.
  const { data: rawPhoto, error } = await service
    .from("writeoff_photos")
    .select("id, writeoff_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error || !rawPhoto) {
    console.error("No writeoff photos found to backfill:", error?.message ?? "no rows");
    process.exit(1);
  }
  const writeoffId = (rawPhoto as { writeoff_id: string }).writeoff_id;

  console.log(`\nBackfilling vision verification for writeoff ${writeoffId} ...\n`);

  const report = await rerunVisionVerification(writeoffId);
  const v = report.vision;
  console.log("Vision verdict:", v.verdict);
  console.log("  matches_product:", v.matches_product);
  console.log("  matches_defect:", v.matches_defect);
  console.log("  visible_qty:", v.visible_qty);
  console.log("  confidence:", v.confidence);
  console.log("  notes:", v.notes);
  console.log("  flags emitted:", report.flags.length ? report.flags.join(", ") : "(none — verdict 'ok')");

  const { score, route } = await recomputeAndRoute(writeoffId);
  console.log("\nRecomputed risk_score:", score.score);
  if (score.features.length > 0) {
    console.table(
      score.features.map((f) => ({ feature: f.feature, points: f.points })),
    );
  }
  console.log(
    "Routed:",
    route
      ? `${route.from} → ${route.to} (queue=${route.queue}, tier=${route.tier}, reason=${route.reason})`
      : "no route change",
  );
  console.log(
    `\nDB check: select vision_result, dup_of from writeoff_photos where id = '${report.photoId}';`,
  );
  console.log(
    `          select feature, weight from risk_events where writeoff_id = '${writeoffId}';\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
