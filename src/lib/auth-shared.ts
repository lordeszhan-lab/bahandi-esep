/**
 * Client-safe auth types and helpers.
 * Do not import server-only modules here — safe for "use client" bundles.
 */

import type { Store, UserRole } from "@/lib/db/types";

export const ROLE_LABEL: Record<UserRole, string> = {
  employee: "Сотрудник",
  reviewer: "Проверяющий",
  admin: "Администратор",
};

export const CAPTURE_LOCATION_STORAGE_KEY = "bahandi-capture-location";

export interface CurrentProfile {
  id: string;
  full_name: string;
  /** Two-letter initials derived from full_name — ready for avatar circles. */
  initials: string;
  role: UserRole;
  location_id: string | null;
  location: Store | null;
}

/** Profile location wins; otherwise session pick from capture UI. */
export function resolveCaptureLocationId(
  profileLocationId: string | null,
  sessionLocationId: string | null | undefined,
): string | null {
  if (profileLocationId) return profileLocationId;
  return sessionLocationId ?? null;
}
