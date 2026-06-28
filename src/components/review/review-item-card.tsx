"use client";

/**
 * ReviewItemCard — one triage row in the cockpit (Prompt 12).
 *
 * Hierarchy-first rebuild: a reviewer reads "approve or not, and why" in one
 * second. The visual weight order is:
 *   (1) reason title + amount  — the top strip (with a compact 96px photo)
 *   (2) VERDICT LINE           — the anchor: tier dot + risk word + short
 *                                reason, with the risk-meter inline to the right
 *   (3) duplicate evidence     — when phash_dup_hit, the dominant right-column
 *                                block (full risk-fraud-soft card)
 *   (4) signals list           — the contributing red flags
 *   (5) secondary one-liners   — vision verdict + elevated baseline only
 *
 * Empty blocks are never rendered as placeholders: no vision → no vision
 * section; no elevated baseline → no baseline line; no signals → no signals
 * section; nothing to show → no body grid at all. ONE accent colour per card
 * (the risk tier); everything else neutral. Calm by design — no confetti, no
 * ledge, no count-up; tabular-nums throughout.
 *
 * The one-tap Approve / Reject / Escalate / Request-more buttons call the
 * `decideReviewAction` server action directly; `useTransition` tracks pending
 * state per card. Buttons are intentionally unchanged.
 */

import { useTransition, useState } from "react";
import { Check, X, ArrowUp, MessageSquarePlus, ImageOff, MapPinOff } from "lucide-react";
import { decideReviewAction } from "@/lib/actions/review-decision";
import type { ReviewQueueItem, RiskSeverity } from "@/lib/review/queue";
import { RiskMeter } from "./risk-meter";
import { RedFlags } from "./red-flags";
import { RateVsBaseline, hasElevatedRates } from "./rate-vs-baseline";
import { VisionSummary } from "./vision-summary";
import { DupCandidate } from "./dup-candidate";

const STATUS_LABEL: Record<string, string> = {
  in_review: "На проверке",
  dual_control: "Двойной контроль",
  on_hold: "Уточнение",
  approved: "Утверждено",
  rejected: "Отклонено",
  submitted: "Подано",
  auto_approved: "Авто",
  draft: "Черновик",
};

/** Status → on-system pill risk tokens (independent of severity). */
const STATUS_RISK: Record<string, "clean" | "watch" | "fraud" | "info"> = {
  in_review: "info",
  dual_control: "watch",
  on_hold: "watch",
  approved: "clean",
  rejected: "fraud",
  submitted: "info",
  auto_approved: "clean",
  draft: "info",
};

const TIER_LABEL: Record<string, string> = {
  location_manager: "Менеджер",
  area: "Регион",
  finance: "Финансы",
};

// ── Verdict line ──────────────────────────────────────────────────────────────

const TIER_FILL: Record<RiskSeverity, string> = {
  clean: "var(--risk-clean)",
  watch: "var(--risk-watch)",
  fraud: "var(--risk-fraud)",
};

const TIER_INK: Record<RiskSeverity, string> = {
  clean: "var(--risk-clean-ink)",
  watch: "var(--risk-watch-ink)",
  fraud: "var(--risk-fraud-ink)",
};

const VERDICT_WORD: Record<RiskSeverity, string> = {
  clean: "Низкий риск",
  watch: "Требует проверки",
  fraud: "Высокий риск",
};

/** Short, plain, lowercase reason per contributing feature. */
const SHORT_REASON: Record<string, string> = {
  phash_dup_hit: "точный дубликат фото",
  vision_mismatch: "фото не соответствует заявке",
  vision_unverified: "фото не проверено",
  geofence_fail: "GPS вне геозоны",
  geofence_unverified: "нет координат точки",
  employee_high_rate: "сотрудник списывает чаще нормы",
  repeated_charge_target: "повторное списание на сотрудника",
  vision_low_confidence: "низкая уверенность распознавания",
  location_high_rate: "точка списывает чаще нормы",
  format_volume_anomaly: "объём выше нормы формата",
  format_reason_anomaly: "структура причин отклоняется",
  high_value: "крупная сумма",
  odd_hour: "вне рабочих часов",
  batch_burst: "офлайн-всплеск",
  non_camera_source: "не из камеры",
  capture_time_skew: "подозрительное время съёмки",
};

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  fraud: 0,
  watch: 1,
  clean: 2,
};

interface Verdict {
  word: string;
  reason: string;
  tier: RiskSeverity;
}

/**
 * Compose the verdict from the dominant signal:
 *  - phash_dup_hit  → "Высокий риск · точный дубликат фото" (fraud)
 *  - clean tier     → "Низкий риск · можно утвердить"
 *  - watch / fraud  → tier word + the dominant flag's short reason (if any)
 */
function verdictFor(item: ReviewQueueItem): Verdict {
  const flags = item.redFlags;
  if (flags.some((f) => f.feature === "phash_dup_hit")) {
    return { word: "Высокий риск", reason: "точный дубликат фото", tier: "fraud" };
  }
  const tier = item.severity;
  if (tier === "clean") {
    return { word: "Низкий риск", reason: "можно утвердить", tier: "clean" };
  }
  const dominant = [...flags].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.points - a.points,
  )[0];
  const reason = dominant ? SHORT_REASON[dominant.feature] ?? "" : "";
  return { word: VERDICT_WORD[tier], reason, tier };
}

export interface ReviewItemCardProps {
  item: ReviewQueueItem;
  /** True when the batch toolbar is open and clean rows show a checkbox. */
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** Fired after a decision lands so the queue can drop the card. */
  onDecided: (id: string, action: string) => void;
}

export function ReviewItemCard({
  item,
  selectMode,
  selected,
  onToggleSelect,
  onDecided,
}: ReviewItemCardProps) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showNote, setShowNote] = useState(false);
  // Geofence approve guard: when the reviewer clicks "Утвердить" on a write-off
  // whose photo was taken off-location (geofence_fail / geofence_unverified),
  // a confirm dialog opens before the decision lands. On confirm the approve
  // proceeds with an `approved_despite_geofence` audit override.
  const [showGeofenceConfirm, setShowGeofenceConfirm] = useState(false);

  function decide(
    action: "approve" | "reject" | "escalate" | "request_more",
    override?: string,
  ) {
    setError(null);
    const fd = new FormData();
    fd.set("writeoffId", item.id);
    fd.set("action", action);
    if (note.trim()) fd.set("note", note.trim());
    if (override) fd.set("override", override);
    startTransition(async () => {
      const res = await decideReviewAction(fd);
      if (res.ok) {
        onDecided(item.id, action);
      } else {
        setError(res.error ?? "Не удалось применить решение");
      }
    });
  }

  // Approve gate: clean (in-geofence) write-offs approve silently; off-location
  // write-offs open the confirm dialog first. The dialog calls `decide` with the
  // `approved_despite_geofence` override, which the state machine stamps into
  // the audit payload.
  function onApproveClick() {
    if (item.geofence.state === "ok") {
      decide("approve");
    } else {
      setShowGeofenceConfirm(true);
    }
  }

  function confirmApproveDespiteGeofence() {
    setShowGeofenceConfirm(false);
    decide("approve", "approved_despite_geofence");
  }

  const statusPillRisk = STATUS_RISK[item.status] ?? "info";
  const overdue = item.slaDueAt ? slaOverdue(item.slaDueAt) : false;
  const verdict = verdictFor(item);

  // Subline parts — only non-empty, joined with " · ".
  const sublineParts: string[] = [];
  if (item.chargedEmployee?.fullName) {
    const emp = item.chargedEmployee.position
      ? `${item.chargedEmployee.fullName} · ${item.chargedEmployee.position}`
      : item.chargedEmployee.fullName;
    sublineParts.push(emp);
  }
  if (item.location.name) sublineParts.push(item.location.name);

  // ── Conditional body content (no placeholder blocks) ──────────────────────
  const hasFlags = item.redFlags.length > 0;
  const hasDup = !!item.dupCandidate;
  const hasVision = !!item.photo?.vision;
  const hasElevated = hasElevatedRates(item.rates);

  const leftContent = hasFlags ? (
    <section>
      <p className="section-label mb-2">Сигналы</p>
      <RedFlags flags={item.redFlags} tier={item.severity} />
    </section>
  ) : null;

  const rightContent =
    hasDup || hasVision || hasElevated ? (
      <div className={hasDup ? "space-y-4" : "space-y-3"}>
        {hasDup && <DupCandidate candidate={item.dupCandidate!} />}
        {hasVision && <VisionSummary vision={item.photo!.vision} />}
        {hasElevated && <RateVsBaseline rates={item.rates} />}
      </div>
    ) : null;

  const hasBody = leftContent != null || rightContent != null;
  const twoColumns = leftContent != null && rightContent != null;

  return (
    <article
      className="card"
      style={{
        padding: 0,
        opacity: pending ? 0.55 : 1,
        transition: "opacity 160ms ease-out",
      }}
      aria-busy={pending}
    >
      {/* ── Top strip: select + photo + identity + status (#1) ──────────────── */}
      <div
        className="flex items-center gap-3 px-5 py-3.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {selectMode && item.bulkApprovable ? (
          <label
            className="flex items-center gap-2 cursor-pointer"
            style={{ flexShrink: 0 }}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(item.id)}
              style={{ width: 16, height: 16, accentColor: "var(--brand)" }}
            />
          </label>
        ) : (
          <span style={{ width: selectMode ? 16 : 0, flexShrink: 0 }} />
        )}

        <PhotoThumb url={item.photo?.url ?? null} alt="Фото списания" />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="text-base"
              style={{ fontWeight: 800, color: "var(--fg)" }}
            >
              {item.reason.labelRu}
            </span>
            <span
              className="text-sm"
              style={{
                color: "var(--fg-muted)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {item.qty} {item.unit}
              {item.valueCost != null
                ? ` · ${formatKzt(item.valueCost)}`
                : ""}
            </span>
            {item.withholding && (
              <span
                className="chip"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--fg-muted)",
                }}
              >
                Удержание
              </span>
            )}
          </div>
          {sublineParts.length > 0 && (
            <p
              className="text-sm"
              style={{ color: "var(--fg-muted)", marginTop: 2 }}
            >
              {sublineParts.join(" · ")}
            </p>
          )}
        </div>

        <span
          className="pill-status"
          data-risk={statusPillRisk}
          style={{ flexShrink: 0 }}
        >
          {STATUS_LABEL[item.status] ?? item.status}
        </span>
        {item.escalationTier && (
          <span
            className="section-label"
            style={{ color: "var(--fg-muted)", flexShrink: 0 }}
          >
            Эскалация: {TIER_LABEL[item.escalationTier] ?? item.escalationTier}
          </span>
        )}
        {item.slaDueAt && (
          <span
            className="text-sm"
            style={{
              color: overdue
                ? "var(--risk-fraud-ink)"
                : "var(--fg-muted)",
              fontVariantNumeric: "tabular-nums",
              flexShrink: 0,
            }}
          >
            {overdue
              ? "Просрочено"
              : `Решить до ${formatDeadline(item.slaDueAt)}`}
          </span>
        )}
      </div>

      {/* ── Geofence banner (#1b) — "filed off-location" signal, fraud-red ────── */}
      {item.geofence.state !== "ok" && (
        <GeofenceBanner geofence={item.geofence} />
      )}

      {/* ── Body: verdict line (#2) + evidence/signals (#3–#5) ──────────────── */}
      <div className="px-5 py-5">
        {/* VERDICT LINE — the anchor */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                borderRadius: 9999,
                background: TIER_FILL[verdict.tier],
                flexShrink: 0,
              }}
            />
            <span
              className="text-base"
              style={{
                fontWeight: 700,
                color: TIER_INK[verdict.tier],
                whiteSpace: "nowrap",
              }}
            >
              {verdict.word}
            </span>
            {verdict.reason && (
              <span
                className="text-sm"
                style={{ color: "var(--fg-muted)" }}
              >
                · {verdict.reason}
              </span>
            )}
          </div>
          <div style={{ width: 72, flexShrink: 0 }}>
            <RiskMeter
              score={item.riskScore}
              severity={item.severity}
              size={72}
            />
          </div>
        </div>

        {/* Body grid — only when there is something to show */}
        {hasBody && (
          <div
            className="grid gap-6 mt-5"
            style={{
              gridTemplateColumns: twoColumns
                ? "minmax(0, 1fr) minmax(0, 1fr)"
                : "1fr",
            }}
          >
            {leftContent}
            {rightContent}
          </div>
        )}
      </div>

      {/* ── Action row (unchanged) ──────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 px-5 py-3 flex-wrap"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        {showNote && (
          <input
            className="input"
            placeholder="Комментарий к решению…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ flex: 1, minWidth: 200, minHeight: 40 }}
            disabled={pending}
          />
        )}
        <ActionButton
          icon={Check}
          label="Утвердить"
          onClick={onApproveClick}
          disabled={pending}
          variant="primary"
        />
        <ActionButton
          icon={X}
          label="Отклонить"
          onClick={() => decide("reject")}
          disabled={pending}
          variant="danger"
        />
        <ActionButton
          icon={ArrowUp}
          label="Эскалировать"
          onClick={() => decide("escalate")}
          disabled={pending}
          variant="neutral"
        />
        <ActionButton
          icon={MessageSquarePlus}
          label="Запросить ещё"
          onClick={() => {
            setShowNote(true);
            decide("request_more");
          }}
          disabled={pending}
          variant="neutral"
        />
        {error && (
          <span
            className="text-sm"
            style={{ color: "var(--risk-fraud-ink)", marginLeft: "auto" }}
          >
            {error}
          </span>
        )}
      </div>

      {/* ── Geofence approve guard ─────────────────────────────────────────── */}
      {showGeofenceConfirm && (
        <GeofenceConfirmDialog
          geofence={item.geofence}
          pending={pending}
          onCancel={() => setShowGeofenceConfirm(false)}
          onConfirm={confirmApproveDespiteGeofence}
        />
      )}
    </article>
  );
}

// ── Action button (unchanged) ─────────────────────────────────────────────────

type ActionVariant = "primary" | "danger" | "neutral";

const VARIANT_STYLE: Record<
  ActionVariant,
  { bg: string; ink: string; hover: string }
> = {
  primary: {
    bg: "var(--brand)",
    ink: "#ffffff",
    hover: "var(--brand-strong)",
  },
  danger: {
    bg: "var(--risk-fraud-soft)",
    ink: "var(--risk-fraud-ink)",
    hover: "var(--risk-fraud)",
  },
  neutral: {
    bg: "var(--surface-2)",
    ink: "var(--fg)",
    hover: "var(--border)",
  },
};

function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  variant,
}: {
  icon: typeof Check;
  label: string;
  onClick: () => void;
  disabled: boolean;
  variant: ActionVariant;
}) {
  const v = VARIANT_STYLE[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 text-sm font-bold"
      style={{
        background: v.bg,
        color: v.ink,
        border: "none",
        borderRadius: 9999,
        padding: "0.5rem 0.9rem",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 150ms ease-out, transform 120ms ease-out",
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = v.hover;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = v.bg;
      }}
      onMouseDown={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.98)";
      }}
      onMouseUp={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
      }}
    >
      <Icon size={15} strokeWidth={2.25} />
      {label}
    </button>
  );
}

// ── Geofence banner — "filed off-location" signal (fraud-red) ────────────────

function geofenceBannerText(geofence: ReviewQueueItem["geofence"]): string {
  if (geofence.state === "fail") {
    const dist =
      geofence.distanceM != null
        ? new Intl.NumberFormat("ru-RU").format(Math.round(geofence.distanceM))
        : "—";
    return `GPS вне точки · ~${dist} м от адреса`;
  }
  // unverified — no coords to measure against
  return "GPS вне точки · нет координат точки";
}

function GeofenceBanner({ geofence }: { geofence: ReviewQueueItem["geofence"] }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 px-5 py-2.5"
      style={{
        background: "var(--risk-fraud-soft)",
        color: "var(--risk-fraud-ink)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <MapPinOff size={17} strokeWidth={2.2} style={{ flexShrink: 0 }} />
      <span className="text-sm" style={{ fontWeight: 700 }}>
        {geofenceBannerText(geofence)}
      </span>
    </div>
  );
}

// ── Geofence approve guard — confirm dialog ───────────────────────────────────

function geofenceConfirmBody(geofence: ReviewQueueItem["geofence"]): string {
  if (geofence.state === "fail") {
    const dist =
      geofence.distanceM != null
        ? new Intl.NumberFormat("ru-RU").format(Math.round(geofence.distanceM))
        : "—";
    return `GPS при съёмке не совпал с адресом точки (расстояние ~${dist} м). Это частый признак списания не на месте. Утвердить всё равно?`;
  }
  return "GPS при съёмке не проверен (нет координат точки). Это частый признак списания не на месте. Утвердить всё равно?";
}

function GeofenceConfirmDialog({
  geofence,
  pending,
  onCancel,
  onConfirm,
}: {
  geofence: ReviewQueueItem["geofence"];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="geofence-confirm-title"
      className="flex items-center justify-center"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(15, 23, 42, 0.45)",
        padding: "1rem",
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{
          padding: 0,
          width: "100%",
          maxWidth: 440,
          boxShadow: "var(--shadow-card)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2.5 px-5 py-3.5"
          style={{
            background: "var(--risk-fraud-soft)",
            color: "var(--risk-fraud-ink)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <MapPinOff size={18} strokeWidth={2.2} style={{ flexShrink: 0 }} />
          <span
            id="geofence-confirm-title"
            className="text-base"
            style={{ fontWeight: 800 }}
          >
            Фото сделано вне локации точки
          </span>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm" style={{ color: "var(--fg)", lineHeight: 1.5 }}>
            {geofenceConfirmBody(geofence)}
          </p>
        </div>
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="text-sm font-bold"
            style={{
              background: "var(--surface-2)",
              color: "var(--fg)",
              border: "none",
              borderRadius: 9999,
              padding: "0.5rem 1rem",
              cursor: pending ? "not-allowed" : "pointer",
              opacity: pending ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="flex items-center gap-1.5 text-sm font-bold"
            style={{
              background: "var(--brand)",
              color: "#ffffff",
              border: "none",
              borderRadius: 9999,
              padding: "0.5rem 1rem",
              cursor: pending ? "not-allowed" : "pointer",
              opacity: pending ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            <Check size={15} strokeWidth={2.25} />
            Утвердить с пометкой
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Photo (compact 96px) ──────────────────────────────────────────────────────

function PhotoThumb({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <div
        aria-label={`Нет фото · ${alt}`}
        style={{
          width: 96,
          height: 96,
          borderRadius: "var(--radius-ctl)",
          background: "var(--surface-2)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        }}
      >
        <ImageOff size={30} strokeWidth={1.6} style={{ color: "var(--fg-muted)" }} />
        <span
          style={{
            fontSize: "0.6875rem",
            fontWeight: 600,
            color: "var(--fg-muted)",
            lineHeight: 1,
          }}
        >
          Нет фото
        </span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      width={96}
      height={96}
      style={{
        width: 96,
        height: 96,
        objectFit: "cover",
        borderRadius: "var(--radius-ctl)",
        flexShrink: 0,
        background: "var(--surface-2)",
      }}
    />
  );
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatKzt(n: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "KZT",
    maximumFractionDigits: 0,
  }).format(n);
}

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function slaOverdue(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}
