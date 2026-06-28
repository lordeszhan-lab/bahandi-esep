"use client";

/**
 * RateVsBaseline — this employee's + location's write-off rates vs their
 * historical baselines (Prompt 12).
 *
 * Premium-minimal: a baseline line is shown ONLY when there is a real elevated
 * multiplier (factor > 1 with a real baseline). Non-elevated / no-data rows are
 * omitted entirely — never "нет данных", never "в норме". The card drops the
 * whole section when nothing is elevated. Each surviving row is a quiet
 * one-liner in neutral ink; the multiplier stays tabular-nums.
 */

import type { ReviewRates } from "@/lib/review/queue";

/** True when at least one of employee/location is elevated above its baseline. */
export function hasElevatedRates(rates: ReviewRates): boolean {
  return elevatedRows(rates).length > 0;
}

export function RateVsBaseline({ rates }: { rates: ReviewRates }) {
  const rows = elevatedRows(rates);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <p
          key={r.label}
          className="text-sm flex items-center gap-1.5"
          style={{ margin: 0 }}
        >
          <span style={{ color: "var(--fg-muted)" }}>{r.label}:</span>
          <span
            style={{
              color: "var(--fg)",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            в {fmtFactor(r.factor)}× выше нормы
          </span>
        </p>
      ))}
    </div>
  );
}

interface ElevatedRow {
  label: string;
  factor: number;
}

/** Only rows with a real baseline AND a multiplier above 1. */
function elevatedRows(rates: ReviewRates): ElevatedRow[] {
  const out: ElevatedRow[] = [];
  if (
    rates.employeeFactor != null &&
    rates.employeeFactor > 1 &&
    rates.employeeBaseline > 0
  ) {
    out.push({ label: "Сотрудник", factor: rates.employeeFactor });
  }
  if (
    rates.locationFactor != null &&
    rates.locationFactor > 1 &&
    rates.locationBaseline > 0
  ) {
    out.push({ label: "Точка", factor: rates.locationFactor });
  }
  return out;
}

/** One-decimal multiplier formatting (e.g. 2.62 → "2.6"). */
function fmtFactor(n: number): string {
  if (n < 1.05) return n.toFixed(2);
  return n.toFixed(1);
}
