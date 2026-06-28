"use client";

/**
 * VisionSummary — the gpt-4o-mini claim-match verdict, condensed.
 *
 * Returns null when there is no vision analysis so the card omits the whole
 * section (never "отсутствует"). When present it renders as a quiet secondary
 * line — a muted verdict + confidence (and visible-qty when available) — with
 * the model's terse notes below in readable --fg. The risk colour stays on the
 * verdict line; this block is supporting evidence, not a second accent.
 */

import type { ReviewVisionSummary } from "@/lib/review/queue";

const VERDICT_LABEL: Record<ReviewVisionSummary["verdict"], string> = {
  ok: "Совпадает",
  mismatch: "Несоответствие",
  inconclusive: "Не проверено",
};

export function VisionSummary({ vision }: { vision: ReviewVisionSummary | null }) {
  if (!vision) return null;
  const conf =
    vision.confidence != null ? `${Math.round(vision.confidence * 100)}%` : null;

  const metaParts: string[] = [VERDICT_LABEL[vision.verdict]];
  if (conf) metaParts.push(`увер. ${conf}`);
  if (vision.visibleQty != null) metaParts.push(`видно: ${vision.visibleQty}`);

  return (
    <div className="space-y-1">
      <p
        className="text-sm"
        style={{ color: "var(--fg-muted)", margin: 0 }}
      >
        Vision · {metaParts.join(" · ")}
      </p>
      {vision.notes && (
        <p
          className="text-sm"
          style={{ color: "var(--fg)", margin: 0 }}
        >
          {vision.notes}
        </p>
      )}
    </div>
  );
}
