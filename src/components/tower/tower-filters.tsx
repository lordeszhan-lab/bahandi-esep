"use client";

/**
 * TowerFilters — city / format / date-range controls (Prompt C).
 *
 * Three shadcn Selects in a calm row. City + format are client state (they only
 * filter the already-loaded payload); the range preset re-fetches via a URL
 * searchParam so the server re-aggregates the window. Sentence-case Nunito
 * labels — never the uppercase eyebrow (this is a control, not a section head).
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FORMAT_META } from "./format";
import type { ReactNode } from "react";
import type { StoreFormat } from "@/lib/analytics/types";

const RANGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "7", label: "7 дней" },
  { value: "14", label: "14 дней" },
  { value: "30", label: "30 дней" },
];

export interface TowerFiltersProps {
  cities: Array<{ id: string; name: string }>;
  formats: StoreFormat[];
  cityId: string; // "all" or a city id
  format: string; // "all" or a StoreFormat
  rangeDays: number;
  onCityChange: (v: string) => void;
  onFormatChange: (v: string) => void;
  onRangeChange: (days: number) => void;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "block",
        fontSize: "0.8125rem",
        fontWeight: 600,
        color: "var(--fg-muted)",
        marginBottom: "0.375rem",
      }}
    >
      {children}
    </span>
  );
}

export function TowerFilters({
  cities,
  formats,
  cityId,
  format,
  rangeDays,
  onCityChange,
  onFormatChange,
  onRangeChange,
}: TowerFiltersProps) {
  return (
    <div
      className="flex flex-wrap items-end"
      style={{ gap: "0.75rem 1.25rem" }}
    >
      <div style={{ minWidth: 180 }}>
        <FieldLabel>Город</FieldLabel>
        <Select value={cityId} onValueChange={onCityChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все города</SelectItem>
            {cities.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div style={{ minWidth: 160 }}>
        <FieldLabel>Формат</FieldLabel>
        <Select value={format} onValueChange={onFormatChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все форматы</SelectItem>
            {formats.map((f) => (
              <SelectItem key={f} value={f}>
                {FORMAT_META[f].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div style={{ minWidth: 140 }}>
        <FieldLabel>Период</FieldLabel>
        <Select
          value={String(rangeDays)}
          onValueChange={(v) => onRangeChange(Number(v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
