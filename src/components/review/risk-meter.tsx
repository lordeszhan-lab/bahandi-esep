"use client";

/**
 * RiskMeter — a calm top-semicircle gauge (green → amber → red).
 *
 * Static SVG in a fixed 96×60 viewBox (wider than tall — only the top half of
 * the ring is shown). A faint track traces the full semicircle; the value arc
 * sweeps left→right by `score/100`, coloured by `severity`. The score number
 * sits visually INSIDE the arc (just under the apex) and the tier caption
 * ("Чисто/Внимание/Риск") sits directly beneath it on the same vertical axis —
 * a tight centered pair, never floating in the empty lower area. No count-up,
 * no animation; tabular-nums throughout.
 */

import type { RiskSeverity } from "@/lib/review/queue";

export interface RiskMeterProps {
  score: number;
  severity: RiskSeverity;
  /** Rendered pixel width (height scales to keep the 96×60 aspect). Default 96. */
  size?: number;
}

const SEVERITY_COLOR: Record<RiskSeverity, string> = {
  clean: "var(--risk-clean)",
  watch: "var(--risk-watch)",
  fraud: "var(--risk-fraud)",
};

const SEVERITY_INK: Record<RiskSeverity, string> = {
  clean: "var(--risk-clean-ink)",
  watch: "var(--risk-watch-ink)",
  fraud: "var(--risk-fraud-ink)",
};

const SEVERITY_LABEL: Record<RiskSeverity, string> = {
  clean: "Чисто",
  watch: "Внимание",
  fraud: "Риск",
};

// ── Fixed geometry (viewBox units, 96×60) ─────────────────────────────────────
const VB_W = 96;
const VB_H = 60;
const CX = 48;
const CY = 52; // arc baseline near the bottom
const R = 40;
const STROKE = 9;
const START_X = CX - R; // 8
const START_Y = CY; // 52
const END_X = CX + R; // 88
const NUMBER_Y = 42; // inside the arc, just under the apex
const CAPTION_Y = 56; // directly beneath the number, same axis

/** Two-decimal rounding so SSR and client produce identical SVG path strings. */
const r = (n: number) => Number(n.toFixed(2));

export function RiskMeter({ score, severity, size = 96 }: RiskMeterProps) {
  const frac = Math.max(0, Math.min(1, score / 100));
  const color = SEVERITY_COLOR[severity];
  const ink = SEVERITY_INK[severity];

  // Value arc end point: angle θ = 180 − 180·f (degrees), measured from +x.
  // endX = cx + R·cos(θ), endY = cy − R·sin(θ)  (y flipped → arc bulges up).
  const theta = (180 - 180 * frac) * (Math.PI / 180);
  const endX = r(CX + R * Math.cos(theta));
  const endY = r(CY - R * Math.sin(theta));

  const trackD = `M ${START_X} ${START_Y} A ${R} ${R} 0 0 1 ${END_X} ${START_Y}`;
  const valueD = `M ${START_X} ${START_Y} A ${R} ${R} 0 0 1 ${endX} ${endY}`;

  // Rendered pixel size scales the fixed 96×60 viewBox; geometry stays exact.
  const renderW = size;
  const renderH = Math.round(size * (VB_H / VB_W));

  return (
    <div
      className="mx-auto flex flex-col items-center"
      style={{ width: renderW }}
      aria-label={`Скор риска ${score} из 100, ${SEVERITY_LABEL[severity]}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
    >
      <svg
        width={renderW}
        height={renderH}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        style={{ display: "block" }}
      >
        <path
          d={trackD}
          fill="none"
          stroke="var(--border)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
        {frac > 0 && (
          <path
            d={valueD}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
        )}
        <text
          x={CX}
          y={NUMBER_Y}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={24}
          fontWeight={800}
          style={{
            fill: "var(--fg)",
            fontVariantNumeric: "tabular-nums",
            fontFamily: "inherit",
          }}
        >
          {Math.round(score)}
        </text>
        <text
          x={CX}
          y={CAPTION_Y}
          textAnchor="middle"
          fontSize={10}
          fontWeight={600}
          style={{ fill: ink, fontFamily: "inherit" }}
        >
          {SEVERITY_LABEL[severity]}
        </text>
      </svg>
    </div>
  );
}
