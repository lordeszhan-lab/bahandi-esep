"use client";

/**
 * TowerFormatChart — kiosk vs mall vs magnum vs market (Prompt C).
 *
 * A small composed chart: bars for loss-per-store (left axis, KZT) and a line
 * for flagged % (right axis). recharts themed with our tokens — brand green
 * bars, risk-watch amber line, neutral grid/axes — never the default rainbow
 * palette. Animation is off (the Tower is calm; only KPI count-up moves).
 */

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { FORMAT_META, formatKztCompact, formatPct } from "./format";
import type { PerFormat, StoreFormat } from "@/lib/analytics/types";

const SHOWN: StoreFormat[] = ["kiosk", "mall", "magnum", "market"];

export interface TowerFormatChartProps {
  perFormat: PerFormat[];
}

interface ChartRow {
  label: string;
  loss: number;
  flagged: number; // 0–100
  format: StoreFormat;
}

export function TowerFormatChart({ perFormat }: TowerFormatChartProps) {
  const byFormat = new Map<StoreFormat, PerFormat>(perFormat.map((f) => [f.format, f]));
  const rows: ChartRow[] = SHOWN.map((f) => {
    const p = byFormat.get(f);
    return {
      label: FORMAT_META[f].label,
      loss: p?.lossPerStore ?? 0,
      flagged: (p?.flaggedPct ?? 0) * 100,
      format: f,
    };
  });

  const hasData = rows.some((r) => r.loss > 0 || r.flagged > 0);

  if (!hasData) {
    return (
      <div className="card" style={{ padding: "1.5rem", height: 300 }}>
        <p className="eyebrow">Сравнение форматов</p>
        <p
          style={{
            marginTop: "1.25rem",
            color: "var(--fg-muted)",
            fontSize: "0.875rem",
          }}
        >
          Недостаточно данных за период.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: "1.25rem 1.5rem 1.5rem" }}>
      <div className="flex items-center justify-between" style={{ marginBottom: "0.75rem" }}>
        <p className="eyebrow">Сравнение форматов</p>
        <div className="flex items-center" style={{ gap: "1rem" }}>
          <LegendDot color="var(--brand)" label="Потери на точку" />
          <LegendDot color="var(--risk-watch)" label="Флаг %" />
        </div>
      </div>

      <div style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer>
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeDasharray="3 3"
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={{ fill: "var(--fg-muted)", fontSize: 12, fontWeight: 600 }}
              dy={8}
            />
            <YAxis
              yAxisId="loss"
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--fg-faint)", fontSize: 11 }}
              tickFormatter={(v: number) => formatKztCompact(v)}
              width={64}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              domain={[0, 100]}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--fg-faint)", fontSize: 11 }}
              tickFormatter={(v: number) => `${Math.round(v)}%`}
              width={36}
            />
            <Tooltip
              cursor={{ fill: "color-mix(in srgb, var(--fg) 5%, transparent)" }}
              content={<FormatTooltip />}
            />
            <Bar
              yAxisId="loss"
              dataKey="loss"
              fill="var(--brand)"
              radius={[6, 6, 0, 0]}
              maxBarSize={56}
              isAnimationActive={false}
            />
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="flagged"
              stroke="var(--risk-watch)"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "var(--risk-watch)", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="flex items-center"
      style={{ gap: "0.375rem", fontSize: "0.75rem", color: "var(--fg-muted)" }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: 9999, background: color }}
      />
      {label}
    </span>
  );
}

interface TooltipPayloadItem {
  dataKey: string;
  value: number;
  name: string;
  color: string;
}

function FormatTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const loss = payload.find((p) => p.dataKey === "loss")?.value ?? 0;
  const flagged = payload.find((p) => p.dataKey === "flagged")?.value ?? 0;
  return (
    <div
      style={{
        background: "var(--surface)",
        borderRadius: "var(--radius-ctl)",
        boxShadow: "var(--shadow-card-hover)",
        border: "1px solid var(--border)",
        padding: "0.625rem 0.75rem",
        fontSize: "0.8125rem",
      }}
    >
      <div style={{ fontWeight: 800, color: "var(--fg)", marginBottom: 4 }}>
        {label}
      </div>
      <Row label="Потери на точку" value={formatKztCompact(loss)} />
      <Row label="Флаг" value={`${Math.round(flagged)}%`} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ gap: "1rem", fontVariantNumeric: "tabular-nums" }}
    >
      <span style={{ color: "var(--fg-muted)" }}>{label}</span>
      <span style={{ fontWeight: 700, color: "var(--fg)" }}>{value}</span>
    </div>
  );
}
