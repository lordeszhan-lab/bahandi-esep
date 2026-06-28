/**
 * Zod schemas + shared input types for the Iiko mapping server actions.
 *
 * Plain module — NO "use server" directive. A "use server" file may only export
 * async functions, so every Zod schema (a runtime object) and the inferred
 * `MappingInput` type live here and are imported by the actions file. Types are
 * erased at compile time and remain safe to re-export from the actions module.
 */

import { z } from "zod";

// ── Single nomenclature mapping (inline edit / add) ───────────────────────────

export const MappingSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  reasonCodeId: z.string().uuid().nullable().optional(),
  productLabel: z
    .string()
    .trim()
    .min(1, "Укажите название продукта")
    .max(200, "Слишком длинное название"),
  iikoProductId: z.string().trim().uuid("Iiko product id должен быть GUID"),
  iikoUnit: z.string().trim().min(1, "Укажите единицу").max(20),
  iikoStoreId: z.string().trim().uuid("Iiko store id должен быть GUID"),
  iikoAccountId: z.string().trim().uuid("Iiko account id должен быть GUID"),
});

export type MappingInput = z.infer<typeof MappingSchema>;

// ── Bulk store GUID mapping (Prompt B) ────────────────────────────────────────

export const StoreMappingRowSchema = z.object({
  store_id: z.string().trim().uuid("store_id должен быть GUID"),
  iiko_store_id: z.string().trim().uuid("iiko_store_id должен быть GUID"),
  iiko_account_id: z
    .string()
    .trim()
    .uuid("iiko_account_id должен быть GUID")
    .optional()
    .nullable(),
});

// ── Single store inline-edit (Prompt B) ───────────────────────────────────────

export const SaveStoreMappingSchema = z.object({
  storeId: z.string().uuid(),
  iikoStoreId: z.string().trim().uuid("iiko_store_id должен быть GUID"),
  iikoAccountId: z
    .string()
    .trim()
    .uuid("iiko_account_id должен быть GUID")
    .optional()
    .nullable(),
});

// ── Bulk nomenclature import keyed by product_label (Prompt B) ────────────────

export const NomenclatureBulkRowSchema = z.object({
  product_label: z.string().trim().min(1, "Укажите product_label").max(200),
  iiko_product_id: z.string().trim().uuid("iiko_product_id должен быть GUID"),
  iiko_unit: z.string().trim().min(1, "Укажите единицу").max(20),
  iiko_store_id: z.string().trim().uuid("iiko_store_id должен быть GUID"),
  iiko_account_id: z.string().trim().uuid("iiko_account_id должен быть GUID"),
  reason_code_id: z.string().trim().uuid().optional().nullable(),
});
