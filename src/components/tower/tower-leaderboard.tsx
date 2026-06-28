"use client";

/**
 * TowerLeaderboard — all stores ranked by unexplained gap / loss (Prompt C).
 *
 * The problem kiosk surfaces at the top (highest gap). Each row: format IconChip
 * + "city — display_name" + tabular-nums metrics (gap coloured by gap severity,
 * loss, flagged %, count) + a per-store flagged-% dial. Clicking a row
 * expands its write-off list inline (`TowerStoreWriteoffList` — the cockpit list,
 * reused). Only stores with activity in the window appear; empty stores would
 * just be noise. One expanded at a time. Calm, no joy.
 */

import { useState, type ReactNode, type CSSProperties } from "react";
import { IconChip } from "@/components/ui/icon-chip";
import { RiskDial } from "./risk-dial";
import { TowerStoreWriteoffList } from "./tower-store-writeoff-list";
import {
  FORMAT_META,
  formatCount,
  formatKztCompact,
  formatPct,
  gapSeverity,
} from "./format";
import type { PerStore } from "@/lib/analytics/types";

export interface TowerLeaderboardProps {
  stores: PerStore[];
  from: string;
  to: string;
}

export function TowerLeaderboard({ stores, from, to }: TowerLeaderboardProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  // Only stores with activity (write-offs or a gap) — empty stores are noise.
  const ranked = stores.filter(
    (s) => s.writeoffCount > 0 || (s.unexplainedGap != null && s.unexplainedGap > 0),
  );

  if (ranked.length === 0) {
    return (
      <div className="card" style={{ padding: "1.5rem" }}>
        <p className="eyebrow">Лидерборд точек</p>
        <p
          style={{
            marginTop: "0.75rem",
            color: "var(--fg-muted)",
            fontSize: "0.875rem",
          }}
        >
          Нет активных точек за период.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        className="flex items-center"
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border)",
          gap: "0.75rem",
        }}
      >
        <span style={{ width: 28, flexShrink: 0 }} />
        <span style={{ width: 44, flexShrink: 0 }} />
        <span className="eyebrow" style={{ flex: 1 }}>
          Точка
        </span>
        <HeadCell width={92} className="hidden md:block">
          Разрыв
        </HeadCell>
        <HeadCell width={96}>Потери</HeadCell>
        <HeadCell width={56} className="hidden lg:block">
          Флаг
        </HeadCell>
        <HeadCell width={40} className="hidden lg:block">
          Кол.
        </HeadCell>
        <span style={{ width: 68, flexShrink: 0 }} />
      </div>

      {ranked.map((s, i) => {
        const isOpen = expanded === s.storeId;
        const gap = s.unexplainedGap ?? 0;
        const g = gapSeverity(gap, s.totalLoss);
        const meta = FORMAT_META[s.format];

        return (
          <div key={s.storeId} style={{ borderBottom: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : s.storeId)}
              className="flex items-center w-full text-left"
              style={{
                padding: "0.625rem 1rem",
                gap: "0.75rem",
                background: isOpen ? "var(--surface-2)" : "transparent",
                border: "none",
                cursor: "pointer",
                transition: "background 120ms ease-out",
              }}
              onMouseEnter={(e) => {
                if (!isOpen)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "color-mix(in srgb, var(--fg) 4%, transparent)";
              }}
              onMouseLeave={(e) => {
                if (!isOpen)
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
              aria-expanded={isOpen}
            >
              <span
                style={{
                  width: 28,
                  flexShrink: 0,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: "0.8125rem",
                  fontWeight: 700,
                  color: "var(--fg-faint)",
                }}
              >
                {i + 1}
              </span>
              <span style={{ flexShrink: 0 }}>
                <IconChip Icon={meta.Icon} bg={meta.bg} ink={meta.ink} size={18} />
              </span>
              <span
                className="min-w-0"
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: "var(--fg)",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ color: "var(--fg-muted)", fontWeight: 500 }}>
                  {s.city} ·{" "}
                </span>
                {s.displayName}
              </span>

              <MetricCell
                width={92}
                className="hidden md:block"
                style={{ color: g.severity === "clean" ? "var(--fg)" : `var(--risk-${g.severity}-ink)` }}
              >
                {s.unexplainedGap == null ? "—" : formatKztCompact(gap)}
              </MetricCell>
              <MetricCell width={96}>{formatKztCompact(s.totalLoss)}</MetricCell>
              <MetricCell width={56} className="hidden lg:block">
                {formatPct(s.flaggedPct)}
              </MetricCell>
              <MetricCell width={40} className="hidden lg:block">
                {formatCount(s.writeoffCount)}
              </MetricCell>

              <span style={{ flexShrink: 0 }}>
                <RiskDial flaggedPct={s.flaggedPct} size={56} />
              </span>
            </button>

            {isOpen && (
              <div style={{ padding: "0 1rem 1rem" }}>
                <TowerStoreWriteoffList
                  storeId={s.storeId}
                  displayName={s.displayName}
                  from={from}
                  to={to}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HeadCell({
  children,
  width,
  className,
}: {
  children: ReactNode;
  width: number;
  className?: string;
}) {
  return (
    <span
      className={`eyebrow ${className ?? ""}`}
      style={{ width, flexShrink: 0, textAlign: "right" }}
    >
      {children}
    </span>
  );
}

function MetricCell({
  children,
  width,
  className,
  style,
}: {
  children: ReactNode;
  width: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={className}
      style={{
        width,
        flexShrink: 0,
        textAlign: "right",
        fontSize: "0.8125rem",
        fontWeight: 700,
        color: "var(--fg)",
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
