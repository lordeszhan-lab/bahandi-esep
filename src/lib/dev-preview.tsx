"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEV_PREVIEW_STORAGE_KEY,
  EMPTY_DEV_PREVIEW,
  getEffectiveRole,
  type DevPreviewState,
} from "@/lib/auth-shared";
import type { CurrentProfile } from "@/lib/auth-shared";
import type { UserRole } from "@/lib/db/types";

// ── Context ───────────────────────────────────────────────────────────────────

interface DevPreviewContextValue {
  preview: DevPreviewState;
  setPreviewRole: (role: UserRole | null) => void;
  setPreviewLocationId: (locationId: string | null) => void;
  resetPreview: () => void;
  effectiveRole: UserRole;
}

const DevPreviewContext = createContext<DevPreviewContextValue | null>(null);

function readStoredPreview(): DevPreviewState {
  if (typeof window === "undefined") return EMPTY_DEV_PREVIEW;
  try {
    const raw = localStorage.getItem(DEV_PREVIEW_STORAGE_KEY);
    if (!raw) return EMPTY_DEV_PREVIEW;
    const parsed = JSON.parse(raw) as Partial<DevPreviewState>;
    return {
      role: parsed.role ?? null,
      locationId: parsed.locationId ?? null,
    };
  } catch {
    return EMPTY_DEV_PREVIEW;
  }
}

function writeStoredPreview(state: DevPreviewState) {
  if (typeof window === "undefined") return;
  const isEmpty = !state.role && !state.locationId;
  if (isEmpty) {
    localStorage.removeItem(DEV_PREVIEW_STORAGE_KEY);
  } else {
    localStorage.setItem(DEV_PREVIEW_STORAGE_KEY, JSON.stringify(state));
  }
}

export function DevPreviewProvider({
  realRole,
  children,
}: {
  realRole: UserRole;
  children: ReactNode;
}) {
  const isDev = process.env.NODE_ENV !== "production";
  const [preview, setPreview] = useState<DevPreviewState>(EMPTY_DEV_PREVIEW);

  useEffect(() => {
    if (isDev) setPreview(readStoredPreview());
  }, [isDev]);

  const persist = useCallback(
    (updater: DevPreviewState | ((prev: DevPreviewState) => DevPreviewState)) => {
      if (!isDev) return;
      setPreview((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        writeStoredPreview(next);
        return next;
      });
    },
    [isDev],
  );

  const setPreviewRole = useCallback(
    (role: UserRole | null) => {
      persist((prev) => ({ ...prev, role }));
    },
    [persist],
  );

  const setPreviewLocationId = useCallback(
    (locationId: string | null) => {
      persist((prev) => ({ ...prev, locationId }));
    },
    [persist],
  );

  const resetPreview = useCallback(() => {
    persist(EMPTY_DEV_PREVIEW);
  }, [persist]);

  const effectiveRole = getEffectiveRole(realRole, isDev ? preview : null);

  const value = useMemo(
    () => ({
      preview: isDev ? preview : EMPTY_DEV_PREVIEW,
      setPreviewRole,
      setPreviewLocationId,
      resetPreview,
      effectiveRole,
    }),
    [
      isDev,
      preview,
      setPreviewRole,
      setPreviewLocationId,
      resetPreview,
      effectiveRole,
    ],
  );

  return (
    <DevPreviewContext.Provider value={value}>
      {children}
    </DevPreviewContext.Provider>
  );
}

export function useDevPreview(): DevPreviewContextValue {
  const ctx = useContext(DevPreviewContext);
  if (!ctx) {
    throw new Error("useDevPreview must be used within DevPreviewProvider");
  }
  return ctx;
}

/** Merge real profile with dev preview role for UI display. */
export function useEffectiveProfile(profile: CurrentProfile): CurrentProfile & {
  effectiveRole: UserRole;
} {
  const { effectiveRole } = useDevPreview();
  return useMemo(
    () => ({
      ...profile,
      role: effectiveRole,
      effectiveRole,
    }),
    [profile, effectiveRole],
  );
}
