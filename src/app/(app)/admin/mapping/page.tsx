/**
 * Iiko mapping admin page — Prompt 15 + Prompt B (bulk store GUIDs).
 *
 * Two sections: (1) store GUID mapping — bulk CSV import + template + sandbox
 * auto-fill for all 87 stores; (2) nomenclature mapping (app products/reasons →
 * Iiko GUIDs) with its own bulk import keyed by product_label. URL: /admin/mapping
 * (matches the admin nav in app-shell-client). Server Component — fetches under
 * RLS (reads open to authenticated; writes admin-gated).
 */

import { createClient } from "@/lib/supabase/server";
import { APP_NAME } from "@/lib/brand";
import { MappingTable } from "@/components/admin/mapping-table";
import {
  StoreMappingTable,
  type StoreMappingRow,
} from "@/components/admin/store-mapping-table";
import type { IikoNomenclature, ReasonCode, Store } from "@/lib/db/types";

export const metadata = { title: `Маппинг Iiko · ${APP_NAME}` };

export default async function MappingPage() {
  const supabase = await createClient();

  // RLS: any authenticated user reads both tables; writes are admin-gated.
  const [{ data: rawReasons }, { data: rawMappings }, { data: rawStores }] = await Promise.all([
    supabase.from("reason_codes").select("*").order("label_ru"),
    supabase.from("iiko_nomenclature_map").select("*").order("product_label"),
    supabase
      .from("stores")
      .select("id, display_name, city, iiko_store_id, iiko_account_id")
      .order("city")
      .order("display_name"),
  ]);

  const reasonCodes = (rawReasons as ReasonCode[] | null) ?? [];
  const mappings = (rawMappings as IikoNomenclature[] | null) ?? [];
  const storeRows: StoreMappingRow[] = ((rawStores as Pick<
    Store,
    "id" | "display_name" | "city" | "iiko_store_id" | "iiko_account_id"
  >[] | null) ?? []).map((s) => ({
    id: s.id,
    display_name: s.display_name,
    city: s.city,
    iiko_store_id: s.iiko_store_id,
    iiko_account_id: s.iiko_account_id,
  }));

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-12">
      <p className="eyebrow mb-3">Управление</p>
      <h1
        className="text-2xl font-extrabold mb-1"
        style={{ color: "var(--fg)" }}
      >
        Маппинг Iiko
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--fg-muted)" }}>
        Привязка точек и номенклатуры к GUID Iiko. Без маппинга posting в Iiko
        невозможен.
      </p>

      {/* ── Store GUID mapping (bulk) ──────────────────────────────────────── */}
      <div className="mb-10">
        <h2 className="text-base font-extrabold mb-1" style={{ color: "var(--fg)" }}>
          Склады
        </h2>
        <p className="text-xs mb-4" style={{ color: "var(--fg-muted)" }}>
          {storeRows.length} точек — привязка к store/account GUID Iiko. Массовый
          импорт покрывает всю сеть разом.
        </p>
        <StoreMappingTable stores={storeRows} />
      </div>

      {/* ── Nomenclature mapping ───────────────────────────────────────────── */}
      <div className="mt-10 pt-8" style={{ borderTop: "1px solid var(--border)" }}>
        <MappingTable reasonCodes={reasonCodes} mappings={mappings} />
      </div>
    </div>
  );
}
