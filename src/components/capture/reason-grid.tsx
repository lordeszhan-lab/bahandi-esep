"use client";

import {
  FlaskConical,
  CircleX,
  Zap,
  Leaf,
  Undo2,
  Wine,
  type LucideIcon,
} from "lucide-react";
import type { ReasonCode, ReasonCategory } from "@/lib/db/types";

// ── Category metadata ─────────────────────────────────────────────────────────

interface CategoryMeta {
  icon: LucideIcon;
  chipClass: string;
  bg: string;
  ink: string;
}

const CATEGORY_META: Record<ReasonCategory, CategoryMeta> = {
  yield: {
    icon: FlaskConical,
    chipClass: "chip-tech",
    bg: "var(--chip-tech-bg)",
    ink: "var(--chip-tech-ink)",
  },
  quality: {
    icon: CircleX,
    chipClass: "chip-quality",
    bg: "var(--chip-quality-bg)",
    ink: "var(--chip-quality-ink)",
  },
  accidental: {
    icon: Zap,
    chipClass: "chip-damage",
    bg: "var(--chip-damage-bg)",
    ink: "var(--chip-damage-ink)",
  },
  spoilage: {
    icon: Leaf,
    chipClass: "chip-spoil",
    bg: "var(--chip-spoil-bg)",
    ink: "var(--chip-spoil-ink)",
  },
  return: {
    icon: Undo2,
    chipClass: "chip-return",
    bg: "var(--chip-return-bg)",
    ink: "var(--chip-return-ink)",
  },
  breakage: {
    icon: Wine,
    chipClass: "chip-break",
    bg: "var(--chip-break-bg)",
    ink: "var(--chip-break-ink)",
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

interface ReasonGridProps {
  reasonCodes: ReasonCode[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function ReasonGrid({ reasonCodes, selected, onSelect }: ReasonGridProps) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(2, 1fr)" }}
    >
      {reasonCodes.map((rc) => {
        const cat = rc.category as ReasonCategory;
        const meta = CATEGORY_META[cat] ?? CATEGORY_META.yield;
        const Icon = meta.icon;
        const isSelected = selected === rc.id;

        return (
          <button
            key={rc.id}
            type="button"
            onClick={() => onSelect(rc.id)}
            style={{
              background: isSelected ? "var(--brand)" : meta.bg,
              color: isSelected ? "#fff" : meta.ink,
              borderRadius: "var(--radius-card)",
              padding: "1rem",
              border: isSelected
                ? "2px solid var(--brand)"
                : "2px solid transparent",
              boxShadow: isSelected
                ? "0 0 0 3px var(--brand-ring), var(--shadow-card-hover)"
                : "var(--shadow-card)",
              transform: isSelected ? "translateY(-2px)" : "translateY(0)",
              transition:
                "background 150ms, color 150ms, box-shadow 150ms, transform 150ms",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "0.625rem",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              className="flex items-center justify-center w-10 h-10 rounded-xl"
              style={{
                background: isSelected ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.06)",
              }}
            >
              <Icon size={22} />
            </span>
            <span className="text-sm font-bold leading-snug">
              {rc.label_ru}
            </span>
          </button>
        );
      })}
    </div>
  );
}
