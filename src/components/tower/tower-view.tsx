"use client";

/**
 * TowerView — the control-tower screen (Prompt C).
 *
 * Assembles the four required regions: the network KPI row (count-up + trend
 * arrows + a risk-meter on the unexplained gap), the city → store roll-up
 * (Алматы via its 3 clusters), the format comparison chart, and the store
 * leaderboard with the problem kiosk on top. City + format filters are client
 * state over the single round-trip payload; the range preset re-fetches via a
 * URL searchParam so Postgres re-aggregates the window. Calm, premium, no joy
 * beyond the KPI count-up.
 */

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TowerKpiCard } from "./tower-kpi-card";
import { TowerFilters } from "./tower-filters";
import { TowerCityRollup } from "./tower-city-rollup";
import { TowerFormatChart } from "./tower-format-chart";
import { TowerLeaderboard } from "./tower-leaderboard";
import {
  formatKztCompact,
  gapSeverity,
  type Trend,
} from "./format";
import type {
  PerCity,
  PerCluster,
  PerStore,
  TowerAnalytics,
  TowerFilterOptions,
} from "@/lib/analytics/types";

export interface TowerTrends {
  totalLoss: Trend;
  fraudCaughtValue: Trend;
  recoveredValue: Trend;
  unexplainedGap: Trend;
}

export interface TowerViewProps {
  analytics: TowerAnalytics;
  filters: TowerFilterOptions;
  trends: TowerTrends;
  rangeDays: number;
  from: string;
  to: string;
}

export function TowerView({
  analytics,
  filters,
  trends,
  rangeDays,
  from,
  to,
}: TowerViewProps) {
  const router = useRouter();
  const [cityId, setCityId] = useState("all");
  const [format, setFormat] = useState("all");

  const { kpis, perStore, perFormat, perCity, perCluster } = analytics;

  function onRangeChange(days: number) {
    router.push(`/review/tower?range=${days}`);
  }

  const rollupCities: PerCity[] =
    cityId === "all" ? perCity : perCity.filter((c) => c.cityId === cityId);
  const rollupClusters: PerCluster[] = perCluster;
  const rollupStores: PerStore[] = perStore;

  const leaderboardStores: PerStore[] = perStore.filter(
    (s) =>
      (cityId === "all" || s.cityId === cityId) &&
      (format === "all" || s.format === format),
  );

  const gapMeter = gapSeverity(kpis.unexplainedGap, kpis.totalLoss);
  const periodLabel = `Последние ${rangeDays} дн.`;
  const dateSpan = `${fmtDay(from)} — ${fmtDay(to)}`;
  const isEmpty = kpis.totalWriteoffs === 0 && kpis.totalLoss === 0;

  return (
    <div style={{ maxWidth: 1240, margin: "0 auto", padding: "1.5rem 1.25rem 3rem" }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-end justify-between flex-wrap" style={{ gap: "0.75rem", marginBottom: "1.25rem" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 800, color: "var(--fg)", letterSpacing: "-0.01em" }}>
            Башня
          </h1>
          <p style={{ color: "var(--fg-muted)", fontSize: "0.875rem", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
            {periodLabel} · {dateSpan}
          </p>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────────────── */}
      <div className="card" style={{ padding: "1rem 1.25rem", marginBottom: "1.25rem" }}>
        <TowerFilters
          cities={filters.cities}
          formats={filters.formats}
          cityId={cityId}
          format={format}
          rangeDays={rangeDays}
          onCityChange={setCityId}
          onFormatChange={setFormat}
          onRangeChange={onRangeChange}
        />
      </div>

      {isEmpty ? (
        <div className="card" style={{ padding: "2rem" }}>
          <p className="eyebrow">Сеть</p>
          <p style={{ marginTop: "0.75rem", color: "var(--fg-muted)", fontSize: "0.9375rem" }}>
            За период нет данных. Запустите <code style={{ fontVariantNumeric: "tabular-nums" }}>npm run seed:history</code> и
            убедитесь, что миграция аналитики применена.
          </p>
        </div>
      ) : (
        <>
          {/* ── KPI row ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" style={{ gap: "1rem", marginBottom: "1.5rem" }}>
            <TowerKpiCard
              label="Потери сети"
              value={kpis.totalLoss}
              format={formatKztCompact}
              trend={trends.totalLoss}
            />
            <TowerKpiCard
              label="Задержано фрода"
              value={kpis.fraudCaughtValue}
              format={formatKztCompact}
              trend={trends.fraudCaughtValue}
              caption={`${kpis.fraudCaughtCount} списаний на удержании`}
            />
            <TowerKpiCard
              label="Восстановлено в Iiko"
              value={kpis.recoveredValue}
              format={formatKztCompact}
              trend={trends.recoveredValue}
            />
            <TowerKpiCard
              label="Необъяснимый разрыв"
              value={kpis.unexplainedGap}
              format={formatKztCompact}
              trend={trends.unexplainedGap}
              meter={{ score: gapMeter.score, severity: gapMeter.severity }}
            />
          </div>

          {/* ── City rollup + Format chart ──────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: "1rem", marginBottom: "1.5rem" }}>
            <section>
              <SectionTitle>Города</SectionTitle>
              <TowerCityRollup
                cities={rollupCities}
                clusters={rollupClusters}
                stores={rollupStores}
                formatFilter={format}
              />
            </section>
            <section>
              <SectionTitle>Форматы</SectionTitle>
              <TowerFormatChart perFormat={perFormat} />
            </section>
          </div>

          {/* ── Leaderboard ─────────────────────────────────────── */}
          <section>
            <SectionTitle>Лидеры точек</SectionTitle>
            <TowerLeaderboard stores={leaderboardStores} from={from} to={to} />
          </section>
        </>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p
      className="eyebrow"
      style={{ marginBottom: "0.625rem", paddingLeft: "0.125rem" }}
    >
      {children}
    </p>
  );
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}
