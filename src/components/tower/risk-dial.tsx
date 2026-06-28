"use client";

/**
 * RiskDial — compact per-store flagged-% gauge for the Tower leaderboard.
 *
 * Arc fill = flaggedPct; ring colour + label follow flagged-% tier thresholds.
 * The numeric value is overlaid and centred inside the ring — never clipped.
 */

import type { RiskSeverity } from "@/lib/analytics/types";

// TUNE: flagged-% tier boundaries (fraction 0–1 → clean / watch / critical)
const FLAGGED_DIAL_THRESHOLDS = {
  watch: 0.30,
  critical: 0.70,
} as const;

const TIER_COLOR: Record<RiskSeverity, string> = {
  clean: "var(--risk-clean)",
  watch: "var(--risk-watch)",
  fraud: "var(--risk-fraud)",
};

const TIER_LABEL: Record<RiskSeverity, string> = {
  clean: "Чисто",
  watch: "Внимание",
  fraud: "Критично",
};

export function severityFromFlaggedPct(fraction: number): RiskSeverity {
  if (fraction >= FLAGGED_DIAL_THRESHOLDS.critical) return "fraud";
  if (fraction >= FLAGGED_DIAL_THRESHOLDS.watch) return "watch";
  return "clean";
}

export interface RiskDialProps {
  /** Flagged fraction 0–1 (same as PerStore.flaggedPct). */
  flaggedPct: number;
  /** Outer width in px. Default 56. */
  size?: number;
}

export function RiskDial({ flaggedPct, size = 56 }: RiskDialProps) {
  const pct = Math.round(flaggedPct * 100);
  const severity = severityFromFlaggedPct(flaggedPct);
  const color = TIER_COLOR[severity];
  const label = TIER_LABEL[severity];
  const frac = Math.max(0, Math.min(1, flaggedPct));

  const stroke = 5;
  const ringSize = size - 8;
  const cx = ringSize / 2;
  const cy = ringSize / 2 + 4;
  const r = ringSize / 2 - stroke / 2 - 1;

  const startAngle = 180;
  const endAngle = 360;
  const valueAngle = startAngle + (endAngle - startAngle) * frac;

  const trackD = arcPath(cx, cy, r, startAngle, endAngle);
  const valueD = frac > 0 ? arcPath(cx, cy, r, startAngle, valueAngle) : "";

  const digits = String(pct).length;
  const numSize = digits >= 3 ? 11 : digits >= 2 ? 13 : 15;

  return (
    <div
      className="flex flex-col items-center"
      style={{ width: size }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`Флаг ${pct}%, ${label}`}
    >
      <div
        className="relative mx-auto"
        style={{ width: ringSize, height: ringSize - 6 }}
      >
        <svg
          width={ringSize}
          height={ringSize - 6}
          viewBox={`0 0 ${ringSize} ${ringSize - 6}`}
          aria-hidden
        >
          <path
            d={trackD}
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          {valueD && (
            <path
              d={valueD}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          )}
        </svg>
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ paddingBottom: 6 }}
        >
          <span
            style={{
              fontSize: numSize,
              fontWeight: 800,
              lineHeight: 1,
              color: "var(--fg)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {pct}
          </span>
        </div>
      </div>
      <span
        style={{
          marginTop: -4,
          fontSize: "0.625rem",
          fontWeight: 700,
          lineHeight: 1.2,
          color,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
