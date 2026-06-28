"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  CloudOff,
  CloudUpload,
  Loader2,
  MapPin,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { CameraCapture, type CaptureResult } from "./camera";
import { ReasonGrid } from "./reason-grid";
import { GpsAlert, GeofenceUnverifiedAlert } from "./gps-alert";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionLabel } from "@/components/ui/section-label";
import { storeIsGeocoded, geofenceState } from "@/lib/geo/geofence";
import type { SubmitResult } from "@/lib/actions/submit-writeoff";
import { getMaterialLiabilityEmployees } from "@/lib/actions/get-location-employees";
import {
  CAPTURE_LOCATION_STORAGE_KEY,
  resolveCaptureLocationId,
  type CurrentProfile,
} from "@/lib/auth-shared";
import { useWriteoffQueue } from "@/lib/offline/use-writeoff-queue";
import type { QueueStatus } from "@/lib/offline/queue";
import { fetchVisionPrefill } from "@/lib/llm/vision-client";
import type { VisionPrefill } from "@/lib/llm/vision-prefill";
import type {
  ReasonCode,
  ReasonCategory,
  Employee,
  Store,
} from "@/lib/db/types";

// ── Constants ─────────────────────────────────────────────────────────────────

const UNITS = ["кг", "г", "л", "мл", "шт", "порц"];

/**
 * Prompt 6: below this confidence the model's suggestion is shown only as a
 * hint and never auto-selected. ≥ this threshold we pre-fill reason + qty and
 * mark it with an "AI предложил" chip the user can override.
 */
const AI_CONFIDENCE_THRESHOLD = 0.5;

/** Map a vision reason_code_key (a loss category) to a concrete reason_codes row. */
function matchReasonByCategory(
  reasonCodes: ReasonCode[],
  key: VisionPrefill["reason_code_key"],
): ReasonCode | null {
  return (
    reasonCodes.find((rc) => rc.key === key) ??
    reasonCodes.find((rc) => rc.category === key) ??
    null
  );
}

/** Russian label for a loss category, for the low-confidence hint chip. */
const CATEGORY_LABEL_RU: Record<ReasonCategory, string> = {
  yield: "технологический выход",
  quality: "брак качества",
  accidental: "случайное повреждение",
  spoilage: "порча / срок годности",
  return: "возврат гостя",
  breakage: "бой",
};

// Section stagger delays (ms). Fixed so GPS-alert presence doesn't shift others.
const S = {
  header: 0,
  gpsAlert: 45,
  reasonSection: 90,
  qtySection: 135,
  withholdingSection: 180,
  employeeSection: 225,
  commentSection: 270,
} as const;

interface FormState {
  reasonCodeId: string;
  qty: string;
  unit: string;
  withholding: boolean;
  chargedEmployeeId: string;
  comment: string;
}

const INITIAL_FORM: FormState = {
  reasonCodeId: "",
  qty: "",
  unit: "кг",
  withholding: false,
  chargedEmployeeId: "",
  comment: "",
};

// ── Geofence ─────────────────────────────────────────────────────────────────
// The haversine + presence-check live in @/lib/geo/geofence so the capture
// screen and the risk engine share one implementation. See geofenceState().

// ── Count-up hook ─────────────────────────────────────────────────────────────

function useCountUp(target: number, active: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!active || target === 0) {
      setCount(0);
      return;
    }
    setCount(0);
    const start = Date.now();
    const duration = 1200;
    let raf: number;
    const tick = () => {
      const p = Math.min((Date.now() - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = Math.round(target * eased * 100) / 100;
      setCount(val);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setCount(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active]);
  return count;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface CaptureStore
  extends Pick<Store, "id" | "name" | "display_name" | "city" | "lat" | "lng" | "geofence_radius_m"> {}

export interface CaptureFlowProps {
  profile: CurrentProfile;
  reasonCodes: ReasonCode[];
  stores: CaptureStore[];
  materialLiabilityEmployees: Employee[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CaptureFlow({
  profile,
  reasonCodes,
  stores,
  materialLiabilityEmployees: initialEmployees,
}: CaptureFlowProps) {
  // Only an admin self-selects a session store (the admin session picker). An
  // employee's branch is ASSIGNED by an admin on /admin/users — never chosen at
  // capture time. A non-admin without an assigned branch sees a clean empty
  // state ("обратитесь к администратору"), never a self-picker.
  const isAdmin = profile.role === "admin";
  const needsLocationPick = isAdmin;

  const [sessionLocationId, setSessionLocationId] = useState<string | null>(null);
  const [sessionLocationReady, setSessionLocationReady] = useState(!needsLocationPick);
  const [employees, setEmployees] = useState(initialEmployees);
  const [employeesLoading, setEmployeesLoading] = useState(false);

  // Restore session location from localStorage (location-less profiles only)
  useEffect(() => {
    if (!needsLocationPick) return;
    try {
      const stored = localStorage.getItem(CAPTURE_LOCATION_STORAGE_KEY);
      if (stored) setSessionLocationId(stored);
    } catch {
      /* ignore */
    } finally {
      setSessionLocationReady(true);
    }
  }, [needsLocationPick]);

  const activeLocationId = resolveCaptureLocationId(
    profile.location_id,
    sessionLocationId,
  );

  const activeLocation = useMemo(() => {
    if (profile.location) return profile.location;
    return stores.find((l) => l.id === activeLocationId) ?? null;
  }, [profile.location, stores, activeLocationId]);

  // Load material-liability employees when session location changes
  useEffect(() => {
    if (!needsLocationPick || !activeLocationId) {
      setEmployees(initialEmployees);
      return;
    }
    let cancelled = false;
    setEmployeesLoading(true);
    getMaterialLiabilityEmployees(activeLocationId)
      .then((rows) => {
        if (!cancelled) setEmployees(rows);
      })
      .finally(() => {
        if (!cancelled) setEmployeesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsLocationPick, activeLocationId, initialEmployees]);

  const handleSessionLocationChange = useCallback((locationId: string) => {
    setSessionLocationId(locationId);
    try {
      localStorage.setItem(CAPTURE_LOCATION_STORAGE_KEY, locationId);
    } catch {
      /* ignore */
    }
  }, []);

  const [step, setStep] = useState<"camera" | "form" | "success">("camera");
  const [captureResult, setCaptureResult] = useState<CaptureResult | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof FormState, string>>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  // ── Offline-first queue (Prompt 7) ─────────────────────────────────────────
  const queue = useWriteoffQueue(profile.id);

  // ── Vision pre-fill (Prompt 6) ─────────────────────────────────────────────
  // aiSuggestion holds the raw model output; aiApplied* track the values we
  // actually wrote into the form so the "AI предложил" chip hides once the
  // user overrides them. aiHint is set for low-confidence results — we show a
  // nudge but never auto-select.
  const [aiSuggestion, setAiSuggestion] = useState<VisionPrefill | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAppliedReasonId, setAiAppliedReasonId] = useState<string | null>(null);
  const [aiAppliedQty, setAiAppliedQty] = useState<string | null>(null);
  const [aiHint, setAiHint] = useState(false);

  const aiReasonOverridden =
    aiAppliedReasonId !== null && form.reasonCodeId !== aiAppliedReasonId;
  const aiQtyOverridden =
    aiAppliedQty !== null && form.qty !== aiAppliedQty;

  // ── Geofence presence-check (Prompt A) ─────────────────────────────────────
  // outside    → amber GpsAlert (matches the risk engine's geofence_fail)
  // unverified → soft GeofenceUnverifiedAlert (store not yet geocoded — never a
  //              hard fail; capture still works pre-geocode)
  // ok         → inside the radius / no GPS to check / no store picked
  const geofence = useMemo<"outside" | "unverified" | "ok">(() => {
    const loc = activeLocation;
    if (!loc) return "ok";
    const store = {
      lat: loc.lat,
      lng: loc.lng,
      geofence_radius_m: loc.geofence_radius_m,
    };
    if (!storeIsGeocoded(store)) return "unverified";
    if (captureResult?.gpsLat == null || captureResult?.gpsLng == null) return "ok";
    const state = geofenceState(
      { lat: captureResult.gpsLat, lng: captureResult.gpsLng },
      store,
    );
    return state === "outside" ? "outside" : "ok";
  }, [captureResult, activeLocation]);

  // ── Stores grouped by city for the admin/session store picker ───────────────
  const storeGroups = useMemo(() => {
    const groups = new Map<string, CaptureStore[]>();
    for (const s of stores) {
      const key = s.city || "—";
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }
    return Array.from(groups.entries()).map(([city, items]) => ({ city, items }));
  }, [stores]);

  // ── Camera → form + vision pre-fill ─────────────────────────────────────────
  // The LLM call is best-effort: it never blocks the form or submit. We kick
  // it off on capture and apply the result whenever it lands, ignoring errors.
  const handleCapture = useCallback(
    (result: CaptureResult) => {
      setCaptureResult(result);
      setStep("form");

      // Reset any prior AI state from a previous shot.
      setAiSuggestion(null);
      setAiAppliedReasonId(null);
      setAiAppliedQty(null);
      setAiHint(false);
      setAiLoading(true);

      void (async () => {
        const suggestion = await fetchVisionPrefill(result.blob);
        setAiLoading(false);
        if (!suggestion) return; // offline / errored / malformed → degrade
        setAiSuggestion(suggestion);

        const matched = matchReasonByCategory(
          reasonCodes,
          suggestion.reason_code_key,
        );
        if (!matched) return; // no reason code for that category — skip pre-fill

        if (suggestion.confidence >= AI_CONFIDENCE_THRESHOLD) {
          // Auto-select reason; pre-fill qty when the model gave a usable number.
          setAiAppliedReasonId(matched.id);
          setForm((f) => ({ ...f, reasonCodeId: matched.id }));
          if (
            suggestion.qty_guess !== null &&
            suggestion.qty_guess > 0 &&
            Number.isFinite(suggestion.qty_guess)
          ) {
            const qtyStr = String(suggestion.qty_guess);
            setAiAppliedQty(qtyStr);
            setForm((f) => ({ ...f, qty: qtyStr }));
          }
        } else {
          // Low confidence: hint only, never auto-select.
          setAiAppliedReasonId(matched.id);
          setAiHint(true);
        }
      })();
    },
    [reasonCodes],
  );

  // ── Form field helpers ─────────────────────────────────────────────────────
  const setField = <K extends keyof FormState>(key: K, val: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
    if (fieldErrors[key]) setFieldErrors((e) => ({ ...e, [key]: undefined }));
  };

  // ── Validate ───────────────────────────────────────────────────────────────
  const validate = (): boolean => {
    const errs: typeof fieldErrors = {};
    if (!form.reasonCodeId) errs.reasonCodeId = "Выберите причину";
    const n = parseFloat(form.qty);
    if (!form.qty || isNaN(n) || n <= 0) errs.qty = "Укажите количество";
    if (!form.unit) errs.unit = "Единица измерения обязательна";
    if (form.withholding && !form.chargedEmployeeId)
      errs.chargedEmployeeId = "Выберите сотрудника";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // ── Submit (optimistic → offline queue) ─────────────────────────────────────
  // We never block on the network: the submission is persisted to IndexedDB
  // and shown as "Filed" immediately, then flushed in the background.
  const handleSubmit = async () => {
    if (!validate() || !captureResult || submitting || !activeLocationId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const qty = parseFloat(form.qty);
      await queue.enqueue({
        reasonCodeId: form.reasonCodeId,
        qty,
        unit: form.unit,
        comment: form.comment || null,
        withholding: form.withholding,
        chargedEmployeeId:
          form.withholding && form.chargedEmployeeId
            ? form.chargedEmployeeId
            : null,
        locationId: activeLocationId,
        blob: captureResult.blob,
        capturedAt: captureResult.capturedAt,
        gpsLat: captureResult.gpsLat,
        gpsLng: captureResult.gpsLng,
      });
      // Optimistic success — the real writeoff id arrives after flush; the
      // success view only needs qty/unit/locationName, so a placeholder id is
      // fine until the queue syncs.
      setSubmitResult({
        id: "",
        qty,
        unit: form.unit,
        locationName:
          activeLocation?.display_name ?? activeLocation?.name ?? null,
      });
      setStep("success");
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Не удалось сохранить. Попробуйте ещё раз.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleReset = () => {
    if (captureResult?.previewUrl) URL.revokeObjectURL(captureResult.previewUrl);
    setCaptureResult(null);
    setForm(INITIAL_FORM);
    setFieldErrors({});
    setSubmitResult(null);
    setSubmitError(null);
    setAiSuggestion(null);
    setAiAppliedReasonId(null);
    setAiAppliedQty(null);
    setAiHint(false);
    setAiLoading(false);
    setStep("camera");
  };

  // ── Non-admin without an assigned branch — never a self-picker ──────────────
  // Employees/reviewers are onboarded by an admin; if no branch is attached to
  // the profile, capture is gated until IT assigns one. No manual location
  // selector is ever shown to a non-admin (kills the self-select fraud path).
  if (!isAdmin && !profile.location_id) {
    return <NoAssignedStoreState />;
  }

  // ── No stores to pick (admin session picker only) ───────────────────────────
  // Only the admin picker uses the stores list; a non-admin with a branch uses
  // profile.location directly, so an empty list never blocks them.
  if (needsLocationPick && stores.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
        <div
          className="flex items-center justify-center w-14 h-14 rounded-full"
          style={{ background: "var(--risk-watch-soft)" }}
        >
          <MapPin size={26} style={{ color: "var(--risk-watch-ink)" }} />
        </div>
        <p className="text-base font-semibold max-w-xs" style={{ color: "var(--fg)" }}>
          Нет доступных точек. Обратитесь к администратору.
        </p>
      </div>
    );
  }

  // ── Location picker (profile without assigned location) ────────────────────
  if (needsLocationPick && sessionLocationReady && !activeLocationId) {
    return (
      <div className="mx-auto max-w-lg px-4 py-6">
        <p className="eyebrow mb-2">Точка</p>
        <h1 className="text-xl font-extrabold mb-2" style={{ color: "var(--fg)" }}>
          Выберите точку
        </h1>
        <p className="text-sm mb-5" style={{ color: "var(--fg-muted)" }}>
          Профиль не привязан к точке — выберите, где вы сейчас работаете.
        </p>
        <div>
          <SectionLabel>Точка списания</SectionLabel>
          <Select onValueChange={(v) => { if (v) handleSessionLocationChange(v); }}>
            <SelectTrigger>
              <SelectValue placeholder="— выберите точку —" />
            </SelectTrigger>
            <SelectContent>
              {storeGroups.map(({ city, items }) => (
                <SelectGroup key={city}>
                  <SelectLabel>{city}</SelectLabel>
                  {items.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.display_name ?? s.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    );
  }

  if (needsLocationPick && !sessionLocationReady) return null;

  // ── Step: success ──────────────────────────────────────────────────────────
  if (step === "success" && submitResult) {
    return (
      <SuccessView
        result={submitResult}
        locationName={submitResult.locationName}
        onReset={handleReset}
        online={queue.online}
        syncing={queue.syncing}
        syncStatus={queue.lastEnqueuedStatus}
        syncError={queue.lastEnqueuedError}
        pendingCount={queue.pendingCount}
        onRetry={queue.flushNow}
      />
    );
  }

  // ── Step: camera ──────────────────────────────────────────────────────────
  if (step === "camera") {
    return (
      <div className="mx-auto max-w-lg px-4 py-6">
        {needsLocationPick && activeLocationId && (
          <div className="mb-4">
            <SectionLabel>Точка</SectionLabel>
            <Select
              value={activeLocationId}
              onValueChange={handleSessionLocationChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {storeGroups.map(({ city, items }) => (
                  <SelectGroup key={city}>
                    <SelectLabel>{city}</SelectLabel>
                    {items.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.display_name ?? s.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <p className="eyebrow mb-2">Шаг 1 — Фото</p>
        <h1 className="text-xl font-extrabold mb-6" style={{ color: "var(--fg)" }}>
          Сфотографируйте товар
        </h1>
        <CameraCapture onCapture={handleCapture} />
      </div>
    );
  }

  // ── Step: form ─────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-lg px-4 py-6 pb-24">
      {/* Back to camera */}
      <div className="flex items-center justify-between mb-4">
        <button
          className="flex items-center gap-1.5 text-sm font-semibold"
          style={{ color: "var(--fg-muted)" }}
          onClick={() => {
            // Release the current preview blob before re-entering the camera.
            if (captureResult?.previewUrl)
              URL.revokeObjectURL(captureResult.previewUrl);
            setCaptureResult(null);
            setStep("camera");
          }}
        >
          <ChevronLeft size={16} />
          Переснять фото
        </button>
        <SyncBadge
          online={queue.online}
          pendingCount={queue.pendingCount}
          syncing={queue.syncing}
        />
      </div>

      {/* ── Header: photo thumb + location ── */}
      <div
        className="fade-up flex items-center gap-3 mb-5"
        style={{ animationDelay: `${S.header}ms` }}
      >
        {captureResult?.previewUrl && (
          <img
            src={captureResult.previewUrl}
            alt="Снимок"
            className="w-14 h-14 rounded-xl object-cover flex-shrink-0"
            style={{ boxShadow: "var(--shadow-card)" }}
          />
        )}
        <div className="min-w-0 flex-1">
          <SectionLabel className="mb-0.5">Точка</SectionLabel>
          {needsLocationPick ? (
            <Select
              value={activeLocationId ?? ""}
              onValueChange={handleSessionLocationChange}
            >
              <SelectTrigger style={{ minHeight: 36, fontSize: "0.875rem" }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {storeGroups.map(({ city, items }) => (
                  <SelectGroup key={city}>
                    <SelectLabel>{city}</SelectLabel>
                    {items.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.display_name ?? s.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <MapPin
                size={14}
                strokeWidth={1.9}
                style={{ color: "var(--brand-strong)", flexShrink: 0 }}
              />
              <p
                className="text-sm font-bold truncate"
                style={{ color: "var(--fg)" }}
              >
                {activeLocation
                  ? `${activeLocation.city ? `${activeLocation.city} — ` : ""}${activeLocation.display_name ?? activeLocation.name}`
                  : "—"}
              </p>
            </div>
          )}
          {captureResult?.gpsLat && (
            <span className="text-xs" style={{ color: "var(--fg-faint)" }}>
              GPS: {captureResult.gpsLat.toFixed(4)},{" "}
              {captureResult.gpsLng?.toFixed(4)}
            </span>
          )}
        </div>
      </div>

      {/* ── Geofence alert (amber = outside radius; soft = store not geocoded) ── */}
      {geofence === "outside" && (
        <GpsAlert
          className="fade-up mb-5"
          style={{ animationDelay: `${S.gpsAlert}ms` } as React.CSSProperties}
        />
      )}
      {geofence === "unverified" && (
        <GeofenceUnverifiedAlert
          className="fade-up mb-5"
          style={{ animationDelay: `${S.gpsAlert}ms` } as React.CSSProperties}
        />
      )}

      {/* ── Reason grid ── */}
      <section
        className="fade-up mb-6"
        style={{ animationDelay: `${S.reasonSection}ms` }}
      >
        <div className="flex items-center gap-2 mb-2.5">
          <SectionLabel className="mb-0">Причина списания</SectionLabel>
          {aiLoading && (
            <span
              className="inline-flex items-center gap-1"
              style={{
                fontSize: "0.6875rem",
                fontWeight: 600,
                color: "var(--brand-strong)",
                background: "var(--brand-soft)",
                padding: "0.1875rem 0.5rem",
                borderRadius: "var(--radius-chip)",
              }}
            >
              <Loader2 size={11} className="animate-spin" />
              AI анализирует…
            </span>
          )}
          {!aiLoading &&
            aiSuggestion &&
            aiSuggestion.confidence >= AI_CONFIDENCE_THRESHOLD &&
            aiAppliedReasonId !== null &&
            !aiReasonOverridden && (
              <span
                className="inline-flex items-center gap-1"
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  color: "var(--brand-strong)",
                  background: "var(--brand-soft)",
                  padding: "0.1875rem 0.5rem",
                  borderRadius: "var(--radius-chip)",
                }}
              >
                <Sparkles size={11} />
                AI предложил
              </span>
            )}
        </div>
        <ReasonGrid
          reasonCodes={reasonCodes}
          selected={form.reasonCodeId}
          onSelect={(id) => setField("reasonCodeId", id)}
        />
        {aiHint &&
          aiAppliedReasonId !== null &&
          form.reasonCodeId === "" && (
            <p
              className="text-xs mt-2"
              style={{ color: "var(--fg-muted)" }}
            >
              AI подсказка: возможно,{" "}
              <span style={{ fontWeight: 600, color: "var(--fg)" }}>
                {CATEGORY_LABEL_RU[aiSuggestion?.reason_code_key ?? "yield"]}
              </span>{" "}
              — можете выбрать вручную.
            </p>
          )}
        {fieldErrors.reasonCodeId && (
          <p className="text-xs mt-2" style={{ color: "var(--risk-fraud)" }}>
            {fieldErrors.reasonCodeId}
          </p>
        )}
      </section>

      {/* ── Quantity ── */}
      <section
        className="fade-up mb-6"
        style={{ animationDelay: `${S.qtySection}ms` }}
      >
        <div className="flex items-center gap-2 mb-2.5">
          <SectionLabel className="mb-0">Количество</SectionLabel>
          {aiAppliedQty !== null &&
            !aiQtyOverridden &&
            aiSuggestion &&
            aiSuggestion.confidence >= AI_CONFIDENCE_THRESHOLD && (
              <span
                className="inline-flex items-center gap-1"
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  color: "var(--brand-strong)",
                  background: "var(--brand-soft)",
                  padding: "0.1875rem 0.5rem",
                  borderRadius: "var(--radius-chip)",
                }}
              >
                <Sparkles size={11} />
                AI предложил
              </span>
            )}
        </div>
        <div className="flex gap-3 items-start">
          <div className="flex-1">
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              placeholder="0"
              value={form.qty}
              onChange={(e) => setField("qty", e.target.value)}
              style={{ fontSize: "1.25rem", fontWeight: 700 }}
            />
            {fieldErrors.qty && (
              <p className="text-xs mt-1.5" style={{ color: "var(--risk-fraud)" }}>
                {fieldErrors.qty}
              </p>
            )}
          </div>

          {/* Unit pills */}
          <div className="flex flex-wrap gap-1.5 pt-1" style={{ maxWidth: 180 }}>
            {UNITS.map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setField("unit", u)}
                style={{
                  padding: "0.375rem 0.75rem",
                  borderRadius: "var(--radius-chip)",
                  fontWeight: 600,
                  fontSize: "0.8125rem",
                  border: form.unit === u ? "none" : "1.5px solid var(--border)",
                  background: form.unit === u ? "var(--brand)" : "var(--surface)",
                  color: form.unit === u ? "#fff" : "var(--fg-muted)",
                  cursor: "pointer",
                  transition: "background 120ms, color 120ms",
                }}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Withholding toggle ── */}
      <section
        className="fade-up mb-6"
        style={{ animationDelay: `${S.withholdingSection}ms` }}
      >
        <SectionLabel>Вид списания</SectionLabel>
        <div
          className="flex rounded-2xl p-1 gap-1"
          style={{
            background: "var(--surface-2)",
            border: "1.5px solid var(--border)",
          }}
        >
          {[
            { val: false, label: "Без удержания" },
            { val: true, label: "С удержанием" },
          ].map(({ val, label }) => (
            <button
              key={String(val)}
              type="button"
              onClick={() => {
                setField("withholding", val);
                if (!val) setField("chargedEmployeeId", "");
              }}
              style={{
                flex: 1,
                padding: "0.625rem 0.75rem",
                borderRadius: "14px",
                fontWeight: 700,
                fontSize: "0.875rem",
                background:
                  form.withholding === val
                    ? val
                      ? "var(--risk-fraud-soft)"
                      : "var(--brand)"
                    : "transparent",
                color:
                  form.withholding === val
                    ? val
                      ? "var(--risk-fraud-ink)"
                      : "#fff"
                    : "var(--fg-muted)",
                border: "none",
                cursor: "pointer",
                transition: "background 140ms, color 140ms",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {form.withholding && (
          <p className="text-xs mt-2 px-1" style={{ color: "var(--risk-fraud-ink)" }}>
            Удержание формирует дело — сотрудник будет уведомлён.
          </p>
        )}
      </section>

      {/* ── Employee picker (when withholding) ── */}
      {form.withholding && (
        <section
          className="fade-up mb-6"
          style={{ animationDelay: `${S.employeeSection}ms` }}
        >
          <SectionLabel>Ответственный сотрудник</SectionLabel>
          {employeesLoading ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              Загрузка…
            </p>
          ) : employees.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              Нет сотрудников с материальной ответственностью на этой точке.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {employees.map((emp) => {
                const isSelected = form.chargedEmployeeId === emp.id;
                return (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => setField("chargedEmployeeId", emp.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.875rem 1rem",
                      borderRadius: "var(--radius-ctl)",
                      background: isSelected
                        ? "var(--risk-fraud-soft)"
                        : "var(--surface)",
                      border: isSelected
                        ? "2px solid var(--risk-fraud)"
                        : "2px solid var(--border)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 120ms, border-color 120ms",
                    }}
                  >
                    <span
                      className="flex items-center justify-center w-9 h-9 rounded-full text-sm font-bold flex-shrink-0"
                      style={{
                        background: isSelected
                          ? "var(--risk-fraud)"
                          : "var(--surface-2)",
                        color: isSelected ? "#fff" : "var(--fg-muted)",
                      }}
                    >
                      {emp.full_name
                        .trim()
                        .split(/\s+/)
                        .map((w) => w[0])
                        .slice(0, 2)
                        .join("")
                        .toUpperCase()}
                    </span>
                    <div>
                      <p
                        className="text-sm font-bold leading-tight"
                        style={{
                          color: isSelected ? "var(--risk-fraud-ink)" : "var(--fg)",
                        }}
                      >
                        {emp.full_name}
                      </p>
                      {emp.position && (
                        <p className="text-xs" style={{ color: "var(--fg-faint)" }}>
                          {emp.position}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {fieldErrors.chargedEmployeeId && (
            <p className="text-xs mt-2" style={{ color: "var(--risk-fraud)" }}>
              {fieldErrors.chargedEmployeeId}
            </p>
          )}
        </section>
      )}

      {/* ── Comment ── */}
      <section
        className="fade-up mb-8"
        style={{ animationDelay: `${S.commentSection}ms` }}
      >
        <SectionLabel>
          Комментарий{" "}
          <span style={{ color: "var(--fg-faint)", fontWeight: 400 }}>
            (необязательно)
          </span>
        </SectionLabel>
        <textarea
          className="input"
          rows={3}
          placeholder="Подробности, если нужно…"
          value={form.comment}
          onChange={(e) => setField("comment", e.target.value)}
          style={{ resize: "vertical", minHeight: 80 }}
        />
      </section>

      {/* ── Submit error ── */}
      {submitError && (
        <div
          className="flex items-center gap-2 rounded-xl px-4 py-3 mb-4 text-sm font-semibold"
          style={{
            background: "var(--risk-fraud-soft)",
            color: "var(--risk-fraud-ink)",
          }}
        >
          <AlertTriangle size={16} className="flex-shrink-0" />
          {submitError}
        </div>
      )}

      {/* ── Submit ── */}
      <button
        className="btn-ledge w-full"
        style={{ minHeight: 56, fontSize: "1rem" }}
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? (
          <>
            <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
            Сохраняем…
          </>
        ) : (
          "Зафиксировать списание"
        )}
      </button>
    </div>
  );
}

// ── Sync UI helpers (Prompt 7) ────────────────────────────────────────────────

interface SyncBadgeProps {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
}

/** Compact online/offline + pending chip shown in the form header. */
function SyncBadge({ online, pendingCount, syncing }: SyncBadgeProps) {
  if (!online) {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        style={{
          fontSize: "0.75rem",
          fontWeight: 600,
          color: "var(--risk-watch-ink)",
          background: "var(--risk-watch-soft)",
          padding: "0.25rem 0.625rem",
          borderRadius: "var(--radius-chip)",
        }}
      >
        <CloudOff size={13} />
        Офлайн
        {pendingCount > 0 && <span>· в очереди {pendingCount}</span>}
      </span>
    );
  }
  if (syncing || pendingCount > 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        style={{
          fontSize: "0.75rem",
          fontWeight: 600,
          color: "var(--brand-strong)",
          background: "var(--brand-soft)",
          padding: "0.25rem 0.625rem",
          borderRadius: "var(--radius-chip)",
        }}
      >
        {syncing ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <RefreshCw size={13} />
        )}
        {syncing ? "Синхронизация" : `В очереди ${pendingCount}`}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        fontSize: "0.75rem",
        fontWeight: 600,
        color: "var(--fg-muted)",
        padding: "0.25rem 0.625rem",
      }}
    >
      <CloudUpload size={13} />
      Синхронизировано
    </span>
  );
}

interface SyncStatusBlockProps {
  online: boolean;
  syncing: boolean;
  syncStatus: QueueStatus | null;
  syncError: string | null;
  pendingCount: number;
  onRetry: () => void;
}

/** Inline sync state shown beneath the "Filed" confirmation. */
function SyncStatusBlock({
  online,
  syncing,
  syncStatus,
  syncError,
  pendingCount,
  onRetry,
}: SyncStatusBlockProps) {
  let icon = <CloudUpload size={15} />;
  let label = "Отправлено в систему";
  let bg = "var(--risk-clean-soft)";
  let ink = "var(--risk-clean-ink)";

  if (syncStatus === "synced") {
    icon = <CloudUpload size={15} />;
    label = "Отправлено в систему";
  } else if (syncStatus === "failed") {
    icon = <AlertTriangle size={15} />;
    label = syncError ?? "Не отправлено — повторим при подключении";
    bg = "var(--risk-watch-soft)";
    ink = "var(--risk-watch-ink)";
  } else if (syncing || (online && syncStatus === "pending")) {
    icon = <Loader2 size={15} className="animate-spin" />;
    label = "Отправляется…";
    bg = "var(--brand-soft)";
    ink = "var(--brand-strong)";
  } else {
    // pending + offline
    icon = <CloudOff size={15} />;
    label = "Сохранено офлайн — отправится при подключении";
    bg = "var(--risk-watch-soft)";
    ink = "var(--risk-watch-ink)";
  }

  return (
    <div
      className="anim-fade-up-2 w-full max-w-sm mx-auto"
      style={{ marginTop: "-0.5rem" }}
    >
      <div
        className="flex items-center gap-2 rounded-2xl px-4 py-3 text-left"
        style={{ background: bg, color: ink }}
      >
        <span className="flex-shrink-0">{icon}</span>
        <p
          className="text-xs font-semibold flex-1"
          style={{ lineHeight: 1.4, margin: 0 }}
        >
          {label}
        </p>
        {syncStatus === "failed" && online && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 text-xs font-bold"
            style={{ color: ink }}
          >
            <RefreshCw size={12} />
            Повторить
          </button>
        )}
      </div>
      {pendingCount > 1 && (
        <p
          className="text-xs text-center mt-2"
          style={{ color: "var(--fg-muted)" }}
        >
          Ещё в очереди: {pendingCount - (syncStatus === "synced" ? 1 : 0)}
        </p>
      )}
    </div>
  );
}

// ── No-assigned-branch empty state (employees/reviewers) ──────────────────────

/**
 * Shown when a non-admin opens /capture with no branch attached to their
 * profile. Capture is gated until an admin assigns a branch from /admin/users —
 * employees never self-select a location.
 */
function NoAssignedStoreState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 px-6 text-center min-h-[60dvh]">
      <div
        className="flex items-center justify-center w-16 h-16 rounded-full"
        style={{ background: "var(--brand-soft)" }}
      >
        <MapPin size={30} strokeWidth={1.75} style={{ color: "var(--brand-strong)" }} />
      </div>
      <div className="max-w-xs space-y-1.5">
        <h1
          className="text-lg font-extrabold"
          style={{ color: "var(--fg)" }}
        >
          Вы не привязаны к филиалу
        </h1>
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
          Обратитесь к администратору — точка назначается при зачислении в систему.
        </p>
      </div>
    </div>
  );
}

// ── Success view ──────────────────────────────────────────────────────────────

function SuccessView({
  result,
  locationName,
  onReset,
  online,
  syncing,
  syncStatus,
  syncError,
  pendingCount,
  onRetry,
}: {
  result: SubmitResult;
  locationName: string | null;
  onReset: () => void;
  online: boolean;
  syncing: boolean;
  syncStatus: QueueStatus | null;
  syncError: string | null;
  pendingCount: number;
  onRetry: () => void;
}) {
  const count = useCountUp(result.qty, true);
  const displayCount = Number.isInteger(result.qty)
    ? Math.round(count)
    : Math.round(count * 10) / 10;

  return (
    <div className="flex flex-col items-center justify-center min-h-[65dvh] px-6 text-center gap-5">
      <style>{`
        @keyframes bahandi-pop {
          0%   { transform: scale(0) rotate(-15deg); opacity: 0; }
          60%  { transform: scale(1.18) rotate(4deg); }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        .anim-pop { animation: bahandi-pop 480ms cubic-bezier(0.175,0.885,0.32,1.275) forwards; }
        @keyframes bahandi-fade-up {
          0%   { transform: translateY(16px); opacity: 0; }
          100% { transform: translateY(0);    opacity: 1; }
        }
        .anim-fade-up   { animation: bahandi-fade-up 350ms ease-out 280ms both; }
        .anim-fade-up-2 { animation: bahandi-fade-up 350ms ease-out 400ms both; }
        .anim-fade-up-3 { animation: bahandi-fade-up 350ms ease-out 550ms both; }
      `}</style>

      <div className="anim-pop">
        <div
          className="flex items-center justify-center w-24 h-24 rounded-full"
          style={{
            background: "var(--brand-soft)",
            boxShadow: "0 0 0 8px var(--brand-ring), var(--shadow-card-hover)",
          }}
        >
          <CheckCircle2 size={52} style={{ color: "var(--brand)" }} />
        </div>
      </div>

      <div className="anim-fade-up">
        <h2 className="text-2xl font-extrabold" style={{ color: "var(--fg)" }}>
          Зафиксировано!
        </h2>
        {locationName && (
          <p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
            {locationName}
          </p>
        )}
      </div>

      <div
        className="anim-fade-up-2 rounded-2xl px-8 py-5"
        style={{ background: "var(--brand-soft)" }}
      >
        <span
          className="text-4xl font-extrabold tabular-nums"
          style={{ color: "var(--brand-strong)" }}
        >
          {displayCount}
        </span>
        <span className="text-xl font-bold ml-2" style={{ color: "var(--brand)" }}>
          {result.unit}
        </span>
        <p className="text-xs mt-1 font-semibold" style={{ color: "var(--brand)" }}>
          списано и задокументировано
        </p>
      </div>

      <SyncStatusBlock
        online={online}
        syncing={syncing}
        syncStatus={syncStatus}
        syncError={syncError}
        pendingCount={pendingCount}
        onRetry={onRetry}
      />

      <div className="anim-fade-up-3 w-full max-w-xs">
        <button
          className="btn-ledge w-full"
          style={{ minHeight: 52 }}
          onClick={onReset}
        >
          Ещё одно списание
        </button>
      </div>
    </div>
  );
}
