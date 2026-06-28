/**
 * Geocode stores via 2GIS (Prompt A).
 *
 * Run once; idempotent — stores that already have lat/lng are skipped. For each
 * store missing coords we call the 2GIS Geocoder:
 *   GET https://catalog.api.2gis.com/3.0/items/geocode?q=<city>, <address>
 *      &fields=items.point&key=${TWOGIS_API_KEY}
 * and take result.items[0].point.{lat, lon}.
 *
 * Throttled (~150ms between calls), retries once on 429/timeout, and logs any
 * address that returns 0 items into a geocode_failures list printed at the end
 * so they can be fixed by hand.
 *
 * FALLBACK: if TWOGIS_API_KEY is absent, read data/stores_coords.csv
 * (id,lat,lng) and fill from it — the build is never blocked by a missing key.
 *
 * Also (re)applies the format-aware geofence radius to every store:
 * kiosk 75 · market 100 · street 120 · mall 180 · magnum 150.
 *
 * Run: npm run geocode:stores   (tsx scripts/geocode-stores.ts)
 * Service-role only.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database, StoreFormat } from "../src/lib/db/types";

// ── Tuning ────────────────────────────────────────────────────────────────────

const RADIUS_BY_FORMAT: Record<StoreFormat, number> = {
  kiosk: 75,
  market: 100,
  street: 120,
  mall: 180,
  magnum: 150,
};

const TWO_GIS_ENDPOINT = "https://catalog.api.2gis.com/3.0/items/geocode";
const THROTTLE_MS = 150;
const REQUEST_TIMEOUT_MS = 10_000;
const COORDS_CSV_PATH = path.join(process.cwd(), "data", "stores_coords.csv");

type StoreRow = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  format: StoreFormat | null;
  lat: number | null;
  lng: number | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TwoGiSPoint {
  lat: number;
  lon: number;
}

interface GeocodeResult {
  point: TwoGiSPoint | null;
  reason: string;
}

async function geocodeOne(
  apiKey: string,
  city: string,
  address: string,
): Promise<GeocodeResult> {
  const q = `${city}, ${address}`.trim();
  const url = `${TWO_GIS_ENDPOINT}?q=${encodeURIComponent(q)}&fields=items.point&key=${apiKey}`;

  const doFetch = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let resp: Response;
  try {
    resp = await doFetch();
  } catch (err) {
    // Network / timeout — retry once after a short backoff.
    await sleep(500);
    try {
      resp = await doFetch();
    } catch (err2) {
      return { point: null, reason: `network: ${err2}` };
    }
  }

  if (resp.status === 429) {
    await sleep(1000);
    try {
      resp = await doFetch();
    } catch (err) {
      return { point: null, reason: `retry_429: ${err}` };
    }
  }

  if (!resp.ok) {
    return { point: null, reason: `http ${resp.status}` };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    return { point: null, reason: `bad json: ${err}` };
  }

  const items = (json as { result?: { items?: Array<{ point?: TwoGiSPoint }> } })
    ?.result?.items;
  if (!items || items.length === 0) {
    return { point: null, reason: "0 items" };
  }
  const point = items[0].point ?? null;
  if (!point || point.lat == null || point.lon == null) {
    return { point: null, reason: "no point" };
  }
  return { point, reason: "ok" };
}

// ── Fallback: read a hand-maintained coords CSV (id,lat,lng) ──────────────────

function readCoordsCsv(): Map<string, { lat: number; lng: number }> {
  const map = new Map<string, { lat: number; lng: number }>();
  if (!fs.existsSync(COORDS_CSV_PATH)) return map;
  const raw = fs.readFileSync(COORDS_CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const [header, ...rows] = lines;
  if (!header) return map;
  const cols = header.split(",").map((c) => c.trim());
  const iId = cols.indexOf("id");
  const iLat = cols.indexOf("lat");
  const iLng = cols.indexOf("lng");
  if (iId < 0 || iLat < 0 || iLng < 0) return map;
  for (const r of rows) {
    const parts = r.split(",");
    const id = parts[iId]?.trim();
    const lat = parseFloat(parts[iLat]?.trim() ?? "");
    const lng = parseFloat(parts[iLng]?.trim() ?? "");
    if (id && Number.isFinite(lat) && Number.isFinite(lng)) {
      map.set(id, { lat, lng });
    }
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const supabase = createClient<Database>(url, serviceKey);

  const { data: rawStores, error } = await supabase
    .from("stores")
    .select("id, name, address, city, format, lat, lng")
    .order("name");
  if (error || !rawStores) {
    console.error("[geocode-stores] could not read stores:", error?.message);
    process.exit(1);
  }
  const stores = rawStores as StoreRow[];
  console.log(`[geocode-stores] loaded ${stores.length} stores`);

  // ── (Re)apply the format-aware geofence radius to every store ───────────────
  let radiusSet = 0;
  for (const s of stores) {
    if (!s.format) continue;
    const radius = RADIUS_BY_FORMAT[s.format];
    const { error: rErr } = await supabase
      .from("stores")
      .update({ geofence_radius_m: radius })
      .eq("id", s.id);
    if (rErr) console.error(`[geocode-stores] radius set failed for ${s.id}: ${rErr.message}`);
    else radiusSet += 1;
  }
  console.log(`[geocode-stores] geofence_radius_m set for ${radiusSet} store(s)`);

  const missing = stores.filter((s) => s.lat == null || s.lng == null);
  if (missing.length === 0) {
    console.log("[geocode-stores] all stores already have coords — nothing to geocode");
    return;
  }
  console.log(`[geocode-stores] ${missing.length} store(s) missing coords`);

  const apiKey = process.env.TWOGIS_API_KEY?.trim();
  const failures: Array<{ id: string; name: string; city: string; address: string; reason: string }> = [];

  if (!apiKey) {
    // ── Fallback: data/stores_coords.csv ──────────────────────────────────────
    console.warn("[geocode-stores] TWOGIS_API_KEY not set — using fallback data/stores_coords.csv");
    const coords = readCoordsCsv();
    if (coords.size === 0) {
      console.error("[geocode-stores] no TWOGIS_API_KEY and no data/stores_coords.csv — cannot geocode");
      process.exit(1);
    }
    let filled = 0;
    for (const s of missing) {
      const c = coords.get(s.id);
      if (!c) {
        failures.push({ id: s.id, name: s.name, city: s.city ?? "", address: s.address ?? "", reason: "not in coords csv" });
        continue;
      }
      const { error: uErr } = await supabase
        .from("stores")
        .update({ lat: c.lat, lng: c.lng })
        .eq("id", s.id);
      if (uErr) {
        failures.push({ id: s.id, name: s.name, city: s.city ?? "", address: s.address ?? "", reason: uErr.message });
      } else {
        filled += 1;
      }
    }
    console.log(`[geocode-stores] filled ${filled} coords from fallback csv`);
  } else {
    // ── 2GIS geocoder ─────────────────────────────────────────────────────────
    let geocoded = 0;
    let firstLog = true;
    for (const s of missing) {
      const city = s.city ?? "";
      const address = s.address ?? "";
      const { point, reason } = await geocodeOne(apiKey, city, address);

      if (firstLog) {
        // Log one raw-ish line so the endpoint shape is verifiable on first run.
        console.log(`[geocode-stores] first lookup: "${city}, ${address}" → ${reason}`);
        firstLog = false;
      }

      if (!point) {
        failures.push({ id: s.id, name: s.name, city, address, reason });
        await sleep(THROTTLE_MS);
        continue;
      }

      const { error: uErr } = await supabase
        .from("stores")
        .update({ lat: point.lat, lng: point.lon })
        .eq("id", s.id);
      if (uErr) {
        failures.push({ id: s.id, name: s.name, city, address, reason: `update: ${uErr.message}` });
      } else {
        geocoded += 1;
        console.log(`  ✓ ${s.name} (${city}) → ${point.lat}, ${point.lon}`);
      }
      await sleep(THROTTLE_MS);
    }
    console.log(`[geocode-stores] geocoded ${geocoded} store(s) via 2GIS`);
  }

  // ── Failures ────────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.log(`\n=== geocode_failures (${failures.length}) ===`);
    console.table(
      failures.map((f) => ({ name: f.name, city: f.city, address: f.address, reason: f.reason })),
    );
  } else {
    console.log("\n[geocode-stores] no failures — all stores geocoded");
  }

  // ── Final coord coverage ────────────────────────────────────────────────────
  const { data: recheck } = await supabase
    .from("stores")
    .select("id, lat, lng", { count: "exact" });
  const withCoords = (recheck ?? []).filter((s) => s.lat != null && s.lng != null).length;
  console.log(`[geocode-stores] coord coverage: ${withCoords}/${stores.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
