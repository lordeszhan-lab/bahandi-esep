import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/db/types";

const PASSWORD = "123456";

/**
 * Seed "slots": index 0 → an Астана store (cook), 1 → an Алматы store (cook2).
 * Resolved against the canonical `stores` table after Prompt A retired
 * `locations`; the exact store is picked by city at runtime (no hardcoded ids).
 */
const SEED_STORE_CITIES = ["Астана", "Алматы"] as const;

const USERS = [
  { email: "admin@bahandi.kz", full_name: "Админ", role: "admin", location_index: null },
  { email: "reviewer@bahandi.kz", full_name: "Проверяющий", role: "reviewer", location_index: null },
  { email: "cook@bahandi.kz", full_name: "Тестовый Повар", role: "employee", location_index: 0 },
  { email: "cook2@bahandi.kz", full_name: "Повар Алматы", role: "employee", location_index: 1 },
] as const;

async function findUserByEmail(
  supabase: ReturnType<typeof createClient<Database>>,
  email: string,
) {
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const match = data.users.find((u) => u.email === email);
    if (match) return match;

    if (data.users.length < perPage) return null;
    page++;
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const supabase = createClient<Database>(url, serviceKey);

  // ── Resolve seed store picks by city from the canonical `stores` table ──────
  const { data: storeRows, error: storeErr } = await supabase
    .from("stores")
    .select("id, name, city")
    .order("city", { ascending: true })
    .order("name", { ascending: true });

  if (storeErr) throw storeErr;
  const stores = (storeRows ?? []) as Array<{ id: string; name: string; city: string | null }>;
  if (stores.length === 0) {
    throw new Error("no stores found — run `npm run import:stores` before seeding users");
  }
  const pickByCity = (city: string) =>
    stores.find((s) => s.city === city) ?? stores[0];
  const STORE_PICKS = SEED_STORE_CITIES.map((c) => pickByCity(c)) as Array<{
    id: string;
    name: string;
    city: string | null;
  }>;

  for (const user of USERS) {
    const location_id =
      user.location_index !== null
        ? (STORE_PICKS[user.location_index]?.id ?? null)
        : null;

    if (user.location_index !== null && !location_id) {
      throw new Error(
        `no store for ${user.email} (seed slot ${user.location_index}; ${stores.length} stores)`,
      );
    }

    let userId: string;

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: user.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: user.full_name, role: user.role },
    });

    if (createError) {
      const existing = await findUserByEmail(supabase, user.email);
      if (!existing) {
        throw new Error(`Failed to create ${user.email}: ${createError.message}`);
      }

      userId = existing.id;

      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        password: PASSWORD,
        user_metadata: { full_name: user.full_name, role: user.role },
      });
      if (updateError) throw updateError;
    } else {
      userId = created.user.id;
    }

    const { error: profileError } = await supabase.from("profiles").upsert(
      {
        id: userId,
        full_name: user.full_name,
        role: user.role,
        location_id,
      },
      { onConflict: "id" },
    );

    if (profileError) throw profileError;
  }

  console.table(
    USERS.map((u) => ({
      email: u.email,
      password: PASSWORD,
      role: u.role,
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
