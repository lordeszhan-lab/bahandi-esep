/**
 * Tower formatting + categorical maps — Prompt C.
 *
 * Shared by every Tower component so the numbers, format chips and risk
 * severities read consistently. tabular-nums is applied in the components (via
 * `font-variant-numeric`); the strings here are the values themselves.
 *
 * Money is compact (₽ млн / тыс) for KPI + leaderboard density, full only where
 * exactness matters. Percent is rounded. Risk = colour + label (colourblind-safe
 * — the severity is always paired with an icon/label in the UI).
 */

import {
  Store,
  Building2,
  ShoppingBag,
  ShoppingCart,
  type LucideIcon,
} from "lucide-react";
import type { RiskSeverity, StoreFormat } from "@/lib/analytics/types";

// ── Money ─────────────────────────────────────────────────────────────────────

/** Compact KZT: ₸1.2 млн · ₸234 тыс · ₸8 500. Drops a trailing .0 on millions. */
export function formatKztCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) {
    const v = n / 1_000_000;
    const s = v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
    return `₸${s} млн`;
  }
  if (a >= 100_000) return `₸${Math.round(n / 1_000)} тыс`;
  return `₸${Math.round(n).toLocaleString("ru-RU")}`;
}

/** Exact KZT with ru-RU grouping (used where precision matters). */
export function formatKztFull(n: number): string {
  return `₸${Math.round(n).toLocaleString("ru-RU")}`;
}

// ── Percent + counts ──────────────────────────────────────────────────────────

/**
 * Percent from a 0–1 fraction (the RPC returns flagged_pct / auto_approve_rate
 * as fractions, e.g. 0.12). Renders 12 %, 8.3 % for small values, 0 % for zero.
 */
export function formatPct(fraction: number): string {
  const pct = fraction * 100;
  if (!Number.isFinite(pct) || pct === 0) return "0%";
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("ru-RU");
}

/** "28 июн, 14:32" — for the drill-down rows. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Severity (risk = colour + label) ──────────────────────────────────────────

/** Map a 0–100 risk score to the triad severity. */
export function severityFromScore(score: number): RiskSeverity {
  if (score >= 60) return "fraud";
  if (score >= 15) return "watch";
  return "clean";
}

export const SEVERITY_LABEL: Record<RiskSeverity, string> = {
  clean: "Чисто",
  watch: "Внимание",
  fraud: "Риск",
};

/**
 * The unexplained-gap meter: gap as a share of theoretical usage
 * (theoretical = documented_loss + gap). >25 % unexplained → fraud (a real leak),
 * >10 % → watch, else clean. Score is that ratio scaled so the meter reads
 * meaningfully (a 30 % gap ≈ 60 on the gauge).
 */
export function gapSeverity(
  gap: number,
  totalLoss: number,
): { score: number; severity: RiskSeverity; ratio: number } {
  const theoretical = totalLoss + gap;
  const ratio = theoretical > 0 ? gap / theoretical : 0;
  const score = Math.min(100, Math.round(ratio * 200));
  const severity: RiskSeverity = ratio > 0.25 ? "fraud" : ratio > 0.1 ? "watch" : "clean";
  return { score, severity, ratio };
}

// ── Format → chip (pastel bg + saturated ink icon, the signature motif) ───────

export interface FormatMeta {
  Icon: LucideIcon;
  bg: string;
  ink: string;
  label: string;
}

/** Pastel categorical chips — backgrounds only, never the risk triad (no red). */
export const FORMAT_META: Record<StoreFormat, FormatMeta> = {
  kiosk: { Icon: Store, bg: "var(--chip-tech-bg)", ink: "var(--chip-tech-ink)", label: "Киоск" },
  mall: { Icon: Building2, bg: "var(--chip-quality-bg)", ink: "var(--chip-quality-ink)", label: "ТЦ" },
  magnum: { Icon: ShoppingBag, bg: "var(--chip-spoil-bg)", ink: "var(--chip-spoil-ink)", label: "Магнум" },
  market: { Icon: ShoppingCart, bg: "var(--chip-damage-bg)", ink: "var(--chip-damage-ink)", label: "Рынок" },
  street: { Icon: Store, bg: "var(--chip-break-bg)", ink: "var(--chip-break-ink)", label: "Улица" },
};

// ── Trend (half-over-half delta) ──────────────────────────────────────────────

export interface Trend {
  /** Signed % change, second half vs first half. null when not computable. */
  deltaPct: number | null;
  /** When true, an increase is good (green); when false, an increase is bad (red). */
  positiveIsGood: boolean;
}

export function pctChange(prev: number, curr: number): number | null {
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return null;
  if (prev === 0) return curr === 0 ? 0 : null; // can't % from zero → flat / unknown
  return ((curr - prev) / prev) * 100;
}

/** Trend arrow direction from a delta (±1 % deadband). */
export function trendDirection(deltaPct: number | null): "up" | "down" | "flat" {
  if (deltaPct == null || Math.abs(deltaPct) < 1) return "flat";
  return deltaPct > 0 ? "up" : "down";
}

/** Risk-semantic colour for a trend: good → clean, bad → fraud, flat → muted. */
export function trendColor(t: Trend): string {
  const dir = trendDirection(t.deltaPct);
  if (dir === "flat") return "var(--fg-faint)";
  const isIncrease = dir === "up";
  const good = isIncrease === t.positiveIsGood;
  return good ? "var(--risk-clean)" : "var(--risk-fraud)";
}

export function formatTrend(deltaPct: number | null): string {
  if (deltaPct == null) return "—";
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${Math.round(deltaPct)}%`;
}
