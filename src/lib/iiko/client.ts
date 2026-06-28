/**
 * iikoServer resto-API client — Prompt 14.
 *
 * A safe, real iikoServer (on-prem) resto-API client for posting write-off
 * acts (Акт списания). Two modes:
 *
 *   IIKO_MODE=live      Auth → POST write-off → logout, for real.
 *   IIKO_MODE=sandbox   Deterministic mock: returns a fake iiko_doc_id and
 *                       echoes the payload (no network). Default.
 *
 * License-slot safety (the core invariant):
 *   Each auth token occupies one iikoAPIServer license slot. Leaking tokens
 *   exhausts the license pool and blocks the whole integration. So every
 *   token we acquire is released in a `finally` — never held idle for long,
 *   never orphaned by a thrown operation. Tokens are refcounted so concurrent
 *   operations share one token + one logout, and a short reuse window avoids
 *   re-auth churn during a burst.
 *
 * Server-only. Never import from a Client Component.
 */

import { createHash } from "node:crypto";
import { assertServerSide } from "@/lib/api";

// ── Mode ─────────────────────────────────────────────────────────────────────

export type IikoMode = "live" | "sandbox";

const MODE: IikoMode =
  (process.env.IIKO_MODE ?? "sandbox").trim().toLowerCase() === "live"
    ? "live"
    : "sandbox";

/** Safe default: sandbox unless IIKO_MODE=live is set explicitly. */
export function getIikoMode(): IikoMode {
  return MODE;
}

// ── Endpoint paths ───────────────────────────────────────────────────────────
// Auth & logout verified against the on-prem iikoServer resto-api
// (ru.iiko.help; pyiiko/pyiiko2 IikoServer.get_token / quit_token):
//   GET /resto/api/auth?login=<login>&pass=<sha1(password)>  → token (text)
//   GET /resto/api/logout?key=<token>                        → frees the slot
const AUTH_PATH = "/resto/api/auth";
const LOGOUT_PATH = "/resto/api/logout";

// ── Write-off endpoint — THE ONE SWAPPABLE LINE ──────────────────────────────
// The on-prem resto-api imports documents per-type under
//   /resto/api/documents/import/<docType>
// (verified for `productionDocument` in pyiiko / pyiiko2). The write-off act
// (Акт списания) follows the same convention. ⚠ iikoServer versions differ:
//   • some installs expose document import under `/resto/api/v2/documents/import/...`
//   • the newer iiko Public Web API exposes the same act at
//     `document-processing/writeoff-document/create` (JSON, Bearer auth).
// Confirm the exact path/version for the target server (https://ru.iiko.help),
// then swap ONLY this constant to retarget the client.
const WRITEOFF_PATH = "/resto/api/documents/import/writeOffDocument";

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Reuse a live token across operations inside this window (ms). */
const TOKEN_REUSE_MS = 15_000;
/** Per-request timeout (ms). */
const REQUEST_TIMEOUT_MS = 30_000;

// ── Errors ───────────────────────────────────────────────────────────────────

export class IikoError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IikoError";
    this.status = status;
  }
}

// ── Public payload / result types ────────────────────────────────────────────

export interface IikoWriteOffPayload {
  /**
   * The write-off document body.
   *   string  → sent as text/xml        (resto-api document import, XSD body)
   *   object  → sent as application/json (iiko Public Web API)
   */
  document: unknown;
  /** Mirrors iiko_act_ledger.idempotency_key — replay-safe in sandbox. */
  idempotencyKey?: string;
}

export interface IikoWriteOffResult {
  iikoDocId: string;
  mode: IikoMode;
  /** Full parsed/echoed response (JSON object, XML text, or sandbox echo). */
  raw: unknown;
}

export interface IikoTestResult {
  ok: boolean;
  mode: IikoMode;
  token?: string;
  error?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

interface IikoConfig {
  baseUrl: string;
  login: string;
  passSha1?: string;
  password?: string;
}

function readConfig(): IikoConfig {
  const baseUrl = process.env.IIKO_BASE_URL?.trim().replace(/\/+$/, "");
  const login = process.env.IIKO_LOGIN?.trim();
  const passSha1 = process.env.IIKO_PASS_SHA1?.trim() || undefined;
  const password = process.env.IIKO_PASSWORD?.trim() || undefined;
  if (!baseUrl || !login || (!passSha1 && !password)) {
    throw new IikoError(
      "iiko live mode is misconfigured: set IIKO_BASE_URL, IIKO_LOGIN, and " +
        "IIKO_PASS_SHA1 (or IIKO_PASSWORD).",
      0,
    );
  }
  return { baseUrl, login, passSha1, password };
}

function sha1Hex(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

function mask(token: string): string {
  return token.length <= 8 ? "****" : token.slice(0, 4) + "…" + token.slice(-4);
}

// ── Token cache: single-flight + short reuse + refcounted logout ─────────────

interface TokenEntry {
  token: string;
  refCount: number;
  bornAt: number;
}

let cache: TokenEntry | null = null;
let authInFlight: Promise<TokenEntry> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleLogout(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleLogout(): void {
  cancelIdleLogout();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (cache && cache.refCount === 0) {
      const tok = cache.token;
      cache = null;
      void logout(tok).catch(() => {
        /* best-effort */
      });
    }
  }, TOKEN_REUSE_MS);
}

async function doAuth(): Promise<TokenEntry> {
  const token = await authenticate();
  return { token, refCount: 0, bornAt: Date.now() };
}

/**
 * Acquire a live token. Concurrent callers share a single in-flight auth
 * (single-flight) and reuse a fresh token (short reuse). Each acquire must be
 * paired with a `releaseToken` in a `finally`.
 */
async function acquireToken(): Promise<string> {
  const now = Date.now();
  if (cache) {
    const stale = now - cache.bornAt > TOKEN_REUSE_MS;
    // Reuse when fresh, or when busy (can't safely evict an in-flight token).
    if (!stale || cache.refCount > 0) {
      cancelIdleLogout();
      cache.refCount += 1;
      return cache.token;
    }
    // Stale & idle: free the slot, then re-auth.
    const tok = cache.token;
    cache = null;
    cancelIdleLogout();
    void logout(tok).catch(() => {
      /* best-effort */
    });
  }

  if (!authInFlight) {
    authInFlight = doAuth().finally(() => {
      authInFlight = null;
    });
  }
  // All awaiters of this in-flight auth receive the same TokenEntry object, so
  // mutating its refCount coordinates leader/follower without reading the
  // (unreliably-narrowed) outer `cache` after the await. We only reached the
  // auth because cache was null/stale-idle, so installing `entry` is safe.
  const entry = await authInFlight;
  entry.refCount += 1;
  cache = entry;
  return entry.token;
}

async function releaseToken(token: string): Promise<void> {
  if (!cache || cache.token !== token) return;
  cache.refCount = Math.max(0, cache.refCount - 1);
  if (cache.refCount === 0) {
    // Hold the license slot for the short reuse window, then free it.
    scheduleIdleLogout();
  }
}

/** On 401: drop the cached token and free its slot immediately. */
function invalidateToken(token: string): void {
  if (cache && cache.token === token) {
    cache = null;
    cancelIdleLogout();
    void logout(token).catch(() => {
      /* best-effort */
    });
  }
}

// ── HTTP primitives ───────────────────────────────────────────────────────────

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(t) };
}

async function authenticate(): Promise<string> {
  const cfg = readConfig();
  const pass = cfg.passSha1 ?? sha1Hex(cfg.password as string);
  const url =
    `${cfg.baseUrl}${AUTH_PATH}` +
    `?login=${encodeURIComponent(cfg.login)}` +
    `&pass=${encodeURIComponent(pass)}`;

  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal });
    const text = await res.text();
    const token = text.trim();
    if (!res.ok || !token) {
      throw new IikoError(
        `iiko auth failed (HTTP ${res.status}): ${text.slice(0, 160)}`,
        res.status,
      );
    }
    return token;
  } finally {
    cancel();
  }
}

/** Best-effort: never throws — callers wrap in `.catch()`. */
async function logout(token: string): Promise<void> {
  const cfg = readConfig();
  const url = `${cfg.baseUrl}${LOGOUT_PATH}?key=${encodeURIComponent(token)}`;
  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    await fetch(url, { method: "GET", signal });
  } finally {
    cancel();
  }
}

async function postWriteOffRequest(
  token: string,
  payload: IikoWriteOffPayload,
): Promise<Response> {
  const cfg = readConfig();
  const url = `${cfg.baseUrl}${WRITEOFF_PATH}?key=${encodeURIComponent(token)}`;
  const isXml = typeof payload.document === "string";
  const headers: Record<string, string> = isXml
    ? { "Content-Type": "text/xml; charset=utf-8" }
    : { "Content-Type": "application/json; charset=utf-8" };
  if (payload.idempotencyKey) {
    headers["X-Idempotency-Key"] = payload.idempotencyKey;
  }
  const body = isXml
    ? (payload.document as string)
    : JSON.stringify(payload.document);

  const { signal, cancel } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "POST", headers, body, signal });
  } finally {
    cancel();
  }
}

// ── Response parsing ─────────────────────────────────────────────────────────

const GUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

function firstGuidIn(text: string): string | undefined {
  return text.match(GUID_RE)?.[0];
}

function findDocIdInJson(value: unknown): string | undefined {
  if (typeof value === "string") return firstGuidIn(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const id = findDocIdInJson(v);
      if (id) return id;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of [
      "documentId",
      "docId",
      "id",
      "writeOffDocumentId",
      "documentNumber",
    ]) {
      const v = obj[k];
      if (typeof v === "string") {
        const id = firstGuidIn(v);
        if (id) return id;
      }
    }
    for (const v of Object.values(obj)) {
      const id = findDocIdInJson(v);
      if (id) return id;
    }
  }
  return undefined;
}

async function parseWriteOffResponse(
  res: Response,
): Promise<IikoWriteOffResult> {
  const text = await res.text();
  let raw: unknown = text;
  let iikoDocId: string | undefined;

  try {
    const json = JSON.parse(text);
    raw = json;
    iikoDocId = findDocIdInJson(json);
  } catch {
    // XML / plain text — fall through to GUID extraction.
  }

  if (!iikoDocId) iikoDocId = firstGuidIn(text);

  if (!iikoDocId) {
    throw new IikoError(
      `iiko write-off succeeded (HTTP ${res.status}) but no document id was ` +
        `returned: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return { iikoDocId, mode: "live", raw };
}

// ── Sandbox ──────────────────────────────────────────────────────────────────

function deterministicDocId(seed: string): string {
  const h = createHash("sha1").update(seed, "utf8").digest("hex");
  // Shape as a UUID v4 (deterministic, RFC-flavoured) so it looks like an iiko GUID.
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}` +
    `-4${h.slice(12, 15)}` +
    `-a${h.slice(15, 18)}` +
    `-${h.slice(18, 30)}`
  ).toLowerCase();
}

function sandboxPostWriteOff(payload: IikoWriteOffPayload): IikoWriteOffResult {
  const seed =
    payload.idempotencyKey ??
    (typeof payload.document === "string"
      ? payload.document
      : JSON.stringify(payload.document ?? {}));
  return {
    iikoDocId: deterministicDocId(seed),
    mode: "sandbox",
    raw: {
      sandbox: true,
      echoedDocument: payload.document,
      idempotencyKey: payload.idempotencyKey ?? null,
      generatedAt: new Date().toISOString(),
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Post a write-off act to iiko. In sandbox, returns a deterministic fake doc id
 * and echoes the payload. In live, auths (single-flight, short reuse), posts,
 * retries once on 401, and always logs out to free the license slot.
 */
export async function postWriteOff(
  payload: IikoWriteOffPayload,
): Promise<IikoWriteOffResult> {
  assertServerSide();
  if (MODE === "sandbox") return sandboxPostWriteOff(payload);

  const token = await acquireToken();
  try {
    let res = await postWriteOffRequest(token, payload);

    if (res.status === 401) {
      // Token expired/invalid — re-auth once and retry the post.
      invalidateToken(token);
      const fresh = await acquireToken();
      try {
        res = await postWriteOffRequest(fresh, payload);
      } finally {
        await releaseToken(fresh);
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new IikoError(
        `iiko write-off failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
        res.status,
      );
    }
    return await parseWriteOffResponse(res);
  } finally {
    await releaseToken(token);
  }
}

/**
 * Auth + immediate logout. Proves live credentials work and that the slot is
 * released cleanly. Used by the Iiko admin "test connection" affordance.
 */
export async function testConnection(): Promise<IikoTestResult> {
  assertServerSide();
  if (MODE === "sandbox") return { ok: true, mode: "sandbox" };
  try {
    const token = await acquireToken();
    try {
      return { ok: true, mode: "live", token: mask(token) };
    } finally {
      await releaseToken(token);
    }
  } catch (err) {
    return {
      ok: false,
      mode: "live",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
