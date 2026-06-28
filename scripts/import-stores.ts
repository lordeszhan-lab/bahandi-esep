/**
 * Import + reconcile stores (Prompt A).
 *
 * Idempotent. Loads the 87 real Bahandi stores from data/stores.csv into the
 * canonical `stores` table (skipping the raw insert if the table is already
 * populated from a prior CSV export, per the prompt), then enriches every
 * row with:
 *   • display_name  — name with the leading "Bahandi " prefix stripped
 *   • format        — parsed from the address/name (kiosk | mall | magnum |
 *                     market | street) in the prompt's priority order
 *   • city_id       — linked to the normalized `cities` dimension
 *   • geofence_radius_m — format-aware default so the geofence check works
 *                     the moment coords land (the geocode script reaffirms it)
 *
 * Ends with a console.table format×city breakdown so the parse is auditable.
 *
 * Run: npm run import:stores   (tsx scripts/import-stores.ts)
 * Service-role only — never expose the key to the browser.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database, StoreFormat } from "../src/lib/db/types";

// ── Tuning ────────────────────────────────────────────────────────────────────

/** Format-aware geofence radius (metres). Mirrors scripts/geocode-stores.ts. */
const RADIUS_BY_FORMAT: Record<StoreFormat, number> = {
  kiosk: 75,
  market: 100,
  street: 120,
  mall: 180,
  magnum: 150,
};

const CSV_PATH = path.join(process.cwd(), "data", "stores.csv");
const BAHANDI_PREFIX = /^Bahandi\s+/;

// ── Minimal RFC-4180 CSV parser (handles quoted fields + "" escapes) ──────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Treat \r\n and \r the same as a record end.
      rows.push(row);
      row = [];
      field = "";
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the final field/row (file without a trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.length > 0 && r.some((c) => c.trim() !== ""));
}

// ── Format parsing (prompt priority order) ────────────────────────────────────

function parseFormat(name: string, address: string): StoreFormat {
  const hay = `${name} ${address}`.toLowerCase();
  if (hay.includes("магнум")) return "magnum";
  if (hay.includes("киоск")) return "kiosk";
  if (hay.includes("трц") || hay.includes("тц") || hay.includes("молл") || hay.includes("mall"))
    return "mall";
  if (hay.includes("рынок") || hay.includes("базар")) return "market";
  return "street";
}

function displayName(name: string): string {
  return name.replace(BAHANDI_PREFIX, "").trim() || name.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface CsvStore {
  id: string;
  name: string;
  address: string;
  city: string;
  created_at: string;
}

function readCsv(): CsvStore[] {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`stores CSV not found at ${CSV_PATH}`);
  }
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const [header, ...dataRows] = parseCsv(raw);
  if (!header) throw new Error("stores CSV is empty");

  const idx = (col: string) => header.findIndex((h) => h.trim() === col);
  const iId = idx("id");
  const iName = idx("name");
  const iAddress = idx("address");
  const iCity = idx("city");
  const iCreatedAt = idx("created_at");
  if (iId < 0 || iName < 0 || iAddress < 0 || iCity < 0) {
    throw new Error(`stores CSV missing required columns (got: ${header.join(", ")})`);
  }

  const out: CsvStore[] = [];
  for (const r of dataRows) {
    if (!r[iId]) continue;
    out.push({
      id: r[iId],
      name: r[iName] ?? "",
      address: r[iAddress] ?? "",
      city: (r[iCity] ?? "").trim(),
      created_at: r[iCreatedAt] ?? new Date().toISOString(),
    });
  }
  return out;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const supabase = createClient<Database>(url, serviceKey);

  const csvStores = readCsv();
  console.log(`[import-stores] parsed ${csvStores.length} rows from ${CSV_PATH}`);

  // ── Is stores already populated? ────────────────────────────────────────────
  const { count: existing, error: countErr } = await supabase
    .from("stores")
    .select("id", { count: "exact", head: true });
  if (countErr) {
    console.error(
      "[import-stores] could not read stores — is the 0004 migration applied?\n",
      countErr.message,
    );
    process.exit(1);
  }
          const populated = (existing ?? 0) > 0;
          // The migration pre-inserts the 3 demo-remap stores, so `populated`
          // alone isn't enough — only skip the raw upsert when the table already
          // holds the full CSV set; otherwise upsert every CSV row by id (the 3
          // pre-existing rows get their address/created_at filled in, the other
          // 84 are inserted). Idempotent.
          const fullyPopulated = (existing ?? 0) >= csvStores.length;
          console.log(
            fullyPopulated
              ? `[import-stores] stores already fully populated (${existing}/${csvStores.length}) — skipping raw insert, enriching only`
              : `[import-stores] stores not yet full (${existing ?? 0}/${csvStores.length}) — upserting all ${csvStores.length} rows from CSV`,
          );

  // ── Seed cities from the distinct CSV city values (normalize: trim) ──────────
  const distinctCities = Array.from(
    new Set(csvStores.map((s) => s.city).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, "ru"));

  if (distinctCities.length > 0) {
    const { error: cityErr } = await supabase
      .from("cities")
      .upsert(
        distinctCities.map((name) => ({ name })),
        { onConflict: "name", ignoreDuplicates: true },
      );
    if (cityErr) {
      console.error("[import-stores] cities upsert failed:", cityErr.message);
      process.exit(1);
    }
  }

  const { data: cityRows, error: cityReadErr } = await supabase
    .from("cities")
    .select("id, name");
  if (cityReadErr || !cityRows) {
    console.error("[import-stores] cities read failed:", cityReadErr?.message);
    process.exit(1);
  }
  const cityIdByName = new Map<string, string>(
    cityRows.map((c) => [c.name, c.id]),
  );

          // ── Raw upsert (only when stores wasn't already fully populated) ──────────
          if (!fullyPopulated) {
            const inserts = csvStores.map((s) => ({
              id: s.id,
              name: s.name,
              address: s.address,
              city: s.city,
              created_at: s.created_at,
            }));
            const { error: insErr } = await supabase
              .from("stores")
              .upsert(inserts, { onConflict: "id" });
            if (insErr) {
              console.error("[import-stores] stores insert failed:", insErr.message);
              process.exit(1);
            }
          }

  // ── Enrich every CSV store: display_name, format, city_id, radius ───────────
  let enriched = 0;
  let failed = 0;
  for (const s of csvStores) {
    const format = parseFormat(s.name, s.address);
    const city_id = s.city ? (cityIdByName.get(s.city) ?? null) : null;
    const patch = {
      display_name: displayName(s.name),
      format,
      city_id,
      geofence_radius_m: RADIUS_BY_FORMAT[format],
    };
    const { error: updErr } = await supabase
      .from("stores")
      .update(patch)
      .eq("id", s.id);
    if (updErr) {
      console.error(`[import-stores] enrich failed for ${s.id} (${s.name}): ${updErr.message}`);
      failed += 1;
    } else {
      enriched += 1;
    }
  }

  console.log(`[import-stores] enriched ${enriched} store(s), ${failed} failure(s)`);

  // ── Audit: format × city breakdown ──────────────────────────────────────────
  const formats: StoreFormat[] = ["kiosk", "mall", "magnum", "market", "street"];
  const matrix = new Map<StoreFormat, Map<string, number>>();
  for (const f of formats) matrix.set(f, new Map());
  for (const s of csvStores) {
    const f = parseFormat(s.name, s.address);
    const city = s.city || "—";
    matrix.get(f)!.set(city, (matrix.get(f)!.get(city) ?? 0) + 1);
  }

  const table = formats.map((f) => {
    const row: Record<string, number | string> = { format: f };
    let total = 0;
    for (const c of distinctCities) {
      const n = matrix.get(f)!.get(c) ?? 0;
      row[c] = n;
      total += n;
    }
    row["total"] = total;
    return row;
  });

  console.log("\n=== format × city ===");
  console.table(table);

  const grandTotal = csvStores.length;
  console.log(`\n[import-stores] done — ${grandTotal} stores, ${distinctCities.length} cities`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
