/**
 * Vision pre-fill — Prompt 6.
 *
 * Calls gpt-4o-mini (vision) with Structured Outputs to auto-suggest a
 * product, defect, reason-code category, quantity, and a confidence score
 * from a writeoff photo. Server-only — the OPENAI_API_KEY never reaches the
 * browser.
 *
 * Conventions:
 *   - .nullable() (not .optional()) for optional-ish fields in the LLM schema.
 *   - A single model call per photo (no parallel fan-out).
 *   - Callers must degrade gracefully: this function throws on failure and the
 *     route handler converts that into a non-fatal error response so the
 *     capture flow never blocks submit on the LLM.
 */

import { z } from "zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ReasonCategory } from "@/lib/db/types";

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Structured-output contract for gpt-4o-mini.
 * `reason_code_key` is a loss-category — mapped client-side to a concrete
 * reason_codes row (the seed ships one row per category, key === category).
 */
export const VisionPrefillSchema = z.object({
  product_guess: z.string(),
  defect_guess: z.string(),
  reason_code_key: z.enum([
    "yield",
    "quality",
    "accidental",
    "spoilage",
    "return",
    "breakage",
  ]),
  qty_guess: z.number().nullable(),
  confidence: z.number(),
});

export type VisionPrefill = z.infer<typeof VisionPrefillSchema>;

/** The set of categories we accept from the model — mirrors ReasonCategory. */
export const VISION_REASON_KEYS = new Set<ReasonCategory>([
  "yield",
  "quality",
  "accidental",
  "spoilage",
  "return",
  "breakage",
]);

// ── Client ────────────────────────────────────────────────────────────────────

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  _client = new OpenAI({ apiKey });
  return _client;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are a loss-intelligence assistant for a restaurant/kitchen writeoff app.",
  "Given a photo of a discarded or damaged product, identify:",
  "1. product_guess — what the product is (short, in Russian or Kazakh).",
  "2. defect_guess — the visible defect or reason it was written off (short).",
  "3. reason_code_key — the single best-fitting loss category.",
  "4. qty_guess — estimated quantity of product shown (number, or null if unknowable).",
  "5. confidence — your confidence in reason_code_key, 0..1.",
  "",
  "Loss categories:",
  "- yield       — технологический выход / prep trim (normal production loss)",
  "- quality     — брак качества / quality defect (bad batch, undercooked, wrong)",
  "- accidental  — случайное повреждение / accidental damage (dropped, spilled)",
  "- spoilage    — порча, срок годности / spoilage, expired",
  "- return      — возврат гостя / guest return",
  "- breakage    — бой / breakage (glass, dishes, packaging)",
  "",
  "Be conservative with confidence: use <0.5 when the photo is unclear or the",
  "category is genuinely ambiguous. Keep product_guess and defect_guess terse.",
].join("\n");

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a single vision pass against gpt-4o-mini.
 *
 * @param imageDataUrl  a `data:image/...;base64,...` URL for the photo
 * @returns             parsed structured result
 * @throws              on any API / parse failure (caller degrades gracefully)
 */
export async function visionPrefillFromImage(
  imageDataUrl: string,
): Promise<VisionPrefill> {
  const client = getClient();

  const completion = await client.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    // Single, cheap vision pass — low detail is enough for category guessing.
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Classify this writeoff photo. Return the structured fields.",
          },
          {
            type: "image_url",
            image_url: { url: imageDataUrl, detail: "low" },
          },
        ],
      },
    ],
    response_format: zodResponseFormat(VisionPrefillSchema, "vision_prefill"),
    temperature: 0,
    max_tokens: 300,
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("Vision model returned no parseable output");
  }
  return parsed;
}

/**
 * Convert a raw image Buffer to a data URL suitable for the OpenAI vision API.
 */
export function bufferToDataUrl(
  bytes: Uint8Array,
  mimeType: string,
): string {
  // Build the base64 payload in chunks to avoid call-stack limits on large
  // images (downscaled on the client, so this is already small, but be safe).
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64");
  return `data:${mimeType};base64,${base64}`;
}
