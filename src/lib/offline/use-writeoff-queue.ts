"use client";

/**
 * useWriteoffQueue — Prompt 7 capture wiring.
 *
 * Glues the IndexedDB queue, the flush engine, and the service worker together
 * for the capture flow:
 *   - tracks online/offline + pending/synced counts,
 *   - exposes an optimistic `enqueue` (writes to IDB, shows "Filed" instantly),
 *   - auto-flushes on mount, on the `online` event, on SW flush nudges, and on
 *     a short interval while online with pending work,
 *   - reports the sync status of the most recently filed submission so the
 *     success screen can show pending → syncing → synced/failed.
 *
 * The hook never throws into the capture flow — flush failures back off and
 * leave items pending for the next reconnect.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueue as dbEnqueue,
  pendingCount as dbPendingCount,
  getById,
  type EnqueueInput,
  type QueuedSubmission,
  type QueueStatus,
} from "@/lib/offline/queue";
import { flushQueue, type FlushResult } from "@/lib/offline/flush";
import {
  registerServiceWorker,
  onFlushTrigger,
  requestBackgroundSync,
} from "@/lib/offline/sw-register";

export interface UseWriteoffQueue {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  lastFlush: FlushResult | null;
  /** Sync status of the most recently enqueued submission. */
  lastEnqueuedStatus: QueueStatus | null;
  lastEnqueuedError: string | null;
  enqueue: (input: EnqueueInput) => Promise<QueuedSubmission>;
  flushNow: () => Promise<void>;
}

const FLUSH_INTERVAL_MS = 15_000;

export function useWriteoffQueue(userId: string | null): UseWriteoffQueue {
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [lastFlush, setLastFlush] = useState<FlushResult | null>(null);
  const [lastEnqueuedStatus, setLastEnqueuedStatus] =
    useState<QueueStatus | null>(null);
  const [lastEnqueuedError, setLastEnqueuedError] = useState<string | null>(null);

  const lastEnqueuedIdRef = useRef<string | null>(null);
  const flushingRef = useRef<boolean>(false);
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;

  // ── Refresh counts + last-enqueued status from IDB ──────────────────────────
  const refresh = useCallback(async () => {
    const count = await dbPendingCount();
    setPendingCount(count);
    const id = lastEnqueuedIdRef.current;
    if (id) {
      const rec = await getById(id);
      if (rec) {
        setLastEnqueuedStatus(rec.status);
        setLastEnqueuedError(rec.lastError);
      }
    }
  }, []);

  // ── Flush (guarded against re-entry) ────────────────────────────────────────
  const flushNow = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid || flushingRef.current) return;
    flushingRef.current = true;
    setSyncing(true);
    try {
      const result = await flushQueue(uid);
      setLastFlush(result);
      await refresh();
    } finally {
      flushingRef.current = false;
      setSyncing(false);
    }
  }, [refresh]);

  // ── Enqueue (optimistic) ────────────────────────────────────────────────────
  const enqueue = useCallback(
    async (input: EnqueueInput): Promise<QueuedSubmission> => {
      const record = await dbEnqueue(input);
      lastEnqueuedIdRef.current = record.id;
      setLastEnqueuedStatus("pending");
      setLastEnqueuedError(null);
      setPendingCount((c) => c + 1);
      // Ask the OS to retry on reconnect even if the tab is closed; also kick
      // an immediate flush attempt (no-op if offline).
      void requestBackgroundSync();
      if (typeof navigator !== "undefined" && navigator.onLine) {
        void flushNow();
      }
      return record;
    },
    [flushNow],
  );

  // ── One-time setup: SW + listeners ──────────────────────────────────────────
  useEffect(() => {
    void registerServiceWorker();

    const onOnline = () => {
      setOnline(true);
      void flushNow();
    };
    const onOffline = () => setOnline(false);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const offSWFlush = onFlushTrigger(() => void flushNow());

    void refresh();
    if (typeof navigator !== "undefined" && navigator.onLine) {
      void flushNow();
    }

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      offSWFlush();
    };
  }, [flushNow, refresh]);

  // ── Periodic flush while online with pending work ───────────────────────────
  useEffect(() => {
    if (!online) return;
    const t = window.setInterval(() => {
      void refresh();
      if (pendingCount > 0) void flushNow();
    }, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [online, pendingCount, flushNow, refresh]);

  return {
    online,
    pendingCount,
    syncing,
    lastFlush,
    lastEnqueuedStatus,
    lastEnqueuedError,
    enqueue,
    flushNow,
  };
}
