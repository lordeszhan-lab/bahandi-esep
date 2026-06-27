import Link from "next/link";
import { ArrowRight, Clock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { IconChip } from "./icon-chip";

/**
 * ActionCard — white surface tile used for admin / section landing pages.
 *
 * Live (href provided):
 *   - Clickable card with hover lift + shadow upgrade (via .card class)
 *   - ArrowRight fades in at top-right on hover (CSS group-hover)
 *
 * Coming-soon (no href):
 *   - opacity 0.6, pointer-events none
 *   - Small Clock icon at top-right, no status pill, no status text
 */

export interface ActionCardProps {
  icon: LucideIcon;
  iconBg: string;
  iconInk: string;
  title: string;
  subtitle: string;
  /** Omit to render as a coming-soon card. */
  href?: string;
}

export function ActionCard({
  icon,
  iconBg,
  iconInk,
  title,
  subtitle,
  href,
}: ActionCardProps) {
  const isLive = !!href;

  const body = (
    <>
      {/* Top row: chip + directional affordance */}
      <div className="flex items-start justify-between mb-5">
        <IconChip Icon={icon} bg={iconBg} ink={iconInk} size={20} />
        {isLive ? (
          <ArrowRight
            size={16}
            strokeWidth={1.75}
            className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 mt-0.5"
            style={{ color: "var(--fg-muted)" }}
          />
        ) : (
          <Clock
            size={14}
            strokeWidth={1.75}
            className="mt-0.5"
            style={{ color: "var(--fg-faint)" }}
          />
        )}
      </div>

      <p
        className="text-base leading-snug mb-1"
        style={{ fontWeight: 700, color: "var(--fg)" }}
      >
        {title}
      </p>
      <p className="text-sm leading-normal" style={{ color: "var(--fg-muted)" }}>
        {subtitle}
      </p>
    </>
  );

  if (isLive) {
    return (
      <Link href={href} className="card p-6 block group">
        {body}
      </Link>
    );
  }

  return (
    <div className="card p-6" style={{ opacity: 0.6, pointerEvents: "none" }}>
      {body}
    </div>
  );
}
