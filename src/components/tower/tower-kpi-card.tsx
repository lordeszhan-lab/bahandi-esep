"use client";

/**
 * TowerKpiCard — one number in the network KPI row (Prompt C).
 *
 * Calm premium-fintech card: a muted eyebrow label, a big tabular-nums number
 * that counts up (the only joy the Tower permits), and a risk-semantic trend
 * arrow. The unexplained-gap card additionally carries a `RiskMeter` so the
 * headline leak reads as a gauge, not just a figure. No ledges, no confetti.
 */

import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { RiskMeter } from "@/components/review/risk-meter";
import { useCountUp } from "./use-count-up";
import {
  formatTrend,
  trendColor,
  trendDirection,
  type Trend,
} from "./format";
import type { RiskSeverity } from "@/lib/analytics/types";

export interface TowerKpiCardProps {
  label: string;
  value: number;
  format: (n: number) => string;
  trend?: Trend;
  /** Optional risk-meter (the unexplained-gap card). */
  meter?: { score: number; severity: RiskSeverity };
  /** Small caption under the number, e.g. "к первой половине". */
  caption?: string;
}

export function TowerKpiCard({
  label,
  value,
  format,
  trend,
  meter,
  caption,
}: TowerKpiCardProps) {
  const counted = useCountUp(value);
  const dir = trend ? trendDirection(trend.deltaPct) : "flat";
  const Arrow = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const color = trend ? trendColor(trend) : "var(--fg-faint)";

  return (
    <div className="card" style={{ padding: "1.25rem 1.5rem" }}>
      <p className="eyebrow">{label}</p>
      <div className="flex items-end justify-between gap-3" style={{ marginTop: 6 }}>
        <div className="min-w-0">
          <div
            style={{
              fontSize: meter ? "1.75rem" : "2rem",
              fontWeight: 800,
              lineHeight: 1.1,
              color: "var(--fg)",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.01em",
            }}
          >
            {format(counted)}
          </div>
          {trend && (
            <div
              className="flex items-center gap-1.5"
              style={{ marginTop: 8, fontVariantNumeric: "tabular-nums" }}
            >
              <Arrow size={15} strokeWidth={2.25} style={{ color }} />
              <span style={{ fontSize: "0.8125rem", fontWeight: 700, color }}>
                {formatTrend(trend.deltaPct)}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--fg-faint)" }}>
                {caption ?? "к первой половине"}
              </span>
            </div>
          )}
          {!trend && caption && (
            <p style={{ fontSize: "0.75rem", color: "var(--fg-faint)", marginTop: 8 }}>
              {caption}
            </p>
          )}
        </div>
        {meter && (
          <div style={{ flexShrink: 0 }}>
            <RiskMeter score={meter.score} severity={meter.severity} size={76} />
          </div>
        )}
      </div>
    </div>
  );
}
