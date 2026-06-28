"use client";

/**
 * TowerStoreWriteoffList — a store's write-offs, expanded from the leaderboard
 * (Prompt C: "clicking a store opens its write-off list — reuse the cockpit list").
 *
 * A read-only projection in the cockpit visual language: photo thumb + risk-meter
 * arc + the specific red flags + status pill + timestamp. No decision buttons
 * (the Tower observes; decisions happen in the cockpit). Fetched on expand via
 * the `fetchStoreWriteoffs` server action so signed photo URLs + risk-feature
 * parsing stay server-side.
 */

import { useEffect, useState, useTransition } from "react";
import { RiskMeter } from "@/components/review/risk-meter";
import { fetchStoreWriteoffs } from "@/lib/actions/tower-store-writeoffs";
import { formatDateTime, formatKztCompact } from "./format";
import type { RiskSeverity, StoreWriteoff } from "@/lib/analytics/types";

const STATUS_LABEL: Record<string, string> = {
  auto_approved: "Авто",
  in_review: "На проверке",
  dual_control: "Двойной контроль",
  on_hold: "Уточнение",
  approved: "Утверждено",
  rejected: "Отклонено",
  submitted: "Подано",
  draft: "Черновик",
};

const STATUS_RISK: Record<string, RiskSeverity> = {
  auto_approved: "clean",
  approved: "clean",
  in_review: "watch",
  dual_control: "watch",
  submitted: "watch",
  on_hold: "fraud",
  rejected: "fraud",
};

const SHORT_FLAG: Record<string, string> = {
  phash_dup_hit: "Повтор фото",
  vision_mismatch: "Не то фото",
  vision_unverified: "Не проверено",
  geofence_fail: "GPS вне зоны",
  geofence_unverified: "Нет GPS",
  employee_high_rate: "Чаще нормы",
  location_high_rate: "Точка чаще нормы",
  repeated_charge_target: "Повтор списания",
  format_volume_anomaly: "Объём",
  format_reason_anomaly: "Структура",
  high_value: "Крупная сумма",
  odd_hour: "Вне часов",
  batch_burst: "Всплеск",
  vision_low_confidence: "Низкая уверен.",
  non_camera_source: "Не камера",
  capture_time_skew: "Время съёмки",
};

const SEVERITY_DOT: Record<RiskSeverity, string> = {
  fraud: "var(--risk-fraud)",
  watch: "var(--risk-watch)",
  clean: "var(--risk-clean)",
};

export interface TowerStoreWriteoffListProps {
  storeId: string;
  displayName: string;
  from: string;
  to: string;
}

export function TowerStoreWriteoffList({
  storeId,
  displayName,
  from,
  to,
}: TowerStoreWriteoffListProps) {
  const [items, setItems] = useState<StoreWriteoff[] | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    startTransition(async () => {
      const rows = await fetchStoreWriteoffs(storeId, from, to);
      if (!cancelled) setItems(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId, from, to]);

  return (
    <div
      style={{
        background: "var(--surface-2)",
        borderRadius: "var(--radius-ctl)",
        padding: "0.75rem",
        marginTop: "0.5rem",
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: "0.5rem", padding: "0 0.25rem" }}
      >
        <span className="eyebrow">
          {displayName} · списания
        </span>
        <span
          style={{
            fontSize: "0.75rem",
            color: "var(--fg-faint)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {items === null
            ? "загрузка…"
            : `${items.length} за период`}
        </span>
      </div>

      {items !== null && items.length === 0 && (
        <p
          style={{
            padding: "0.75rem 0.25rem",
            color: "var(--fg-muted)",
            fontSize: "0.875rem",
          }}
        >
          Нет списаний за период.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {items?.map((w) => (
          <WriteoffRow key={w.id} w={w} />
        ))}
      </div>
    </div>
  );
}

function WriteoffRow({ w }: { w: StoreWriteoff }) {
  const statusRisk = STATUS_RISK[w.status] ?? "clean";
  return (
    <div
      className="flex items-start"
      style={{
        gap: "0.75rem",
        background: "var(--surface)",
        borderRadius: "var(--radius-ctl)",
        padding: "0.75rem",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <PhotoThumb url={w.photoUrl} />

      <div style={{ flexShrink: 0 }}>
        <RiskMeter score={w.riskScore} severity={w.severity} size={56} />
      </div>

      <div className="min-w-0" style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ fontWeight: 800, color: "var(--fg)", fontSize: "0.875rem" }}>
            {w.reasonLabel}
          </span>
          <span
            style={{
              color: "var(--fg-muted)",
              fontSize: "0.8125rem",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {w.qty} {w.unit}
            {w.valueCost != null ? ` · ${formatKztCompact(w.valueCost)}` : ""}
          </span>
          {w.withholding && (
            <span
              className="chip"
              style={{ background: "var(--chip-break-bg)", color: "var(--chip-break-ink)" }}
            >
              Удержание
            </span>
          )}
        </div>

        <div
          className="flex items-center flex-wrap"
          style={{ gap: "0.375rem", marginTop: "0.4rem" }}
        >
          {w.redFlags.slice(0, 3).map((f) => (
            <span
              key={f.feature}
              className="flex items-center"
              style={{
                gap: "0.3125rem",
                background: "var(--surface-2)",
                borderRadius: 9999,
                padding: "0.1565rem 0.5rem",
                fontSize: "0.6875rem",
                fontWeight: 600,
                color: "var(--fg-muted)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background: SEVERITY_DOT[f.severity],
                }}
              />
              {SHORT_FLAG[f.feature] ?? f.feature}
              <span style={{ color: "var(--fg-faint)" }}>+{f.points}</span>
            </span>
          ))}
          {w.redFlags.length === 0 && (
            <span style={{ fontSize: "0.6875rem", color: "var(--fg-faint)" }}>
              сигналов нет
            </span>
          )}
        </div>

        <p
          style={{
            marginTop: "0.35rem",
            fontSize: "0.6875rem",
            color: "var(--fg-faint)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatDateTime(w.createdAt)}
        </p>
      </div>

      <span
        className="pill-status"
        data-risk={statusRisk}
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        {STATUS_LABEL[w.status] ?? w.status}
      </span>
    </div>
  );
}

function PhotoThumb({ url }: { url: string | null }) {
  if (!url) {
    return (
      <div
        aria-label="Фото списания"
        style={{
          width: 56,
          height: 56,
          borderRadius: "var(--radius-ctl)",
          background: "var(--surface-2)",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="Фото списания"
      width={56}
      height={56}
      style={{
        width: 56,
        height: 56,
        objectFit: "cover",
        borderRadius: "var(--radius-ctl)",
        flexShrink: 0,
        background: "var(--surface-2)",
      }}
    />
  );
}
