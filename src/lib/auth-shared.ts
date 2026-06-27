/**
 * Client-safe auth types and helpers.
 * Do not import server-only modules here — safe for "use client" bundles.
 */

import type { Location, UserRole } from "@/lib/db/types";

export const ROLE_LABEL: Record<UserRole, string> = {
  employee: "Сотрудник",
  reviewer: "Проверяющий",
  admin: "Администратор",
};

export const DEV_PREVIEW_STORAGE_KEY = "bahandi-dev-preview";
export const CAPTURE_LOCATION_STORAGE_KEY = "bahandi-capture-location";

export interface DevPreviewState {
  role: UserRole | null;
  locationId: string | null;
}

export const EMPTY_DEV_PREVIEW: DevPreviewState = {
  role: null,
  locationId: null,
};

export interface CurrentProfile {
  id: string;
  full_name: string;
  /** Two-letter initials derived from full_name — ready for avatar circles. */
  initials: string;
  role: UserRole;
  location_id: string | null;
  location: Location | null;
}

/** Real role unless a dev preview override is active (production always uses real). */
export function getEffectiveRole(
  realRole: UserRole,
  preview: DevPreviewState | null | undefined,
): UserRole {
  if (process.env.NODE_ENV === "production") return realRole;
  return preview?.role ?? realRole;
}

/** Profile location wins; otherwise session pick, then dev preview default. */
export function resolveCaptureLocationId(
  profileLocationId: string | null,
  sessionLocationId: string | null | undefined,
  preview: DevPreviewState | null | undefined,
): string | null {
  if (profileLocationId) return profileLocationId;
  return sessionLocationId ?? preview?.locationId ?? null;
}
