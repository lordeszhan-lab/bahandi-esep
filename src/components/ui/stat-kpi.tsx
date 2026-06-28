"use client";

/**
 * StatKpi — a single count-up KPI for dashboards (Prompt 17).
 *
 * The СВЕРКА joy-matrix permits count-up on "KPI-числа на любых дашбордах" — the
 * only joy the Iiko reconciliation surface allows. Muted eyebrow label, a big
 * tabular-nums number that counts up to its target, and an optional risk-semantic
 * tone for the figure (synced=clean, syncing=info, on-hold=watch, failed=fraud).
 * `prefers-reduced-motion` jumps to the target (handled in `useCountUp`).
 */

import { useCountUp } from "@/components/tower/use-count-up";

type Tone = "clean" | "watch" | "fraud" | "info" | "muted";

const TONE_COLOR: Record<Tone, string> = {
  clean: "var(--risk-clean-ink)",
  watch: "var(--risk-watch-ink)",
  fraud: "var(--risk-fraud-ink)",
  info: "var(--risk-info-ink)",
  muted: "var(--fg)",
};

export interface StatKpiProps {
  label: string;
  value: number;
  /** Format the counted value; defaults to ru-RU integer grouping. */
  format?: (n: number) => string;
  tone?: Tone;
  caption?: string;
}

export function StatKpi({ label, value, format, tone = "muted", caption }: StatKpiProps) {
  const counted = useCountUp(value);
  const display = format
    ? format(counted)
    : Math.round(counted).toLocaleString("ru-RU");

  return (
    <div className="card" style={{ padding: "1.1rem 1.35rem" }}>
      <p className="eyebrow">{label}</p>
      <div
        style={{
          fontSize: "1.9rem",
          fontWeight: 800,
          lineHeight: 1.1,
          color: TONE_COLOR[tone],
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.01em",
          marginTop: 6,
        }}
      >
        {display}
      </div>
      {caption && (
        <p style={{ fontSize: "0.75rem", color: "var(--fg-faint)", marginTop: 6 }}>
          {caption}
        </p>
      )}
    </div>
  );
}
