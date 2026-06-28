"use client";

/**
 * Service worker registration + reconnect signalling — Prompt 7 / 23.1.
 *
 * Registration is PRODUCTION-ONLY. In dev the SW is torn down (unregistered +
 * every cache dropped) so local edits are always visible and no stale shell can
 * haunt development. The Prompt 7 capture hook also calls `registerServiceWorker`
 * — it is safe because the prod-gate and dev teardown live here, the single
 * source of truth.
 *
 * Also wires SW → page FLUSH nudges (Background Sync 'sync' event or 'message'
 * channel) so the IndexedDB queue can drain on reconnect.
 */

type FlushListener = () => void;

const SW_PATH = "/sw.js";
const FLUSH_SYNC_TAG = "bahandi-flush";

const isProd = process.env.NODE_ENV === "production";

let _setup = false;
const listeners = new Set<FlushListener>();

function notify() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore listener errors */
    }
  });
}

/**
 * Register the SW once. In production this wires SW → page flush messages.
 * In development it unregisters any SW and clears all caches, then returns.
 * Idempotent across callers (the layout PwaRegister + the P7 capture hook).
 */
export async function registerServiceWorker(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (_setup) return;
  _setup = true;

  if (!isProd) {
    await teardownServiceWorker();
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });

    // SW → page flush nudges (Background Sync 'sync' event or 'message').
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "FLUSH") notify();
    });

    void reg;
  } catch {
    // SW registration is progressive enhancement; failures are non-fatal.
    // Reset so a later mount can retry.
    _setup = false;
  }
}

/**
 * Development safety net: unregister every SW on this origin and wipe all
 * caches so a previous prod build (or an earlier experiment) can never serve
 * stale files during local development.
 */
async function teardownServiceWorker(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* ignore */
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* ignore */
  }
}

/** Subscribe to flush triggers originating from the SW. Returns an unsubscribe. */
export function onFlushTrigger(listener: FlushListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Request a Background Sync so the OS retries the flush when connectivity
 * returns, even if the tab is closed. No-op in dev (no SW). Falls back
 * silently when unsupported.
 */
export async function requestBackgroundSync(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!isProd) return;
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("sync" in reg) {
      // @ts-expect-error — `sync` is not in the lib types on all platforms.
      await reg.sync.register(FLUSH_SYNC_TAG);
    }
  } catch {
    /* Background Sync unavailable — page-level online listener covers it. */
  }
}

/** Ask the controlling SW to broadcast a FLUSH to all clients. No-op in dev. */
export async function triggerFlushViaSW(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!isProd) return;
  try {
    const ctrl = navigator.serviceWorker.controller;
    if (ctrl) ctrl.postMessage({ type: "TRIGGER_FLUSH" });
  } catch {
    /* ignore */
  }
}
