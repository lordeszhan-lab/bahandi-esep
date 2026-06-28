/**
 * Seed store clusters — City → Cluster → Store (Prompt B).
 *
 * Auto-creates ONE cluster per city ("<city> — кластер 1") and assigns that
 * city's stores to it, EXCEPT Almaty (48 stores) which gets 3 clusters with its
 * stores round-robin assigned — so no single area manager owns all of Almaty
 * (the rubber-stamp failure the network is designed against).
 *
 * Idempotent: re-running creates any missing clusters by name and re-applies the
 * round-robin assignment, so it's safe to run after import:stores and again
 * later. Reviewer assignment is done by an admin on the /admin/clusters screen.
 *
 * Run: npm run seed:clusters   (tsx scripts/seed-clusters.ts)
 * Service-role only — never expose the key to the browser.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/db/types";

/** Cities big enough to split into multiple clusters so no reviewer owns all. */
const SPLIT_CITIES: Record<string, number> = {
  // assumption: Almaty has 48 stores — 3 clusters of ~16 keeps each area
  // manager's slice reviewable and prevents one reviewer rubber-stamping the
  // whole city.
  "Алматы": 3,
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const supabase = createClient<Database>(url, serviceKey);

  // ── Load cities + stores ────────────────────────────────────────────────────
  const { data: cityRows, error: cityErr } = await supabase
    .from("cities")
    .select("id, name");
  if (cityErr || !cityRows) {
    console.error("[seed-clusters] cities read failed:", cityErr?.message);
    process.exit(1);
  }
  const cityIdByName = new Map<string, string>(
    (cityRows as { id: string; name: string }[]).map((c) => [c.name, c.id]),
  );

  const { data: storeRows, error: storeErr } = await supabase
    .from("stores")
    .select("id, name, city, city_id, cluster_id")
    .order("city", { ascending: true })
    .order("name", { ascending: true });
  if (storeErr || !storeRows) {
    console.error("[seed-clusters] stores read failed:", storeErr?.message);
    process.exit(1);
  }
  const stores = storeRows as {
    id: string;
    name: string;
    city: string | null;
    city_id: string | null;
    cluster_id: string | null;
  }[];

  if (stores.length === 0) {
    console.error("[seed-clusters] no stores — run `npm run import:stores` first");
    process.exit(1);
  }

  // Group stores by city name (fall back to "—" for unlabelled stores).
  const byCity = new Map<string, typeof stores>();
  for (const s of stores) {
    const key = s.city || "—";
    const arr = byCity.get(key) ?? [];
    arr.push(s);
    byCity.set(key, arr);
  }

  // ── Existing clusters (so the run is idempotent) ─────────────────────────────
  const { data: existingClusters, error: clusterErr } = await supabase
    .from("store_clusters")
    .select("id, name, city_id");
  if (clusterErr) {
    console.error("[seed-clusters] clusters read failed:", clusterErr.message);
    process.exit(1);
  }
  const existingByName = new Map<string, string>(
    ((existingClusters as { id: string; name: string; city_id: string | null }[]) ?? []).map(
      (c) => [c.name, c.id],
    ),
  );

  const summary: Array<{
    city: string;
    clusters: number;
    stores: number;
  }> = [];

  for (const [city, cityStores] of byCity) {
    const clusterCount = SPLIT_CITIES[city] ?? 1;
    const cityId = city !== "—" ? (cityIdByName.get(city) ?? null) : null;

    // Resolve (create if missing) the N clusters for this city, in order.
    const clusterIds: string[] = [];
    for (let i = 0; i < clusterCount; i++) {
      const name =
        clusterCount === 1
          ? `${city} — кластер 1`
          : `${city} — кластер ${i + 1}`;
      const existing = existingByName.get(name);
      if (existing) {
        clusterIds.push(existing);
        continue;
      }
      const { data, error } = await supabase
        .from("store_clusters")
        .insert({ name, city_id: cityId })
        .select("id")
        .single();
      if (error || !data) {
        console.error(`[seed-clusters] create cluster "${name}" failed: ${error?.message}`);
        process.exit(1);
      }
      const id = (data as { id: string }).id;
      existingByName.set(name, id);
      clusterIds.push(id);
    }

    // Round-robin the city's stores across its clusters (stable by name order).
    for (let i = 0; i < cityStores.length; i++) {
      const targetClusterId = clusterIds[i % clusterCount];
      const store = cityStores[i];
      if (store.cluster_id === targetClusterId) continue; // already assigned
      const { error: updErr } = await supabase
        .from("stores")
        .update({ cluster_id: targetClusterId })
        .eq("id", store.id);
      if (updErr) {
        console.error(
          `[seed-clusters] assign ${store.name} → cluster failed: ${updErr.message}`,
        );
      }
    }

    summary.push({ city, clusters: clusterCount, stores: cityStores.length });
  }

  console.log(`[seed-clusters] done — ${stores.length} stores across ${byCity.size} cities`);
  console.table(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
