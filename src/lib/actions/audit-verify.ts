"use server";

/**
 * Admin "verify chain" action — Prompt 13.
 *
 * A thin server-action wrapper around the pure `verifyAuditChain` / 
 * `verifyWriteoffChain` helpers. Guards on the admin role before replaying the
 * audit log, so only an admin can trigger a chain verification (the result
 * surfaces the integrity of every decision ever made). Reads use the service
 * role so the admin sees the complete, un-redacted chain.
 */

import { verifyAuditChain, verifyWriteoffChain, type ChainVerification } from "@/lib/audit";
import { getCurrentProfile } from "@/lib/auth";

export interface VerifyChainResult {
  ok: boolean;
  error?: string;
  verification?: ChainVerification;
}

/**
 * Verify the global audit chain. Admin-only.
 */
export async function verifyAuditChainAction(): Promise<VerifyChainResult> {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "admin") {
    return { ok: false, error: "Только администратор может проверять цепочку" };
  }
  try {
    const verification = await verifyAuditChain();
    return { ok: true, verification };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Ошибка проверки цепочки",
    };
  }
}

/**
 * Verify the audit chain for a single write-off. Admin-only.
 */
export async function verifyWriteoffChainAction(
  writeoffId: string,
): Promise<VerifyChainResult> {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "admin") {
    return { ok: false, error: "Только администратор может проверять цепочку" };
  }
  try {
    const verification = await verifyWriteoffChain(writeoffId);
    return { ok: true, verification };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Ошибка проверки цепочки",
    };
  }
}
