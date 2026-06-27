"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  MapPin,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
} from "lucide-react";
import { CameraCapture, type CaptureResult } from "./camera";
import { ReasonGrid } from "./reason-grid";
import { submitWriteoff, type SubmitResult } from "@/lib/actions/submit-writeoff";
import { getMaterialLiabilityEmployees } from "@/lib/actions/get-location-employees";
import {
  CAPTURE_LOCATION_STORAGE_KEY,
  resolveCaptureLocationId,
  type CurrentProfile,
} from "@/lib/auth-shared";
import { useDevPreview } from "@/lib/dev-preview";
import type { ReasonCode, Employee, Location } from "@/lib/db/types";

// ── Constants ─────────────────────────────────────────────────────────────────

const UNITS = ["кг", "г", "л", "мл", "шт", "порц"];

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

// ── Haversine distance ────────────────────────────────────────────────────────

function distanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

export interface CaptureLocation
  extends Pick<Location, "id" | "name" | "lat" | "lng" | "geofence_radius_m"> {}

export interface CaptureFlowProps {
  profile: CurrentProfile;
  reasonCodes: ReasonCode[];
  locations: CaptureLocation[];
  materialLiabilityEmployees: Employee[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CaptureFlow({
  profile,
  reasonCodes,
  locations,
  materialLiabilityEmployees: initialEmployees,
}: CaptureFlowProps) {
  const { preview } = useDevPreview();
  const needsLocationPick = !profile.location_id;

  const [sessionLocationId, setSessionLocationId] = useState<string | null>(
    null,
  );
  const [sessionLocationReady, setSessionLocationReady] = useState(
    !needsLocationPick,
  );
  const [employees, setEmployees] = useState(initialEmployees);
  const [employeesLoading, setEmployeesLoading] = useState(false);

  // Restore session location from localStorage (location-less profiles only)
  useEffect(() => {
    if (!needsLocationPick) return;
    try {
      const stored = localStorage.getItem(CAPTURE_LOCATION_STORAGE_KEY);
      const fallback = preview.locationId;
      const initial = stored || fallback || null;
      if (initial) setSessionLocationId(initial);
    } catch {
      /* ignore */
    } finally {
      setSessionLocationReady(true);
    }
  }, [needsLocationPick, preview.locationId]);

  const activeLocationId = resolveCaptureLocationId(
    profile.location_id,
    sessionLocationId,
    preview,
  );

  const activeLocation = useMemo(() => {
    if (profile.location) return profile.location;
    return locations.find((l) => l.id === activeLocationId) ?? null;
  }, [profile.location, locations, activeLocationId]);

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
  const [captureResult, setCaptureResult] = useState<CaptureResult | null>(
    null,
  );
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof FormState, string>>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  // ── Geofence warning ───────────────────────────────────────────────────────
  const geofenceWarning = useMemo(() => {
    const loc = activeLocation;
    if (!captureResult?.gpsLat || !captureResult?.gpsLng) return false;
    if (!loc?.lat || !loc?.lng) return false;
    const dist = distanceM(
      captureResult.gpsLat,
      captureResult.gpsLng,
      loc.lat,
      loc.lng,
    );
    return dist > (loc.geofence_radius_m ?? 150);
  }, [captureResult, activeLocation]);

  // ── Camera → form ──────────────────────────────────────────────────────────
  const handleCapture = useCallback((result: CaptureResult) => {
    setCaptureResult(result);
    setStep("form");
  }, []);

  // ── Form field helpers ─────────────────────────────────────────────────────
  const setField = <K extends keyof FormState>(key: K, val: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
    if (fieldErrors[key])
      setFieldErrors((e) => ({ ...e, [key]: undefined }));
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

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!validate() || !captureResult || submitting || !activeLocationId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitWriteoff({
        reasonCodeId: form.reasonCodeId,
        qty: parseFloat(form.qty),
        unit: form.unit,
        comment: form.comment || null,
        withholding: form.withholding,
        chargedEmployeeId:
          form.withholding && form.chargedEmployeeId
            ? form.chargedEmployeeId
            : null,
        storagePath: captureResult.storagePath,
        gpsLat: captureResult.gpsLat,
        gpsLng: captureResult.gpsLng,
        capturedAt: captureResult.capturedAt,
        locationId: activeLocationId,
      });
      setSubmitResult(result);
      setStep("success");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Произошла ошибка. Попробуйте ещё раз.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setCaptureResult(null);
    setForm(INITIAL_FORM);
    setFieldErrors({});
    setSubmitResult(null);
    setSubmitError(null);
    setStep("camera");
  };

  // ── No locations in DB ─────────────────────────────────────────────────────
  if (locations.length === 0) {
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
        <h1
          className="text-xl font-extrabold mb-2"
          style={{ color: "var(--fg)" }}
        >
          Выберите точку
        </h1>
        <p className="text-sm mb-5" style={{ color: "var(--fg-muted)" }}>
          Профиль не привязан к точке — выберите, где вы сейчас работаете.
        </p>
        <label className="block">
          <span className="label">Точка списания</span>
          <select
            className="input"
            value=""
            onChange={(e) => {
              if (e.target.value) handleSessionLocationChange(e.target.value);
            }}
          >
            <option value="" disabled>
              — выберите точку —
            </option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (needsLocationPick && !sessionLocationReady) {
    return null;
  }

  // ── Step: success ──────────────────────────────────────────────────────────
  if (step === "success" && submitResult) {
    return (
      <SuccessView result={submitResult} locationName={submitResult.locationName} onReset={handleReset} />
    );
  }

  // ── Step: camera ──────────────────────────────────────────────────────────
  if (step === "camera") {
    return (
      <div className="mx-auto max-w-lg px-4 py-6">
        {needsLocationPick && activeLocationId && (
          <div className="mb-4">
            <label className="block">
              <span className="label">Точка</span>
              <select
                className="input"
                style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}
                value={activeLocationId}
                onChange={(e) => handleSessionLocationChange(e.target.value)}
              >
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <p className="eyebrow mb-2">Шаг 1 — Фото</p>
        <h1
          className="text-xl font-extrabold mb-6"
          style={{ color: "var(--fg)" }}
        >
          Сфотографируйте товар
        </h1>
        <CameraCapture userId={profile.id} onCapture={handleCapture} />
      </div>
    );
  }

  // ── Step: form ─────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-lg px-4 py-6 pb-24">
      {/* Back to camera */}
      <button
        className="flex items-center gap-1.5 text-sm font-semibold mb-4"
        style={{ color: "var(--fg-muted)" }}
        onClick={() => setStep("camera")}
      >
        <ChevronLeft size={16} />
        Переснять фото
      </button>

      {/* Header row: thumb + location */}
      <div className="flex items-center gap-3 mb-5">
        {captureResult?.previewUrl && (
          <img
            src={captureResult.previewUrl}
            alt="Снимок"
            className="w-14 h-14 rounded-xl object-cover flex-shrink-0"
            style={{ boxShadow: "var(--shadow-card)" }}
          />
        )}
        <div className="min-w-0">
          <p className="eyebrow mb-0.5">Точка</p>
          {needsLocationPick ? (
            <select
              className="input text-sm font-bold"
              style={{ padding: "0.375rem 0.625rem", marginTop: "0.125rem" }}
              value={activeLocationId ?? ""}
              onChange={(e) => handleSessionLocationChange(e.target.value)}
            >
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm font-bold truncate" style={{ color: "var(--fg)" }}>
              {activeLocation?.name ?? "—"}
            </p>
          )}
          {captureResult?.gpsLat && (
            <span
              className="text-xs"
              style={{ color: "var(--fg-faint)" }}
            >
              GPS: {captureResult.gpsLat.toFixed(4)},{" "}
              {captureResult.gpsLng?.toFixed(4)}
            </span>
          )}
        </div>
      </div>

      {/* Geofence warning */}
      {geofenceWarning && (
        <div
          className="flex items-center gap-2 rounded-xl px-4 py-3 mb-5 text-sm font-semibold"
          style={{
            background: "var(--risk-watch-soft)",
            color: "var(--risk-watch-ink)",
          }}
        >
          <AlertTriangle size={16} className="flex-shrink-0" />
          Ваш GPS далеко от точки. Убедитесь, что вы на месте.
        </div>
      )}

      {/* ── Reason grid ── */}
      <section className="mb-6">
        <p className="eyebrow mb-3">Причина списания</p>
        <ReasonGrid
          reasonCodes={reasonCodes}
          selected={form.reasonCodeId}
          onSelect={(id) => setField("reasonCodeId", id)}
        />
        {fieldErrors.reasonCodeId && (
          <p className="text-xs mt-2" style={{ color: "var(--risk-fraud)" }}>
            {fieldErrors.reasonCodeId}
          </p>
        )}
      </section>

      {/* ── Quantity ── */}
      <section className="mb-6">
        <p className="eyebrow mb-3">Количество</p>
        <div className="flex gap-3 items-start">
          <div className="flex-1">
            <input
              className="input text-xl font-bold"
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

          {/* Unit selector */}
          <div
            className="flex flex-wrap gap-1.5 pt-1"
            style={{ maxWidth: 180 }}
          >
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
                  background:
                    form.unit === u ? "var(--brand)" : "var(--surface)",
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
      <section className="mb-6">
        <p className="eyebrow mb-3">Вид списания</p>
        <div
          className="flex rounded-2xl p-1 gap-1"
          style={{ background: "var(--surface-2)", border: "1.5px solid var(--border)" }}
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
          <p
            className="text-xs mt-2 px-1"
            style={{ color: "var(--risk-fraud-ink)" }}
          >
            Удержание формирует дело — сотрудник будет уведомлён.
          </p>
        )}
      </section>

      {/* ── Employee picker (when withholding) ── */}
      {form.withholding && (
        <section className="mb-6">
          <p className="eyebrow mb-3">Ответственный сотрудник</p>
          {employeesLoading ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              Загрузка…
            </p>
          ) : employees.length === 0 ? (
            <p
              className="text-sm"
              style={{ color: "var(--fg-muted)" }}
            >
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
                          color: isSelected
                            ? "var(--risk-fraud-ink)"
                            : "var(--fg)",
                        }}
                      >
                        {emp.full_name}
                      </p>
                      {emp.position && (
                        <p
                          className="text-xs"
                          style={{ color: "var(--fg-faint)" }}
                        >
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
            <p
              className="text-xs mt-2"
              style={{ color: "var(--risk-fraud)" }}
            >
              {fieldErrors.chargedEmployeeId}
            </p>
          )}
        </section>
      )}

      {/* ── Comment ── */}
      <section className="mb-8">
        <p className="eyebrow mb-3">Комментарий <span style={{ color: "var(--fg-faint)" }}>(необязательно)</span></p>
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

      {/* ── Submit button ── */}
      <button
        className="btn-ledge w-full text-base"
        style={{ minHeight: 56, fontSize: "1rem" }}
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? (
          <>
            <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
            Отправляем…
          </>
        ) : (
          "Зафиксировать списание"
        )}
      </button>
    </div>
  );
}

// ── Success view ──────────────────────────────────────────────────────────────

function SuccessView({
  result,
  locationName,
  onReset,
}: {
  result: SubmitResult;
  locationName: string | null;
  onReset: () => void;
}) {
  const count = useCountUp(result.qty, true);

  const displayCount = Number.isInteger(result.qty)
    ? Math.round(count)
    : Math.round(count * 10) / 10;

  return (
    <div className="flex flex-col items-center justify-center min-h-[65dvh] px-6 text-center gap-6">
      <style>{`
        @keyframes bahandi-pop {
          0% { transform: scale(0) rotate(-15deg); opacity: 0; }
          60% { transform: scale(1.18) rotate(4deg); }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        .anim-pop { animation: bahandi-pop 480ms cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }
        @keyframes bahandi-fade-up {
          0% { transform: translateY(16px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        .anim-fade-up { animation: bahandi-fade-up 350ms ease-out 280ms both; }
        .anim-fade-up-2 { animation: bahandi-fade-up 350ms ease-out 400ms both; }
        .anim-fade-up-3 { animation: bahandi-fade-up 350ms ease-out 550ms both; }
      `}</style>

      {/* Checkmark */}
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

      {/* Title */}
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

      {/* Count-up */}
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
        <span
          className="text-xl font-bold ml-2"
          style={{ color: "var(--brand)" }}
        >
          {result.unit}
        </span>
        <p
          className="text-xs mt-1 font-semibold"
          style={{ color: "var(--brand)" }}
        >
          списано и задокументировано
        </p>
      </div>

      {/* New write-off button */}
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
