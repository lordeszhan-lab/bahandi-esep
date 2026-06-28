"use server";

/**
 * Tower drill-down action — Prompt C.
 *
 * The leaderboard / city roll-up expand a store's write-off list on click. That
 * list is a server-side read (signed photo URLs + risk-feature parsing), so it
 * can't run in the client. This action wraps `loadStoreWriteoffs` and returns a
 * lightweight, read-only projection in the cockpit visual language — the client
 * calls it via `useTransition` and renders the rows inline.
 *
 * Auth: the Tower is reviewer/admin only; an employee calling this directly gets
 * an empty list (the page already redirects employees, this is the defence-in-depth).
 */

import { getCurrentProfile } from "@/lib/auth";
import { loadStoreWriteoffs } from "@/lib/analytics/tower";
import type { StoreWriteoff } from "@/lib/analytics/types";

export async function fetchStoreWriteoffs(
  storeId: string,
  from: string,
  to: string,
): Promise<StoreWriteoff[]> {
  if (!storeId || !from || !to) return [];
  const profile = await getCurrentProfile();
  if (!profile || profile.role === "employee") return [];
  return loadStoreWriteoffs({ storeId, from, to });
}
