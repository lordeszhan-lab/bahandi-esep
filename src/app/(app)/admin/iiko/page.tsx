/**
 * Iiko reconciliation dashboard — Prompt 17.
 *
 * One source of truth for sync health: the act ledger with status pills,
 * count-up KPIs (synced / syncing / on hold / failed / double-posts blocked /
 * orphaned), failed syncs retryable in one click, and the orphaned acts awaiting
 * their first post. Server Component — loads under RLS (admin) and hands the
 * payload to the interactive client.
 */

import { getCurrentProfile } from "@/lib/auth";
import { APP_NAME } from "@/lib/brand";
import { loadIikoDashboard } from "@/lib/iiko/queries";
import { IikoReconciliation } from "@/components/admin/iiko-reconciliation";

export const metadata = { title: `Синхронизация Iiko · ${APP_NAME}` };

export default async function IikoReconciliationPage() {
  const profile = await getCurrentProfile();
  const isAdmin = profile?.role === "admin";
  const data = isAdmin ? await loadIikoDashboard() : null;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-12">
      <p className="eyebrow mb-3">Управление</p>
      <h1
        className="text-2xl font-extrabold mb-8"
        style={{ color: "var(--fg)" }}
      >
        Синхронизация Iiko
      </h1>

      {!isAdmin ? (
        <div
          className="rounded-2xl px-6 py-12 text-center"
          style={{
            background: "var(--surface)",
            boxShadow: "var(--shadow-card)",
            border: "1px solid var(--border)",
          }}
        >
          <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
            Доступ только для администраторов.
          </p>
        </div>
      ) : data ? (
        <IikoReconciliation data={data} />
      ) : (
        <div
          className="rounded-2xl px-6 py-12 text-center"
          style={{
            background: "var(--surface)",
            boxShadow: "var(--shadow-card)",
            border: "1px solid var(--border)",
          }}
        >
          <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
            Не удалось загрузить данные синхронизации.
          </p>
        </div>
      )}
    </div>
  );
}
