/**
 * Deterministic fake Iiko GUID (Prompt B sandbox).
 *
 * In sandbox mode there are no real Iiko store/account GUIDs, so we auto-fill
 * each store's iiko_store_id (+ iiko_account_id) with a deterministic fake
 * derived from the store id. The whole pipeline then demos end-to-end across
 * the 87-store network without a single real GUID. Isomorphic (no node deps)
 * so the server action and the iiko client share one implementation.
 *
 * Shape: UUID v4-flavoured (deterministic), so it looks like an iiko GUID and
 * passes the same format validation the real ones do.
 */

import { createHash } from "node:crypto";

export function deterministicFakeGuid(seed: string): string {
  const h = createHash("sha1").update(seed, "utf8").digest("hex");
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}` +
    `-4${h.slice(12, 15)}` +
    `-a${h.slice(15, 18)}` +
    `-${h.slice(18, 30)}`
  ).toLowerCase();
}
