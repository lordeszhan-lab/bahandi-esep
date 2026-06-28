"use client";

/**
 * Client-side vision pre-fill helpers — Prompt 6.
 *
 * `downscaleForVision` shrinks the captured JPEG before upload so the
 * /api/vision/prefill round-trip stays small and fast (gpt-4o-mini only needs
 * `detail: "low"`). `fetchVisionPrefill` posts the downscaled image and parses
 * the structured response — failures resolve to `null` so callers degrade
 * gracefully and never block submit on the LLM.
 */

import type { VisionPrefill } from "@/lib/llm/vision-prefill";

const VISION_MAX_DIM = 768;
const VISION_JPEG_QUALITY = 0.7;

/** Resize a camera blob to a square-bounded JPEG for the vision call. */
export async function downscaleForVision(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap === "undefined") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, VISION_MAX_DIM / Math.max(bitmap.width, bitmap.height));
    // Skip the canvas round-trip when the image is already small enough.
    if (scale >= 1) {
      bitmap.close?.();
      return blob;
    }
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return blob;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const out = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", VISION_JPEG_QUALITY),
    );
    return out ?? blob;
  } catch {
    return blob;
  }
}

export interface VisionPrefillResponse {
  ok: boolean;
  data?: VisionPrefill;
  error?: string;
}

/**
 * Call the vision pre-fill route. Resolves to `null` on any failure
 * (network down, non-ok response, malformed body) so the capture flow can
 * ignore the result and let the user fill the form manually.
 */
export async function fetchVisionPrefill(blob: Blob): Promise<VisionPrefill | null> {
  try {
    const small = await downscaleForVision(blob);
    const form = new FormData();
    form.append("image", small, "capture.jpg");

    const res = await fetch("/api/vision/prefill", { method: "POST", body: form });
    if (!res.ok) return null;
    const json = (await res.json()) as VisionPrefillResponse;
    if (!json.ok || !json.data) return null;
    return json.data;
  } catch {
    return null;
  }
}
