"use client";

/**
 * TowerCityRollup — city → store drill (Prompt C).
 *
 * A calm, dense list: one row per city with its loss + flagged %. Expanding a
 * city reveals its stores; Алматы drills through its 3 clusters first (each
 * cluster expandable to its stores), every other city expands straight to its
 * stores. No joy — just the hierarchy and the numbers, tabular-nums throughout.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { IconChip } from "@/components/ui/icon-chip";
import { FORMAT_META, formatCount, formatKztCompact, formatPct } from "./format";
import type { PerCity, PerCluster, PerStore, StoreFormat } from "@/lib/analytics/types";

const ALMATY = "Алматы";

export interface TowerCityRollupProps {
  cities: PerCity[];
  clusters: PerCluster[];
  stores: PerStore[];
  /** "all" or a StoreFormat — filters the store rows inside each drill. */
  formatFilter: string;
}

export function TowerCityRollup({
  cities,
  clusters,
  stores,
  formatFilter,
}: TowerCityRollupProps) {
  const [openCities, setOpenCities] = useState<Set<string>>(new Set());
  const [openClusters, setOpenClusters] = useState<Set<string>>(new Set());

  function toggleCity(id: string) {
    setOpenCities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleCluster(id: string) {
    setOpenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const fmtOk = (f: StoreFormat) => formatFilter === "all" || f === formatFilter;

  return (
    <div className="card" style={{ padding: 0 }}>
      {/* Header row */}
      <div
        className="flex items-center"
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border)",
          gap: "0.75rem",
        }}
      >
        <span style={{ width: 24, flexShrink: 0 }} />
        <span className="eyebrow" style={{ flex: 1 }}>
          Город
        </span>
        <NumHead width={64} align="right">
          Точки
        </NumHead>
        <NumHead width={96} align="right">
          Потери
        </NumHead>
        <NumHead width={64} align="right">
          Флаг
        </NumHead>
      </div>

      {cities.length === 0 && (
        <p
          style={{
            padding: "1.25rem 1rem",
            color: "var(--fg-muted)",
            fontSize: "0.875rem",
          }}
        >
          Нет данных за период.
        </p>
      )}

      {cities.map((c) => {
        const open = openCities.has(c.cityId);
        const isAlmaty = c.city === ALMATY;
        const cityClusters = isAlmaty
          ? clusters.filter((cl) => cl.cityId === c.cityId)
          : [];
        const cityStores = stores.filter(
          (s) => s.cityId === c.cityId && fmtOk(s.format),
        );

        return (
          <div key={c.cityId} style={{ borderBottom: "1px solid var(--border)" }}>
            <Row
              onClick={() => toggleCity(c.cityId)}
              expanded={open}
              label={c.city}
              meta={`${formatCount(c.storeCount)} точек`}
              primary={formatKztCompact(c.totalLoss)}
              secondary={formatPct(c.flaggedPct)}
              bold
            />
            {open && (
              <div style={{ background: "var(--surface-2)" }}>
                {isAlmaty
                  ? cityClusters.map((cl) => {
                      const clOpen = openClusters.has(cl.clusterId);
                      const clStores = stores.filter(
                        (s) => s.clusterId === cl.clusterId && fmtOk(s.format),
                      );
                      return (
                        <div key={cl.clusterId}>
                          <Row
                            onClick={() => toggleCluster(cl.clusterId)}
                            expanded={clOpen}
                            label={cl.clusterName}
                            meta={`${formatCount(cl.storeCount)} точек`}
                            primary={formatKztCompact(cl.totalLoss)}
                            secondary={formatPct(cl.flaggedPct)}
                            indent={1}
                          />
                          {clOpen && (
                            <div>
                              {clStores.length === 0 ? (
                                <EmptyRow indent={2} />
                              ) : (
                                clStores.map((s) => (
                                  <StoreRow key={s.storeId} s={s} indent={2} />
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  : cityStores.length === 0
                    ? <EmptyRow indent={1} />
                    : cityStores.map((s) => (
                        <StoreRow key={s.storeId} s={s} indent={1} />
                      ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────────

function Row({
  onClick,
  expanded,
  label,
  meta,
  primary,
  secondary,
  bold,
  indent = 0,
}: {
  onClick: () => void;
  expanded: boolean;
  label: string;
  meta: string;
  primary: string;
  secondary: string;
  bold?: boolean;
  indent?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center w-full text-left"
      style={{
        padding: "0.7rem 1rem",
        gap: "0.75rem",
        paddingLeft: `calc(1rem + ${indent * 1.25}rem)`,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        transition: "background 120ms ease-out",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "color-mix(in srgb, var(--fg) 4%, transparent)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <ChevronRight
        size={16}
        strokeWidth={2.25}
        style={{
          flexShrink: 0,
          color: "var(--fg-muted)",
          transform: expanded ? "rotate(90deg)" : "none",
          transition: "transform 150ms ease-out",
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontWeight: bold ? 800 : 600,
          color: "var(--fg)",
          fontSize: bold ? "0.9375rem" : "0.875rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span
        style={{
          width: 64,
          flexShrink: 0,
          textAlign: "right",
          fontSize: "0.75rem",
          color: "var(--fg-faint)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {meta}
      </span>
      <NumCell width={96}>{primary}</NumCell>
      <NumCell width={64}>{secondary}</NumCell>
    </button>
  );
}

function StoreRow({ s, indent }: { s: PerStore; indent: number }) {
  const meta = FORMAT_META[s.format];
  return (
    <div
      className="flex items-center"
      style={{
        padding: "0.6rem 1rem",
        gap: "0.75rem",
        paddingLeft: `calc(1rem + ${indent * 1.25}rem)`,
      }}
    >
      <IconChip Icon={meta.Icon} bg={meta.bg} ink={meta.ink} size={16} />
      <span
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
        {s.displayName}
      </span>
      <span
        style={{
          width: 64,
          flexShrink: 0,
          textAlign: "right",
          fontSize: "0.75rem",
          color: "var(--fg-faint)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatCount(s.writeoffCount)}
      </span>
      <NumCell width={96}>{formatKztCompact(s.totalLoss)}</NumCell>
      <NumCell width={64}>{formatPct(s.flaggedPct)}</NumCell>
    </div>
  );
}

function EmptyRow({ indent }: { indent: number }) {
  return (
    <p
      style={{
        padding: "0.6rem 1rem",
        paddingLeft: `calc(1rem + ${indent * 1.25}rem)`,
        color: "var(--fg-faint)",
        fontSize: "0.8125rem",
      }}
    >
      Нет списаний за период.
    </p>
  );
}

function NumHead({
  children,
  width,
  align,
}: {
  children: ReactNode;
  width: number;
  align: "left" | "right";
}) {
  return (
    <span
      className="eyebrow"
      style={{
        width,
        flexShrink: 0,
        textAlign: align,
      }}
    >
      {children}
    </span>
  );
}

function NumCell({
  children,
  width,
}: {
  children: ReactNode;
  width: number;
}) {
  return (
    <span
      style={{
        width,
        flexShrink: 0,
        textAlign: "right",
        fontSize: "0.8125rem",
        fontWeight: 700,
        color: "var(--fg)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </span>
  );
}
