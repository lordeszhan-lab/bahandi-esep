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
import { IconChip } from "@/components/ui/icon-chip";
import type { ReasonCode, ReasonCategory } from "@/lib/db/types";

// ── Category → chip colours ───────────────────────────────────────────────────
// Pastel bg + saturated ink per СВЕРКА design system.
// Colour lives ONLY in the squircle chip — card title stays --fg.

interface CategoryMeta {
  icon: LucideIcon;
  bg: string;
  bgHover: string;    // slightly deeper pastel on card hover
  ink: string;
}

const CATEGORY_META: Record<ReasonCategory, CategoryMeta> = {
  yield: {
    icon: FlaskConical,
    bg: "var(--chip-tech-bg)",
    bgHover: "#E2E6EA",
    ink: "var(--chip-tech-ink)",
  },
  quality: {
    icon: CircleX,
    bg: "var(--chip-quality-bg)",
    bgHover: "#C8EAF8",
    ink: "var(--chip-quality-ink)",
  },
  accidental: {
    icon: Zap,
    bg: "var(--chip-damage-bg)",
    bgHover: "#FFE4C4",
    ink: "var(--chip-damage-ink)",
  },
  spoilage: {
    icon: Leaf,
    bg: "var(--chip-spoil-bg)",
    bgHover: "#BFEDDF",
    ink: "var(--chip-spoil-ink)",
  },
  return: {
    icon: Undo2,
    bg: "var(--chip-return-bg)",
    bgHover: "#ECD6FF",
    ink: "var(--chip-return-ink)",
  },
  breakage: {
    icon: Wine,
    bg: "var(--chip-break-bg)",
    bgHover: "#FFF0B0",
    ink: "var(--chip-break-ink)",
  },
};

// ── Card ──────────────────────────────────────────────────────────────────────

interface ReasonCardProps {
  rc: ReasonCode;
  meta: CategoryMeta;
  isSelected: boolean;
  animDelay: number;
  onSelect: () => void;
}

function ReasonCard({
  rc,
  meta,
  isSelected,
  animDelay,
  onSelect,
}: ReasonCardProps) {
  return (
    <button
      key={rc.id}
      type="button"
      role="radio"
      aria-checked={isSelected}
      data-selected={isSelected}
      onClick={onSelect}
      // fade-up handled by .fade-up class + inline delay
      className="reason-card fade-up text-left"
      style={{
        // Selected overrides the .reason-card bg/shadow/transform
        ...(isSelected
          ? {
              background: "var(--brand)",
              boxShadow:
                "0 0 0 3px var(--brand-ring), var(--shadow-card-hover)",
              transform: "translateY(-2px)",
            }
          : {}),
        borderRadius: "var(--radius-card)",
        padding: "1.125rem",
        border: "none",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "0.625rem",
        animationDelay: `${animDelay}ms`,
      }}
    >
      {/* Pastel squircle chip — colour layer */}
      <IconChip
        Icon={meta.icon}
        bg={isSelected ? "rgba(255,255,255,0.22)" : meta.bg}
        ink={isSelected ? "#fff" : meta.ink}
        size={20}
      />

      {/* Title — always neutral --fg except when selected (white) */}
      <span
        style={{
          fontSize: "0.875rem",
          fontWeight: 700,
          lineHeight: 1.3,
          color: isSelected ? "#fff" : "var(--fg)",
        }}
      >
        {rc.label_ru}
      </span>
    </button>
  );
}

// ── Grid ──────────────────────────────────────────────────────────────────────

interface ReasonGridProps {
  reasonCodes: ReasonCode[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function ReasonGrid({ reasonCodes, selected, onSelect }: ReasonGridProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Причина списания"
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(2, 1fr)" }}
    >
      {reasonCodes.map((rc, i) => {
        const cat = rc.category as ReasonCategory;
        const meta = CATEGORY_META[cat] ?? CATEGORY_META.yield;
        return (
          <ReasonCard
            key={rc.id}
            rc={rc}
            meta={meta}
            isSelected={selected === rc.id}
            animDelay={i * 45}
            onSelect={() => onSelect(rc.id)}
          />
        );
      })}
    </div>
  );
}
