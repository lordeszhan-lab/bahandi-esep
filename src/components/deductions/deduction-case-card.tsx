/**
 * DeductionCaseCard — presentational shell for one deduction case (Prompt 18).
 *
 * One-glance case file: WHO is charged, HOW MUCH, for WHAT, that it's legal,
 * and whose signature we're waiting on. The long legal-basis sentence lives
 * behind a "Показать основание акта" toggle so the face stays structured and
 * quiet; the act ref + open timestamp live in that same collapsible. The cap
 * is a green ShieldCheck quality badge, never a second number next to the hero.
 *
 * Calm premium-business surface — no ledges, no count-up, no confetti
 * (СВЕРКА joy-matrix: deductions = no joy).
 */

import { ChevronDown, ShieldCheck } from "lucide-react";
import { formatKztFull, formatDateTime } from "@/components/tower/format";
import { LABOR_CODE } from "@/lib/deductions/config";
import { DeductionStatusPill } from "./deduction-status-pill";
import type { DeductionView } from "@/lib/deductions/queries";

export interface DeductionCaseCardProps {
  d: DeductionView;
  /** Action area (buttons / forms) rendered in the card footer. */
  footer?: React.ReactNode;
}

export function DeductionCaseCard({ d, footer }: DeductionCaseCardProps) {
  return (
    <div
      className="rounded-2xl fade-up"
      style={{
        background: "var(--surface)",
        boxShadow: "var(--shadow-card)",
        border: "1px solid var(--border)",
      }}
    >
      {/* ── (1)+(2) Header: employee + status (left) · hero amount + cap badge (right) */}
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <DeductionStatusPill status={d.status} />
          <p
            className="mt-2 text-base font-bold leading-tight"
            style={{ color: "var(--fg)" }}
          >
            {d.employeeName}
          </p>
          <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
            {d.storeName}
            {d.storeCity ? `, ${d.storeCity}` : ""}
          </p>
        </div>
        <div className="text-right" style={{ flexShrink: 0 }}>
          <div
            style={{
              fontSize: "1.75rem",
              fontWeight: 800,
              lineHeight: 1.05,
              color: "var(--fg)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatKztFull(d.amount)}
          </div>
          <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
            к удержанию
          </div>
          <div className="mt-2">
            <CapBadge capped={d.capped} />
          </div>
        </div>
      </div>

      {/* ── (3) Face fields: За что · Дата акта */}
      <div className="px-5 pb-4 space-y-2">
        <Field label="За что">
          {d.reasonLabel} — {d.qty} {d.unit}
        </Field>
        <Field label="Дата акта">{formatDateTime(d.writeoffCreatedAt)}</Field>
      </div>

      {/* ── Dispute (meaningful — stays on the face) */}
      {d.disputeReason && (
        <div className="px-5 pb-3">
          <div
            className="rounded-xl px-3 py-2 text-xs"
            style={{
              background: "var(--risk-fraud-soft)",
              color: "var(--risk-fraud-ink)",
            }}
          >
            <span className="font-bold">Оспорено: </span>
            {d.disputeReason}
          </div>
        </div>
      )}

      {/* ── e-Signature proof (meaningful — stays on the face) */}
      {d.signature && d.acknowledgedAt && (
        <div className="px-5 pb-3">
          <div
            className="rounded-xl px-3 py-2 text-xs font-mono"
            style={{
              background: "var(--risk-clean-soft)",
              color: "var(--risk-clean-ink)",
              wordBreak: "break-all",
            }}
          >
            <span className="font-sans font-bold">Подпись: </span>
            {d.signature}
            <span className="font-sans" style={{ color: "var(--fg-muted)" }}>
              {" · "}
              {formatDateTime(d.acknowledgedAt)}
            </span>
          </div>
        </div>
      )}

      {/* ── (4) Collapsible legal basis + tech details (act ref, opened-at) */}
      <div className="px-5 pb-4">
        <details className="group">
          <summary
            className="flex items-center gap-1.5 cursor-pointer text-xs font-bold list-none [&::-webkit-details-marker]:hidden"
            style={{ color: "var(--fg-muted)" }}
          >
            <ChevronDown
              size={14}
              strokeWidth={1.9}
              className="deduction-chev"
            />
            Показать основание акта
          </summary>
          <div className="mt-2 space-y-2">
            <p
              className="text-xs leading-relaxed"
              style={{ color: "var(--fg-muted)" }}
            >
              {d.basis}
            </p>
            <div
              className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
              style={{ color: "var(--fg-faint)" }}
            >
              <span className="font-mono">акт #{d.writeoffRef}</span>
              <span>Открыто {formatDateTime(d.createdAt)}</span>
            </div>
          </div>
        </details>
      </div>

      {/* ── (5) Footer: actions */}
      {footer && (
        <div
          className="px-5 py-3 flex items-center gap-2 flex-wrap"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

/** Compact green legality badge — the 50%-of-wages cap is a quality mark, never a second number. */
function CapBadge({ capped }: { capped: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold"
      style={{
        background: "var(--risk-clean-soft)",
        color: "var(--risk-clean-ink)",
        whiteSpace: "nowrap",
      }}
    >
      <ShieldCheck size={14} strokeWidth={1.9} />
      {capped
        ? `Ограничено 50% зарплаты · ${LABOR_CODE.deduction}`
        : `В пределах 50% зарплаты · ${LABOR_CODE.deduction}`}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 items-baseline">
      <span
        className="text-xs font-semibold whitespace-nowrap"
        style={{ color: "var(--fg-muted)" }}
      >
        {label}
      </span>
      <span className="text-sm" style={{ color: "var(--fg)" }}>{children}</span>
    </div>
  );
}
