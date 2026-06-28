"use client";

import type React from "react";
import { AlertTriangle, MapPin } from "lucide-react";

/**
 * Inline amber (risk-watch) alert shown when the captured GPS is outside
 * the location's geofence. This is a WATCH-level signal — never red/danger.
 */
export function GpsAlert({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className}
      role="alert"
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        background: "var(--risk-watch-soft)",
        borderRadius: "var(--radius-ctl)",
        padding: "0.75rem 1rem",
      }}
    >
      {/* Icon chip */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "2rem",
          height: "2rem",
          borderRadius: "0.5rem",
          background: "rgba(194, 65, 12, 0.12)",
          flexShrink: 0,
          color: "var(--risk-watch-ink)",
        }}
      >
        <AlertTriangle size={15} strokeWidth={1.75} />
      </span>

      <p
        style={{
          fontSize: "0.875rem",
          fontWeight: 600,
          color: "var(--risk-watch-ink)",
          lineHeight: 1.4,
          margin: 0,
        }}
      >
        Ваш GPS далеко от точки. Убедитесь, что вы на месте.
      </p>
    </div>
  );
}

/**
 * Soft, neutral alert shown when the chosen store has no coordinates yet
 * (pre-geocode). This is the capture-screen mirror of the risk engine's
 * `geofence_unverified` flag — never a hard fail, capture still works.
 */
export function GeofenceUnverifiedAlert({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={className}
      role="status"
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-ctl)",
        padding: "0.75rem 1rem",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "2rem",
          height: "2rem",
          borderRadius: "0.5rem",
          background: "var(--surface)",
          flexShrink: 0,
          color: "var(--fg-muted)",
        }}
      >
        <MapPin size={15} strokeWidth={1.75} />
      </span>

      <p
        style={{
          fontSize: "0.875rem",
          fontWeight: 600,
          color: "var(--fg-muted)",
          lineHeight: 1.4,
          margin: 0,
        }}
      >
        Координаты точки ещё не загружены — геозону не проверить.
      </p>
    </div>
  );
}
