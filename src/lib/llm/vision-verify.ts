/**
 * Vision claim verification — Prompt 9.1.
 *
 * A second gpt-4o-mini (vision) pass that runs AFTER the client-side pre-fill,
 * as part of the sequential server-side forensics pipeline (`run.ts`). Where
 * pre-fill guesses a classification from the photo alone, verify judges the
 * photo AGAINST the submitted claim and returns a machine `verdict` the pipeline
 * maps to a risk_event:
 *
 *   'ok'           → no flag
 *   'mismatch'     → risk_event('vision_mismatch')   (+35, forces on_hold)
 *   'inconclusive' → risk_event('vision_unverified') (+20, → in_review)
 *
 * The verdict field is the fix for the prod bug where the model returned only
 * `{"notes": "..."}` (e.g. "too dark to identify") with no verdict, so no flag
 * fired and no risk_event row was written. The verdict is now a REQUIRED enum,
 * the system prompt forbids notes-only replies, and `zodResponseFormat` runs in
 * strict JSON-schema mode so a missing field is rejected by the parser — and a
 * parse failure is fail-closed by `run.ts` into 'inconclusive' / vision_unverified.
 *
 * Server-only — the OPENAI_API_KEY never reaches the browser.
 *
 * Conventions (shared with vision-prefill):
 *   - `.nullable()` (not `.optional()`) for optional-ish fields in the LLM schema;
 *     every key is required so strict mode accepts the contract.
 *   - A single model call per photo (no parallel fan-out).
 *   - `temperature: 0`, `detail: "low"` — verification is a cheap, deterministic
 *     judgement, not a creative generation.
 *   - Throws on failure; the pipeline catches and fail-closes so a vision outage
 *     never silently auto-approves an unverified write-off.
 */

import { z } from "zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

// ── Schema ────────────────────────────────────────────────────────────────────

/** The closed set of verdicts the model may return. */
export const VISION_VERDICTS = ["ok", "mismatch", "inconclusive"] as const;
export type VisionVerdict = (typeof VISION_VERDICTS)[number];

/**
 * Structured-output contract for gpt-4o-mini verification (Prompt 9.1).
 *
 * `verdict` is the ALWAYS-present machine verdict the pipeline maps to a
 * risk_event — without it the model could return notes alone and no flag would
 * fire (the prod bug this fixes). Every key is required; the optional-ish ones
 * use `.nullable()` (not `.optional()`) so strict JSON-schema mode accepts them.
 *
 * `visible_qty` is nullable: null when the count in-frame is genuinely
 * unknowable (a blurred pile, a dark frame).
 */
export const VisionVerifySchema = z.object({
  verdict: z.enum(VISION_VERDICTS),
  matches_product: z.boolean(),
  matches_defect: z.boolean(),
  visible_qty: z.number().nullable(),
  confidence: z.number(),
  notes: z.string().nullable(),
});

export type VisionVerify = z.infer<typeof VisionVerifySchema>;

/**
 * Build a fail-closed `VisionVerify` used when the model call could not produce
 * a real verdict (error / timeout / parse failure / no image bytes). The
 * pipeline stores this in `vision_result` so the DB always carries a verdict,
 * and emits `vision_unverified` — a doubtful write-off goes to review rather
 * than being auto-approved unverified.
 */
export function inconclusiveVisionResult(notes: string): VisionVerify {
  return {
    verdict: "inconclusive",
    matches_product: false,
    matches_defect: false,
    visible_qty: null,
    confidence: 0,
    notes,
  };
}

/** The submitted claim we verify the photo against. */
export interface VisionClaim {
  /** Claimed product — the comment, or the reason label when no comment. */
  productLabel: string;
  /** Claimed defect / loss reason — reason_codes.label_ru (+ category). */
  defectLabel: string;
  /** Declared writeoff quantity. */
  declaredQty: number;
  /** Declared unit (кг, шт, …). */
  unit: string;
}

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
  "You are a fraud-detection assistant for a restaurant/kitchen writeoff app.",
  "Given a photo and the claim the employee submitted (product, defect/reason,",
  "declared quantity), judge whether the photo actually supports that claim, and",
  "return a single machine `verdict` plus the supporting fields.",
  "",
  "verdict — one of:",
  "  'ok'           — the photo clearly shows the claimed product AND defect, and",
  "                   the visible quantity is consistent with the declared qty.",
  "  'mismatch'     — the photo shows a different product, a different kind of",
  "                   defect, or clearly fewer units than declared.",
  "  'inconclusive' — the photo cannot be verified: too dark, blurry, blank, or",
  "                   it shows a screen / a face / something unrelated to the claim.",
  "",
  "Field rules:",
  "  matches_product — does the photo show a product consistent with the claim?",
  "  matches_defect  — does the visible defect/damage match the claimed reason?",
  "  visible_qty     — how many units are visibly present (a number, or null if",
  "                    genuinely unknowable from the frame).",
  "  confidence      — your confidence in matches_product + matches_defect, 0..1.",
  "  notes           — a short rationale, or null.",
  "",
  "A dark / blurry / blank / screen / face / unrelated image MUST be verdict",
  "'inconclusive' or 'mismatch' with matches_product=false. ALWAYS return every",
  "field; never return notes alone. Be strict — this is a fraud screen, not a",
  "helper: do not give the employee the benefit of the doubt. Keep notes terse.",
].join("\n");

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Verify a single photo against `claim` using gpt-4o-mini.
 *
 * @param imageDataUrl  a `data:image/...;base64,...` URL for the photo
 * @param claim         the submitted claim to verify against
 * @returns             parsed structured result (always carries a `verdict`)
 * @throws              on any API / parse failure — the pipeline catches this
 *                      and fail-closes to `inconclusiveVisionResult` +
 *                      `risk_event('vision_unverified')`
 */
export async function visionVerifyFromImage(
  imageDataUrl: string,
  claim: VisionClaim,
): Promise<VisionVerify> {
  const client = getClient();

  const userText = [
    "Verify this writeoff photo against the submitted claim.",
    `Claimed product: ${claim.productLabel}`,
    `Claimed defect: ${claim.defectLabel}`,
    `Declared quantity: ${claim.declaredQty} ${claim.unit}`,
    "Return the verdict and every structured field.",
  ].join("\n");

  // zodResponseFormat enforces strict JSON-schema mode (strict: true), so the
  // API rejects a response missing any required field — a notes-only reply is
  // impossible. If the model still refuses, .parsed is null and we throw, which
  // the pipeline treats as fail-closed (vision_unverified).
  const completion = await client.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
        ],
      },
    ],
    response_format: zodResponseFormat(VisionVerifySchema, "vision_verify"),
    temperature: 0,
    max_tokens: 300,
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("Vision verify model returned no parseable output");
  }
  return parsed;
}
