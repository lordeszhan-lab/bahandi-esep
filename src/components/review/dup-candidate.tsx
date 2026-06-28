"use client";

/**
 * DupCandidate — the duplicate photo evidence when `dup_of` is set.
 *
 * This is the DOMINANT evidence block in the card's right column when a
 * pHash duplicate is flagged. Full risk-fraud-soft card, the match label
 * ("Точное совпадение фото" / "Совпадение N%") is the emphasized title, the
 * candidate thumbnail is large, and the origin metadata sits quietly below in
 * muted ink. Everything else in the right column is secondary to this.
 */

import { ImageOff } from "lucide-react";
import type { ReviewDupCandidate } from "@/lib/review/queue";

const THUMB_SIZE = 80;

export function DupCandidate({ candidate }: { candidate: ReviewDupCandidate }) {
  const matchLabel = dupMatchLabel(candidate.hammingDistance);

  return (
    <div
      style={{
        background: "var(--risk-fraud-soft)",
        borderRadius: "var(--radius-ctl)",
        padding: "0.9rem",
      }}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <span
          aria-hidden
          style={{
            width: 9,
            height: 9,
            borderRadius: 9999,
            background: "var(--risk-fraud)",
            flexShrink: 0,
          }}
        />
        <p
          style={{
            margin: 0,
            fontSize: "0.9375rem",
            fontWeight: 700,
            color: "var(--risk-fraud-ink)",
            lineHeight: 1.2,
          }}
        >
          {matchLabel}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <PhotoThumb url={candidate.photoUrl} alt="Дубликат" />
        <div className="min-w-0 flex-1">
          <p
            className="text-sm"
            style={{ fontWeight: 600, color: "var(--fg)", margin: 0 }}
          >
            {candidate.reasonLabel}
          </p>
          <p
            className="text-sm"
            style={{ color: "var(--fg-muted)", margin: 0 }}
          >
            {candidate.submitterName}
          </p>
          <p
            className="text-sm"
            style={{
              color: "var(--fg-muted)",
              fontVariantNumeric: "tabular-nums",
              margin: 0,
            }}
          >
            {formatDate(candidate.submittedAt)}
          </p>
        </div>
      </div>
    </div>
  );
}

export function PhotoThumb({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return <NoPhoto size={THUMB_SIZE} alt={alt} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      width={THUMB_SIZE}
      height={THUMB_SIZE}
      style={{
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        objectFit: "cover",
        borderRadius: "var(--radius-ctl)",
        flexShrink: 0,
        background: "var(--surface)",
      }}
    />
  );
}

/** Compact "Нет фото" state — surface card with a centered ImageOff icon. */
function NoPhoto({ size, alt }: { size: number; alt: string }) {
  return (
    <div
      aria-label={`Нет фото · ${alt}`}
      style={{
        width: size,
        height: size,
        borderRadius: "var(--radius-ctl)",
        background: "var(--surface)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ImageOff
        size={Math.round(size * 0.34)}
        strokeWidth={1.6}
        style={{ color: "var(--fg-muted)" }}
      />
    </div>
  );
}

/**
 * Map the Hamming distance to a plain-language match label.
 * distance 0 → "Точное совпадение фото"; otherwise "Совпадение N%" derived
 * from a 64-bit pHash (similarity = 1 − distance / 64), clamped to [1, 99].
 */
function dupMatchLabel(hammingDistance: number | null): string {
  if (hammingDistance == null) return "Точное совпадение фото";
  if (hammingDistance <= 0) return "Точное совпадение фото";
  const pct = Math.round((1 - hammingDistance / 64) * 100);
  const clamped = Math.max(1, Math.min(99, pct));
  return `Совпадение ${clamped}%`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
