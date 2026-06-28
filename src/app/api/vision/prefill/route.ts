/**
 * POST /api/vision/prefill — Prompt 6.
 *
 * Accepts a single image (multipart/form-data, field `image`) and returns a
 * structured vision pre-fill suggestion from gpt-4o-mini. The proxy already
 * rejects unauthenticated /api/** requests; we re-verify the session here and
 * treat every LLM failure as a non-fatal 200-with-error so the capture flow
 * can degrade gracefully without blocking submit.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  visionPrefillFromImage,
  bufferToDataUrl,
  type VisionPrefill,
} from "@/lib/llm/vision-prefill";

export const runtime = "nodejs";
// Vision call is a single short request; allow up to 30s for the model.
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB post-downscale cap
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export async function POST(request: Request): Promise<Response> {
  // ── Auth (defense-in-depth on top of the proxy guard) ───────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse multipart body ────────────────────────────────────────────────────
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected multipart/form-data with an image field" },
      { status: 400 },
    );
  }

  const file = form.get("image");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { ok: false, error: "Missing 'image' file" },
      { status: 400 },
    );
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { ok: false, error: "Image too large" },
      { status: 413 },
    );
  }

  // Default to jpeg — the client downscales and re-encodes as JPEG.
  const mimeType = file.type && ALLOWED_MIME.has(file.type) ? file.type : "image/jpeg";

  // ── Run the vision pass (single call) ───────────────────────────────────────
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dataUrl = bufferToDataUrl(bytes, mimeType);
    const result: VisionPrefill = await visionPrefillFromImage(dataUrl);

    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    // Non-fatal: the client treats this as "no suggestion" and lets the user
    // proceed manually. Never block submit on the LLM.
    const message = err instanceof Error ? err.message : "Vision pre-fill failed";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
