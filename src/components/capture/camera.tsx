"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { RotateCcw, ArrowRight, WifiOff, Camera } from "lucide-react";
import { uploadPhoto } from "@/lib/upload";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CaptureResult {
  storagePath: string;
  capturedAt: string;
  gpsLat: number | null;
  gpsLng: number | null;
  previewUrl: string;
}

interface CameraCaptureProps {
  userId: string;
  /** Called only when user presses "Далее" after confirming the preview. */
  onCapture: (result: CaptureResult) => void;
}

type CamState =
  | "requesting"
  | "live"
  | "snapping"
  | "uploading"
  | "preview"
  | "error";

// ── Geo helper ────────────────────────────────────────────────────────────────

function readGps(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 6000, maximumAge: 30_000 },
    );
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CameraCapture({ userId, onCapture }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingRef = useRef<CaptureResult | null>(null);

  const [camState, setCamState] = useState<CamState>("requesting");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── Start stream ───────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCamState("requesting");
    setErrorMsg(null);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
      setCamState("live");
    } catch (err) {
      let msg = "Камера недоступна.";
      if (err instanceof DOMException) {
        if (err.name === "NotAllowedError")
          msg = "Доступ к камере запрещён. Разрешите доступ в настройках браузера.";
        else if (err.name === "NotFoundError") msg = "Камера не найдена.";
      }
      setErrorMsg(msg);
      setCamState("error");
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (pendingRef.current?.previewUrl)
        URL.revokeObjectURL(pendingRef.current.previewUrl);
    };
  }, [startCamera]);

  // ── Shutter press ──────────────────────────────────────────────────────────
  const handleShutter = useCallback(async () => {
    if (camState !== "live") return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    setCamState("snapping");

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const capturedAt = new Date().toISOString();

    const gpsPromise = readGps();

    const blob: Blob | null = await new Promise((res) =>
      canvas.toBlob(res, "image/jpeg", 0.9),
    );
    if (!blob) {
      setErrorMsg("Не удалось создать снимок.");
      setCamState("error");
      return;
    }

    const url = URL.createObjectURL(blob);
    if (pendingRef.current?.previewUrl)
      URL.revokeObjectURL(pendingRef.current.previewUrl);
    setPreviewSrc(url);

    // Stop stream to save battery during upload
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setCamState("uploading");

    try {
      const [gps, upload] = await Promise.all([
        gpsPromise,
        uploadPhoto(blob, userId),
      ]);
      pendingRef.current = {
        storagePath: upload.storagePath,
        capturedAt,
        gpsLat: gps?.lat ?? null,
        gpsLng: gps?.lng ?? null,
        previewUrl: url,
      };
      setCamState("preview");
    } catch (err) {
      URL.revokeObjectURL(url);
      setPreviewSrc(null);
      setErrorMsg(
        err instanceof Error ? err.message : "Ошибка загрузки фото.",
      );
      setCamState("error");
    }
  }, [camState, userId]);

  // ── Retake ─────────────────────────────────────────────────────────────────
  const handleRetake = useCallback(() => {
    if (pendingRef.current?.previewUrl)
      URL.revokeObjectURL(pendingRef.current.previewUrl);
    pendingRef.current = null;
    setPreviewSrc(null);
    startCamera();
  }, [startCamera]);

  // ── Confirm ────────────────────────────────────────────────────────────────
  const handleConfirm = useCallback(() => {
    if (pendingRef.current) onCapture(pendingRef.current);
  }, [onCapture]);

  // ── Render: error ──────────────────────────────────────────────────────────
  if (camState === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-5 py-16 px-6 text-center">
        <div
          className="flex items-center justify-center w-16 h-16 rounded-full"
          style={{ background: "var(--risk-fraud-soft)" }}
        >
          <WifiOff size={28} style={{ color: "var(--risk-fraud-ink)" }} />
        </div>
        <p className="text-base font-semibold max-w-xs" style={{ color: "var(--fg)" }}>
          {errorMsg}
        </p>
        <button className="btn-primary" onClick={startCamera}>
          Попробовать снова
        </button>
      </div>
    );
  }

  const isLive = camState === "live";
  const isPreview = camState === "preview";
  const isLoading =
    camState === "requesting" || camState === "snapping" || camState === "uploading";

  const loadingLabel =
    camState === "requesting"
      ? "Включаю камеру…"
      : camState === "snapping"
        ? "Снимок…"
        : "Загружаю фото…";

  return (
    <div className="flex flex-col gap-0">
      {/* ── Viewfinder ── */}
      <div
        className="relative overflow-hidden"
        style={{
          background: "#000",
          borderRadius: "var(--radius-card)",
          aspectRatio: "4/3",
          width: "100%",
        }}
      >
        {/* Live video */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay
          muted
          playsInline
          style={{ opacity: isLive || camState === "snapping" ? 1 : 0 }}
        />

        {/* Captured preview */}
        {previewSrc && (
          <img
            src={previewSrc}
            alt="Снимок"
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}

        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
            <div className="w-9 h-9 border-[3px] border-white border-t-transparent rounded-full animate-spin" />
            <span className="text-white text-sm font-semibold">{loadingLabel}</span>
          </div>
        )}

        {/* Corner framing guides (live only) */}
        {isLive && (
          <>
            {(
              [
                "top-3 left-3 border-t-2 border-l-2",
                "top-3 right-3 border-t-2 border-r-2",
                "bottom-3 left-3 border-b-2 border-l-2",
                "bottom-3 right-3 border-b-2 border-r-2",
              ] as const
            ).map((cls, i) => (
              <span
                key={i}
                className={`absolute w-7 h-7 border-white/50 ${cls}`}
                style={{ borderRadius: 4 }}
              />
            ))}
          </>
        )}
      </div>

      {/* Hidden snapshot canvas */}
      <canvas ref={canvasRef} className="hidden" aria-hidden />

      {/* ── Controls ── */}
      <div className="flex items-center justify-center gap-10 pt-6 pb-2">
        {isPreview ? (
          <>
            {/* Retake */}
            <button
              className="flex flex-col items-center gap-2 text-sm font-semibold"
              style={{ color: "var(--fg-muted)" }}
              onClick={handleRetake}
            >
              <span
                className="flex items-center justify-center w-14 h-14 rounded-full border-2"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--surface)",
                }}
              >
                <RotateCcw size={22} />
              </span>
              Переснять
            </button>

            {/* Confirm */}
            <button
              className="flex flex-col items-center gap-2 text-sm font-bold"
              style={{ color: "var(--brand-strong)" }}
              onClick={handleConfirm}
            >
              <span
                className="flex items-center justify-center w-16 h-16 rounded-full"
                style={{ background: "var(--brand)" }}
              >
                <ArrowRight size={26} color="#fff" />
              </span>
              Далее
            </button>
          </>
        ) : (
          /* Shutter button */
          <button
            aria-label="Сделать снимок"
            disabled={!isLive}
            onClick={handleShutter}
            style={{
              width: 80,
              height: 80,
              borderRadius: "50%",
              background: "white",
              border: "5px solid rgba(255,255,255,0.3)",
              boxShadow:
                "0 0 0 6px rgba(255,255,255,0.15), var(--shadow-card)",
              cursor: isLive ? "pointer" : "default",
              opacity: isLive ? 1 : 0.4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "transform 100ms ease-out, opacity 150ms",
            }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform =
                "scale(0.90)";
            }}
            onPointerUp={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform =
                "scale(1)";
            }}
            onPointerLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform =
                "scale(1)";
            }}
          >
            <Camera size={30} color="#111" />
          </button>
        )}
      </div>

      {isLive && (
        <p className="text-center text-xs pt-1" style={{ color: "var(--fg-faint)" }}>
          Только камера — выбор из галереи недоступен
        </p>
      )}
    </div>
  );
}
