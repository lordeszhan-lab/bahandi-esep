"use client";

/**
 * ReviewQueue — the cockpit surface (Prompt 12).
 *
 * Holds the triage queue state: the risky-first list (already ordered by the
 * loader), the batch-select mode for clean-batch bulk-approve, and the live
 * card set (a card drops out the moment its decision lands). The header shows
 * the in-queue count — a static number, not a count-up.
 *
 * Bulk-approve is scoped to clean rows (no hard-gate flags, not dual_control,
 * no withholding): only those expose a select checkbox when batch mode is on,
 * so the reviewer can't rubber-stamp a risky row by accident.
 */

import { useTransition, useState } from "react";
import { ListChecks, Layers, X } from "lucide-react";
import { bulkApproveAction } from "@/lib/actions/review-decision";
import type { ReviewQueueItem } from "@/lib/review/queue";
import { ReviewItemCard } from "./review-item-card";

export interface ReviewQueueProps {
  items: ReviewQueueItem[];
  total: number;
}

export function ReviewQueue({ items, total }: ReviewQueueProps) {
  const [live, setLive] = useState<ReviewQueueItem[]>(items);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const cleanCount = live.filter((i) => i.bulkApprovable).length;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDecided(id: string, _action: string) {
    setLive((prev) => prev.filter((i) => i.id !== id));
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function enterBatchMode() {
    setSelectMode(true);
    setResultMsg(null);
  }
  function exitBatchMode() {
    setSelectMode(false);
    setSelected(new Set());
    setResultMsg(null);
  }

  function selectAllClean() {
    setSelected(new Set(live.filter((i) => i.bulkApprovable).map((i) => i.id)));
  }

  function runBulkApprove() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setResultMsg(null);
    startTransition(async () => {
      const res = await bulkApproveAction(ids);
      if (res.approved.length > 0) {
        setLive((prev) => prev.filter((i) => !res.approved.includes(i.id)));
      }
      const failedCount = res.failed.length;
      if (failedCount === 0) {
        setResultMsg(`Утверждено: ${res.approved.length}`);
        setSelected(new Set());
      } else {
        setResultMsg(
          `Утверждено ${res.approved.length}, отклонено сервером ${failedCount}`,
        );
        setSelected(new Set(res.failed.map((f) => f.id)));
      }
    });
  }

  if (live.length === 0) {
    return (
      <div className="mx-auto max-w-5xl px-4 sm:px-6 pt-10 pb-12">
        <Header
          total={total}
          inQueue={0}
          selectMode={false}
          onEnterBatch={() => {}}
          onExitBatch={() => {}}
        />
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 pt-10 pb-8">
      <Header
        total={total}
        inQueue={live.length}
        cleanCount={cleanCount}
        selectMode={selectMode}
        onEnterBatch={enterBatchMode}
        onExitBatch={exitBatchMode}
      />

      {/* ── Batch toolbar ─────────────────────────────────────────────────── */}
      {selectMode && (
        <div
          className="sticky flex items-center gap-3 px-4 py-3 mb-4 flex-wrap"
          style={{
            top: 56,
            zIndex: 10,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-ctl)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <span className="section-label" style={{ color: "var(--fg-muted)" }}>
            Пакетное утверждение
          </span>
          <button
            type="button"
            onClick={selectAllClean}
            className="text-sm font-semibold"
            style={{ color: "var(--brand-strong)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
          >
            Выбрать все чистые ({cleanCount})
          </button>
          <span
            className="text-sm"
            style={{
              color: "var(--fg-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            Выбрано: {selected.size}
          </span>
          <span className="flex-1" />
          {resultMsg && (
            <span
              className="text-sm"
              style={{ color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}
            >
              {resultMsg}
            </span>
          )}
          <button
            type="button"
            onClick={runBulkApprove}
            disabled={pending || selected.size === 0}
            className="btn-primary"
            style={{ opacity: pending || selected.size === 0 ? 0.45 : 1, padding: "0.5rem 1rem" }}
          >
            Утвердить {selected.size > 0 ? selected.size : ""}
          </button>
          <button
            type="button"
            onClick={exitBatchMode}
            className="flex items-center gap-1 text-sm font-semibold"
            style={{ color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
          >
            <X size={15} strokeWidth={2} /> Отмена
          </button>
        </div>
      )}

      {/* ── Cards (risky first) ───────────────────────────────────────────── */}
      <div className="space-y-4">
        {live.map((item) => (
          <ReviewItemCard
            key={item.id}
            item={item}
            selectMode={selectMode}
            selected={selected.has(item.id)}
            onToggleSelect={toggleSelect}
            onDecided={handleDecided}
          />
        ))}
      </div>
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({
  total,
  inQueue,
  cleanCount,
  selectMode,
  onEnterBatch,
  onExitBatch,
}: {
  total: number;
  inQueue: number;
  cleanCount?: number;
  selectMode: boolean;
  onEnterBatch: () => void;
  onExitBatch: () => void;
}) {
  return (
    <div className="flex items-end gap-4 mb-6 flex-wrap">
      <div>
        <p className="section-label mb-2">Очередь проверки</p>
        <h1
          className="text-2xl font-extrabold"
          style={{ color: "var(--fg)", letterSpacing: "-0.01em" }}
        >
          Списания на решение
        </h1>
      </div>
      <span
        className="flex items-center gap-1.5 text-sm"
        style={{
          color: "var(--fg-muted)",
          fontVariantNumeric: "tabular-nums",
          marginLeft: "auto",
        }}
      >
        <ListChecks size={16} strokeWidth={1.75} />
        В очереди: {inQueue}
        {total > inQueue ? ` / ${total}` : ""}
      </span>
      {cleanCount != null && !selectMode && cleanCount > 0 && (
        <button
          type="button"
          onClick={onEnterBatch}
          className="flex items-center gap-1.5 text-sm font-semibold"
          style={{
            color: "var(--brand-strong)",
            background: "var(--brand-soft)",
            border: "none",
            borderRadius: 9999,
            padding: "0.4rem 0.85rem",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <Layers size={15} strokeWidth={2} />
          Пакет · {cleanCount} чистых
        </button>
      )}
      {selectMode && (
        <button
          type="button"
          onClick={onExitBatch}
          className="text-sm font-semibold"
          style={{ color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
        >
          Выйти из пакета
        </button>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      className="card flex flex-col items-center justify-center text-center"
      style={{ padding: "3rem 1.5rem" }}
    >
      <ListChecks size={32} strokeWidth={1.5} style={{ color: "var(--fg-faint)" }} />
      <p
        className="mt-3 text-base"
        style={{ fontWeight: 700, color: "var(--fg)" }}
      >
        Очередь пуста
      </p>
      <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
        Нет списаний, ожидающих решения.
      </p>
    </div>
  );
}
