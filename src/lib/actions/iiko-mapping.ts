"use server";

/**
 * iiko_nomenclature_map CRUD — Prompt 15.
 *
 * Maps app products / write-off reasons to Iiko GUIDs (product, unit, store,
 * account). RLS on iiko_nomenclature_map restricts writes to admins; the proxy
 * already gates /admin/* to admins, so the user-bound client is the correct
 * writer (it enforces get_my_role() = 'admin' server-side).
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { deterministicFakeGuid } from "@/lib/iiko/fake-guid";
import type { IikoNomenclature } from "@/lib/db/types";
import {
  MappingSchema,
  StoreMappingRowSchema,
  SaveStoreMappingSchema,
  NomenclatureBulkRowSchema,
} from "@/lib/actions/iiko-mapping-schemas";

// Re-export the input type (type-only — erased, safe in a "use server" file) so
// existing imports from this module keep working.
export type { MappingInput } from "@/lib/actions/iiko-mapping-schemas";
import type { MappingInput } from "@/lib/actions/iiko-mapping-schemas";

// ── Result types (type-only — safe in a "use server" file) ────────────────────

export type MappingSaveResult =
  | { ok: true; mapping: IikoNomenclature }
  | { ok: false; error: string };

export type DeleteResult = { ok: true } | { ok: false; error: string };

export type BulkStoreMappingResult = {
  ok: boolean;
  updated: number;
  errors: string[];
};

export type BulkNomenclatureResult = {
  ok: boolean;
  inserted: number;
  updated: number;
  errors: string[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Insert (no id) or update (with id) a mapping row. */
export async function saveMapping(
  input: MappingInput,
): Promise<MappingSaveResult> {
  const parsed = MappingSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors[0]?.message ?? "Некорректные данные",
    };
  }
  const d = parsed.data;

  const { supabase, user } = await getUser();
  if (!user) return { ok: false, error: "Не авторизован" };

  // Explicit cast: supabase-js v2 strict inference resolves to `never` with the
  // __InternalSupabase marker. Same pattern as submit-writeoff.ts.
  const row = {
    reason_code_id: d.reasonCodeId ?? null,
    product_label: d.productLabel,
    iiko_product_id: d.iikoProductId,
    iiko_unit: d.iikoUnit,
    iiko_store_id: d.iikoStoreId,
    iiko_account_id: d.iikoAccountId,
  } as const;

  if (d.id) {
    const { data, error } = await supabase
      .from("iiko_nomenclature_map")
      .update(row as unknown as never)
      .eq("id", d.id)
      .select("*")
      .single();
    if (error || !data) {
      return { ok: false, error: error?.message ?? "Не удалось сохранить" };
    }
    return { ok: true, mapping: data as IikoNomenclature };
  }

  const { data, error } = await supabase
    .from("iiko_nomenclature_map")
    .insert(row as unknown as never)
    .select("*")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Не удалось создать" };
  }
  return { ok: true, mapping: data as IikoNomenclature };
}

/** Delete a mapping row by id. */
export async function deleteMapping(id: string): Promise<DeleteResult> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Некорректный id" };

  const { supabase, user } = await getUser();
  if (!user) return { ok: false, error: "Не авторизован" };

  const { error } = await supabase
    .from("iiko_nomenclature_map")
    .delete()
    .eq("id", parsed.data);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ── Bulk: Iiko store GUID mapping (Prompt B) ──────────────────────────────────

/**
 * Bulk-upsert Iiko store + account GUIDs onto `stores` rows, keyed by store_id.
 * One pass for all 87 stores instead of editing one-by-one. Each row needs a
 * valid store_id + iiko_store_id (GUIDs); iiko_account_id is optional.
 */
export async function bulkUpsertStoreMappings(
  rows: Array<Record<string, string | undefined>>,
): Promise<BulkStoreMappingResult> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, updated: 0, errors: ["Нет строк"] };
  }
  await requireAdmin();
  const service = createServiceClient();

  const valid: {
    store_id: string;
    iiko_store_id: string;
    iiko_account_id: string | null;
  }[] = [];
  const errors: string[] = [];

  rows.forEach((r, idx) => {
    const parsed = StoreMappingRowSchema.safeParse({
      store_id: r.store_id,
      iiko_store_id: r.iiko_store_id,
      iiko_account_id: r.iiko_account_id || null,
    });
    if (!parsed.success) {
      errors.push(`Строка ${idx + 1}: ${parsed.error.errors[0]?.message ?? "некорректно"}`);
      return;
    }
    valid.push({
      store_id: parsed.data.store_id,
      iiko_store_id: parsed.data.iiko_store_id,
      iiko_account_id: parsed.data.iiko_account_id ?? null,
    });
  });

  if (valid.length === 0) {
    return { ok: false, updated: 0, errors };
  }

  let updated = 0;
  // Per-store update (each row is keyed by store id; supabase-js has no
  // bulk-update-by-pk, and 87 rows is trivial). Sets both GUID fields in one
  // call so account + store stay consistent.
  for (const v of valid) {
    const patch: Record<string, string | null> = { iiko_store_id: v.iiko_store_id };
    if (v.iiko_account_id !== null) patch.iiko_account_id = v.iiko_account_id;
    const { error } = await service
      .from("stores")
      .update(patch as never)
      .eq("id", v.store_id);
    if (error) {
      errors.push(`${v.store_id.slice(0, 8)}: ${error.message}`);
    } else {
      updated += 1;
    }
  }

  return { ok: errors.length === 0, updated, errors };
}

/** Inline-edit a single store's Iiko GUIDs (used by the editable store table). */
export async function saveStoreMapping(
  input: z.infer<typeof SaveStoreMappingSchema>,
): Promise<DeleteResult> {
  const parsed = SaveStoreMappingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  await requireAdmin();
  const service = createServiceClient();
  const patch: Record<string, string | null> = { iiko_store_id: parsed.data.iikoStoreId };
  patch.iiko_account_id = parsed.data.iikoAccountId ?? null;
  const { error } = await service
    .from("stores")
    .update(patch as never)
    .eq("id", parsed.data.storeId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Sandbox auto-fill: stamp every store that still lacks an iiko_store_id with a
 * deterministic fake GUID (SHA1 of the store id, formatted as UUID). Lets the
 * whole Iiko export pipeline demo end-to-end across the network when no real
 * GUIDs exist yet. Never overwrites a real GUID.
 */
export async function autoFillSandboxStoreMappings(): Promise<{
  ok: boolean;
  filled: number;
  error?: string;
}> {
  await requireAdmin();
  const service = createServiceClient();

  const { data, error } = await service
    .from("stores")
    .select("id")
    .is("iiko_store_id", null);
  if (error) return { ok: false, filled: 0, error: error.message };

  const missing = (data as { id: string }[] | null) ?? [];
  let filled = 0;
  for (const s of missing) {
    const fakeStore = deterministicFakeGuid(s.id);
    const fakeAccount = deterministicFakeGuid(`${s.id}:account`);
    const { error: updErr } = await service
      .from("stores")
      .update({
        iiko_store_id: fakeStore,
        iiko_account_id: fakeAccount,
      } as never)
      .eq("id", s.id);
    if (!updErr) filled += 1;
  }
  return { ok: true, filled };
}

// ── Bulk: nomenclature mapping keyed by product_label (Prompt B) ──────────────

/**
 * Bulk-import nomenclature rows keyed by `product_label`: update the existing
 * row for a label if one exists, otherwise insert. The table has no unique
 * constraint on product_label, so we resolve existing labels in one read and
 * branch insert vs. update client-side of the DB.
 */
export async function bulkUpsertNomenclature(
  rows: Array<Record<string, string | undefined>>,
): Promise<BulkNomenclatureResult> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, inserted: 0, updated: 0, errors: ["Нет строк"] };
  }
  await requireAdmin();
  const service = createServiceClient();

  const valid: z.infer<typeof NomenclatureBulkRowSchema>[] = [];
  const errors: string[] = [];

  rows.forEach((r, idx) => {
    const parsed = NomenclatureBulkRowSchema.safeParse({
      product_label: r.product_label,
      iiko_product_id: r.iiko_product_id,
      iiko_unit: r.iiko_unit,
      iiko_store_id: r.iiko_store_id,
      iiko_account_id: r.iiko_account_id,
      reason_code_id: r.reason_code_id || null,
    });
    if (!parsed.success) {
      errors.push(`Строка ${idx + 1}: ${parsed.error.errors[0]?.message ?? "некорректно"}`);
      return;
    }
    valid.push(parsed.data);
  });

  if (valid.length === 0) {
    return { ok: false, inserted: 0, updated: 0, errors };
  }

  const labels = Array.from(new Set(valid.map((r) => r.product_label)));
  const { data: existing } = await service
    .from("iiko_nomenclature_map")
    .select("id, product_label")
    .in("product_label", labels);
  const idByLabel = new Map(
    ((existing as { id: string; product_label: string }[] | null) ?? []).map((e) => [
      e.product_label,
      e.id,
    ]),
  );

  let inserted = 0;
  let updated = 0;

  for (const r of valid) {
    const existingId = idByLabel.get(r.product_label);
    const row = {
      reason_code_id: r.reason_code_id ?? null,
      product_label: r.product_label,
      iiko_product_id: r.iiko_product_id,
      iiko_unit: r.iiko_unit,
      iiko_store_id: r.iiko_store_id,
      iiko_account_id: r.iiko_account_id,
    };
    if (existingId) {
      const { error } = await service
        .from("iiko_nomenclature_map")
        .update(row as never)
        .eq("id", existingId);
      if (error) errors.push(`${r.product_label}: ${error.message}`);
      else updated += 1;
    } else {
      const { error } = await service
        .from("iiko_nomenclature_map")
        .insert(row as never);
      if (error) errors.push(`${r.product_label}: ${error.message}`);
      else inserted += 1;
    }
  }

  return { ok: errors.length === 0, inserted, updated, errors };
}

// ── Guard ─────────────────────────────────────────────────────────────────────

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Не авторизован");
  const { data: rawProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (rawProfile as { role: string } | null)?.role;
  if (role !== "admin") throw new Error("Недостаточно прав");
}
