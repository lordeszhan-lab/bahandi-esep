import type { LucideIcon } from "lucide-react";

/**
 * Pastel squircle containing a single Lucide outline icon.
 * bg = pastel fill (low saturation), ink = saturated icon colour.
 */
export interface IconChipProps {
  Icon: LucideIcon;
  bg: string;
  ink: string;
  /** Icon size in px. Default 20. */
  size?: number;
}

export function IconChip({ Icon, bg, ink, size = 20 }: IconChipProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "2.75rem",
        height: "2.75rem",
        background: bg,
        color: ink,
        borderRadius: "var(--radius-chip)",
        flexShrink: 0,
      }}
    >
      <Icon size={size} strokeWidth={1.75} />
    </span>
  );
}
