"use client";

/**
 * IikoReconciliation — the sync-health dashboard (Prompt 17).
 *
 * One source of truth for the Iiko act ledger: count-up KPIs (synced / syncing /
 * on hold / failed / double-posts blocked / orphaned), the recent ledger entries
 * with risk-semantic status pills, failed syncs retryable in one click (with the
 * last error surfaced), and the orphaned acts — approved write-offs handed to
 * Iiko that have no ledger row yet — each with a "sync now" button. Duplicate
 * posts are clearly marked as blocked, never silently re-posted.
 *
 * Analytics surface: count-up is the only joy permitted (СВЕРКА joy-matrix).
 */

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  FileWarning,
  Loader2,
  RefreshCw,
  Send,
  type LucideIcon,
} from "lucide-react";
import { StatKpi } from "@/components/ui/stat-kpi";
import { retryIikoSyncAction, syncOrphanedAction } from "@/lib/actions/iiko-sync";
import type { LedgerStatus } from "@/lib/iiko/ledger-status";
import { formatKztFull, formatDateTime } from "@/components/tower/format";
import type {
  IikoDashboardData,
  LedgerRowView,
  OrphanedView,
} from "@/lib/iiko/queries";

// ── Status → pill mapping (the 4 СВЕРКА tokens + blocked) ─────────────────────

interface PillMeta {
  label: string;
  token: "clean" | "watch" | "fraud" | "info";
}

function pillFor(status: LedgerStatus): PillMeta {
  switch (status) {
    case "synced":
      return { label: "Синхронизировано", token: "clean" };
    case "syncing":
      return { label: "Синхронизация", token: "info" };
    case "pending":
      return { label: "В очереди", token: "info" };
    case "on_hold":
      return { label: "На паузе", token: "watch" };
    case "failed":
      return { label: "Ошибка", token: "fraud" };
    case "duplicate_blocked":
      return { label: "Дубль заблокирован", token: "watch" };
    default:
      return { label: status, token: "info" };
  }
}

const STATUS_ICON: Partial<Record<LedgerStatus, LucideIcon>> = {
  synced: Check,
  failed: AlertTriangle,
  on_hold: Clock,
  duplicate_blocked: Copy,
};

function StatusPill({ status }: { status: LedgerStatus }) {
  const { label, token } = pillFor(status);
  const Icon = STATUS_ICON[status];
  return (
    <span className="pill-status" data-risk={token}>
      {Icon && <Icon size={12} strokeWidth={2.25} />}
      {label}
    </span>
  );
}

export interface IikoReconciliationProps {
  data: IikoDashboardData;
}

export function IikoReconciliation({ data }: IikoReconciliationProps) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; msg: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const flash = (kind: "error" | "success", msg: string) => setToast({ kind, msg });

  async function retry(row: LedgerRowView) {
    setBusyId(row.id);
    try {
      const res = await retryIikoSyncAction(row.id);
      if (res.ok) {
        const msg =
          res.status === "synced"
            ? `Синхронизировано: ${res.iikoDocId?.slice(0, 8) ?? ""}`
            : res.status === "duplicate_blocked"
              ? "Дубль заблокирован — повторная отправка предотвращена"
              : res.status === "on_hold"
                ? `На паузе: ${res.error ?? "нет маппинга"}`
                : res.status === "failed"
                  ? `Ошибка: ${res.error ?? "не удалось"}`
                  : "Готово";
        flash(res.status === "failed" ? "error" : "success", msg);
      } else {
        flash("error", res.error ?? "Не удалось");
      }
      router.refresh();
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Ошибка");
    } finally {
      setBusyId(null);
    }
  }

  async function syncOrphaned(o: OrphanedView) {
    setBusyId(`orph:${o.writeoffId}`);
    try {
      const res = await syncOrphanedAction(o.writeoffId);
      if (res.ok) {
        const msg =
          res.status === "synced"
            ? `Синхронизировано: ${res.iikoDocId?.slice(0, 8) ?? ""}`
            : res.status === "on_hold"
              ? `На паузе: ${res.error ?? "нет маппинга"}`
              : res.status === "failed"
                ? `Ошибка: ${res.error ?? "не удалось"}`
                : "Готово";
        flash(res.status === "failed" ? "error" : "success", msg);
      } else {
        flash("error", res.error ?? "Не удалось");
      }
      router.refresh();
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Ошибка");
    } finally {
      setBusyId(null);
    }
  }

  const { kpis } = data;

  return (
    <div className="space-y-8">
      {/* ── KPI row (count-up — the only joy this surface permits) ────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatKpi label="Синхронизировано" value={kpis.synced} tone="clean" caption="успешных актов" />
        <StatKpi label="В очереди" value={kpis.syncing} tone="info" caption="ожидание / в полёте" />
        <StatKpi label="На паузе" value={kpis.onHold} tone="watch" caption="ждут маппинг" />
        <StatKpi label="Ошибки" value={kpis.failed} tone="fraud" caption="требуют retry" />
        <StatKpi
          label="Дублей заблокировано"
          value={kpis.duplicatesBlocked}
          tone="watch"
          caption="предотвращено повторов"
        />
        <StatKpi
          label="Актов-сирот"
          value={kpis.orphaned}
          tone="watch"
          caption="без ledger-записи"
        />
      </div>

      {/* ── Orphaned acts ─────────────────────────────────────────────────────── */}
      {data.orphaned.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="text-base font-extrabold" style={{ color: "var(--fg)" }}>
              Актов-сирот
            </h2>
            <span
              className="text-xs font-bold"
              style={{
                color: "var(--risk-watch-ink)",
                background: "var(--risk-watch-soft)",
                borderRadius: 9999,
                padding: "0.15rem 0.5rem",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {data.orphaned.length}
            </span>
          </div>
          <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
            Утверждённые акты переданы в Iiko (<code>iiko_sync_status=pending</code>),
            но без записи в ledger. «Синхронизировать» создаст запись и отправит акт.
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {data.orphaned.map((o) => {
              const busy = busyId === `orph:${o.writeoffId}`;
              return (
                <div
                  key={o.writeoffId}
                  className="rounded-2xl px-4 py-3 flex items-center gap-3"
                  style={{
                    background: "var(--surface)",
                    boxShadow: "var(--shadow-card)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <FileWarning
                    size={18}
                    strokeWidth={1.8}
                    style={{ color: "var(--risk-watch-ink)", flexShrink: 0 }}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-sm font-bold truncate"
                      style={{ color: "var(--fg)" }}
                    >
                      {o.storeName}
                      {o.storeCity ? `, ${o.storeCity}` : ""}
                    </div>
                    <div
                      className="text-xs truncate"
                      style={{ color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}
                    >
                      акт #{o.writeoffRef} · {o.reasonLabel} — {o.qty} {o.unit}
                      {o.valueCost != null ? ` · ${formatKztFull(o.valueCost)}` : ""} ·{" "}
                      {formatDateTime(o.createdAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    style={{
                      paddingLeft: "0.7rem",
                      paddingRight: "0.7rem",
                      fontSize: "0.8125rem",
                      flexShrink: 0,
                    }}
                    disabled={busy}
                    onClick={() => syncOrphaned(o)}
                  >
                    {busy ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Send size={14} strokeWidth={2} />
                    )}
                    Синхронизировать
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Ledger table ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-base font-extrabold" style={{ color: "var(--fg)" }}>
          Ledger — последние записи
        </h2>
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: "var(--surface)",
            boxShadow: "var(--shadow-card)",
            border: "1px solid var(--border)",
          }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-2)" }}>
                  <Th>Статус</Th>
                  <Th>Акт / точка</Th>
                  <Th>Сумма</Th>
                  <Th>iiko doc</Th>
                  <Th>Попытки</Th>
                  <Th>Ошибка</Th>
                  <Th style={{ width: 96 }}></Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-xs"
                      style={{ color: "var(--fg-faint)" }}
                    >
                      Ledger пуст. Утверждённые акты появятся здесь после синхронизации.
                    </td>
                  </tr>
                )}
                {data.rows.map((row) => {
                  const canRetry =
                    row.status === "failed" ||
                    row.status === "on_hold" ||
                    row.status === "pending";
                  const busy = busyId === row.id;
                  return (
                    <tr key={row.id} style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-4 py-3">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div style={{ color: "var(--fg)" }}>
                          <span className="font-mono text-xs">#{row.writeoffRef}</span>
                          {" · "}
                          <span className="font-semibold">{row.storeName}</span>
                        </div>
                        <div
                          className="text-xs"
                          style={{ color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}
                        >
                          {row.reasonLabel} — {row.qty} {row.unit}
                          {row.storeCity ? ` · ${row.storeCity}` : ""}
                        </div>
                      </td>
                      <td
                        className="px-4 py-3"
                        style={{ color: "var(--fg)", fontVariantNumeric: "tabular-nums" }}
                      >
                        {row.valueCost != null ? formatKztFull(row.valueCost) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        {row.iikoDocId ? (
                          <span
                            className="font-mono text-xs"
                            style={{ color: "var(--risk-clean-ink)" }}
                            title={row.iikoDocId}
                          >
                            {row.iikoDocId.slice(0, 8)}…
                          </span>
                        ) : (
                          <span style={{ color: "var(--fg-faint)" }}>—</span>
                        )}
                      </td>
                      <td
                        className="px-4 py-3"
                        style={{ color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}
                      >
                        {row.attempts}
                      </td>
                      <td className="px-4 py-3 max-w-[280px]">
                        {row.lastError ? (
                          <span
                            className="font-mono text-xs"
                            style={{
                              color: row.status === "failed" ? "var(--risk-fraud-ink)" : "var(--risk-watch-ink)",
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={row.lastError}
                          >
                            {row.lastError}
                          </span>
                        ) : (
                          <span style={{ color: "var(--fg-faint)" }}>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canRetry && (
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ fontSize: "0.8125rem", padding: "0.35rem 0.6rem" }}
                            disabled={busy}
                            onClick={() => retry(row)}
                            title="Повторить синхронизацию"
                          >
                            {busy ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <RefreshCw size={13} strokeWidth={1.9} />
                            )}
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {toast && (
        <div
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 rounded-full px-4 py-2.5 text-sm font-semibold shadow-card-hover"
          style={{
            background: toast.kind === "error" ? "var(--risk-fraud)" : "var(--brand)",
            color: "#fff",
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Th({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <th
      className="px-4 py-2.5 text-left text-xs font-extrabold uppercase tracking-wide"
      style={{ color: "var(--fg-muted)", ...style }}
    >
      {children}
    </th>
  );
}
