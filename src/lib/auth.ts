/**
 * Server-side auth helpers.
 *
 * Plain async functions for Server Components, Route Handlers, and Server Actions.
 */

import { createClient } from "@/lib/supabase/server";
import type { Location, Profile, UserRole } from "@/lib/db/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CurrentProfile {
  id: string;
  full_name: string;
  /** Two-letter initials derived from full_name — ready for avatar circles. */
  initials: string;
  role: UserRole;
  location_id: string | null;
  location: Location | null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the currently authenticated user's profile + joined location,
 * or null if the session is missing / the profile row doesn't exist yet.
 */
export async function getCurrentProfile(): Promise<CurrentProfile | null> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return null;

  // Explicit cast: supabase-js v2 strict inference can resolve to `never` when
  // the Database type carries the __InternalSupabase marker.
  const { data: raw, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  const profileData = raw as Profile | null;
  if (profileError || !profileData) return null;

  let location: Location | null = null;
  if (profileData.location_id) {
    const { data: rawLoc } = await supabase
      .from("locations")
      .select("*")
      .eq("id", profileData.location_id)
      .single();
    location = (rawLoc as Location | null) ?? null;
  }

  return {
    id: profileData.id,
    full_name: profileData.full_name,
    initials: getInitials(profileData.full_name),
    role: (profileData.role as UserRole) ?? "employee",
    location_id: profileData.location_id,
    location,
  };
}
