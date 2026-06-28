"use client";

/**
 * RedFlags — the specific signals that drove this write-off's risk score.
 *
 * Each contributing feature from `risk_features` is rendered as a compact row:
 * a tier-coloured dot, the human-facing label, and the point contribution in
 * tabular-nums. The dots all use the CARD's overall risk tier (one accent per
 * card, per СВЕРКА design system) — the reviewer reads the tier from the
 * verdict line, and the +N chips show which signals weighed most. Biggest
 * contributors sort first.
 */

import type { ReviewRedFlag, RiskSeverity } from "@/lib/review/queue";

const FEATURE_LABELS: Record<string, string> = {
  phash_dup_hit: "Повторное фото",
  vision_mismatch: "Фото не соответствует заявке",
  vision_unverified: "Фото не проверено",
  geofence_fail: "GPS вне геозоны",
  geofence_unverified: "Нет координат точки",
  employee_high_rate: "Сотрудник списывает чаще нормы",
  repeated_charge_target: "Повторное списание на сотрудника",
  vision_low_confidence: "Низкая уверенность распознавания",
  location_high_rate: "Точка списывает чаще нормы",
  format_volume_anomaly: "Объём выше нормы формата",
  format_reason_anomaly: "Структура причин отклоняется от формата",
  high_value: "Крупная сумма",
  odd_hour: "Вне рабочих часов",
  batch_burst: "Оффлайн-всплеск",
  non_camera_source: "Не из камеры",
  capture_time_skew: "Подозрительное время съёмки",
};

const TIER_DOT: Record<RiskSeverity, string> = {
  fraud: "var(--risk-fraud)",
  watch: "var(--risk-watch)",
  clean: "var(--risk-clean)",
};

export function RedFlags({
  flags,
  tier,
}: {
  flags: ReviewRedFlag[];
  /** The card's overall risk tier — every dot uses this single accent. */
  tier: RiskSeverity;
}) {
  if (flags.length === 0) return null;
  const dot = TIER_DOT[tier];
  const ordered = [...flags].sort((a, b) => b.points - a.points);
  return (
    <ul className="space-y-2">
      {ordered.map((f) => (
        <li key={f.feature} className="flex items-center gap-2.5 text-sm">
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: 9999,
              background: dot,
              flexShrink: 0,
            }}
          />
          <span style={{ color: "var(--fg)", flex: 1 }}>
            {FEATURE_LABELS[f.feature] ?? f.feature}
          </span>
          <span
            className="chip"
            style={{
              background: "var(--surface-2)",
              color: "var(--fg-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            +{f.points}
          </span>
        </li>
      ))}
    </ul>
  );
}
