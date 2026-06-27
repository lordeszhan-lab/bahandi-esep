"use client";

import { FlaskConical } from "lucide-react";
import { useDevPreview } from "@/lib/dev-preview";
import { ROLE_LABEL } from "@/lib/auth-shared";
import type { UserRole } from "@/lib/db/types";

export interface DevLocationOption {
  id: string;
  name: string;
}

export interface DevRoleSwitcherProps {
  realRole: UserRole;
  locations: DevLocationOption[];
}

const PREVIEW_ROLES: { value: UserRole | ""; label: string }[] = [
  { value: "", label: "Реальная роль" },
  { value: "employee", label: ROLE_LABEL.employee },
  { value: "reviewer", label: ROLE_LABEL.reviewer },
];

export function DevRoleSwitcher({
  realRole,
  locations,
}: DevRoleSwitcherProps) {
  const {
    preview,
    setPreviewRole,
    setPreviewLocationId,
    resetPreview,
  } = useDevPreview();

  const hasOverride = preview.role !== null || preview.locationId !== null;

  return (
    <div
      className="mx-1 mt-1 rounded-xl px-2.5 py-2 space-y-2"
      style={{ background: "var(--surface-2)" }}
    >
      <div className="flex items-center gap-1.5">
        <FlaskConical size={12} strokeWidth={1.75} style={{ color: "var(--fg-faint)" }} />
        <span
          className="eyebrow"
          style={{ fontSize: "0.625rem", color: "var(--fg-faint)" }}
        >
          DEV
        </span>
        {hasOverride && (
          <button
            type="button"
            onClick={resetPreview}
            className="ml-auto text-xs font-semibold transition-colors"
            style={{ color: "var(--fg-faint)" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "var(--fg-muted)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = "var(--fg-faint)";
            }}
          >
            Сброс
          </button>
        )}
      </div>

      <p style={{ fontSize: 11, lineHeight: 1.35, color: "var(--fg-faint)" }}>
        Предпросмотр UI · роль в БД: {ROLE_LABEL[realRole]}
      </p>

      <label className="block">
        <span className="label" style={{ fontSize: "0.6875rem", marginBottom: "0.25rem" }}>
          Роль
        </span>
        <select
          className="input"
          style={{ padding: "0.375rem 0.625rem", fontSize: "0.8125rem" }}
          value={preview.role ?? ""}
          onChange={(e) => {
            const val = e.target.value as UserRole | "";
            setPreviewRole(val || null);
          }}
        >
          {PREVIEW_ROLES.map(({ value, label }) => (
            <option key={value || "real"} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {locations.length > 0 && (
        <label className="block">
          <span className="label" style={{ fontSize: "0.6875rem", marginBottom: "0.25rem" }}>
            Точка
          </span>
          <select
            className="input"
            style={{ padding: "0.375rem 0.625rem", fontSize: "0.8125rem" }}
            value={preview.locationId ?? ""}
            onChange={(e) => {
              setPreviewLocationId(e.target.value || null);
            }}
          >
            <option value="">— не выбрана —</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
