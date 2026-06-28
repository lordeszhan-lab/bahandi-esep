/**
 * Hash-chained audit log — Prompt 13.
 *
 * The single source of truth for appending to and verifying `audit_log`.
 * Every state transition (routing, SLA escalation, reviewer decisions,
 * submission) writes its audit entry through `appendAuditEntry`, which links
 * the new row to the previous one by a SHA-256 hash chain:
 *
 *   hash = sha256(prev_hash + canonical(payload))
 *
 * where `canonical(payload)` is a deterministic, key-sorted JSON serialization
 * of the full audit record (writeoff_id, actor_id, action, payload). `prev_hash`
 * is the hash of the most recent audit row overall — the chain is GLOBAL, so
 * tampering with any row (its action, actor, payload, or a prior hash) breaks
 * verification for every row that follows it, across all write-offs.
 *
 * `verifyAuditChain` is the admin "verify chain" action: it replays the whole
 * log in insertion order, re-derives each hash, and reports the first break.
 * `verifyWriteoffChain` scopes the same check to one write-off's entries.
 *
 * Service role only — `audit_log` has no user INSERT policy by design, so all
 * writes go through the service client. Reads (verify) also use the service
 * role so an admin sees the complete, un-redacted chain.
 */

import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditLog, Database, Json } from "@/lib/db/types";

// ── Canonical serialization ──────────────────────────────────────────────────

/**
 * Deterministic JSON serialization: object keys are sorted at every depth so
 * two structurally-equal records always produce the same string (and therefore
 * the same hash), regardless of insertion order. Primitives pass through.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * The record bound into each hash. This is the full audit tuple — every column
 * that carries meaning — so the hash protects the action, the actor, the
 * subject write-off, and the decision payload together.
 */
export interface AuditRecord {
  writeoff_id: string | null;
  actor_id: string | null;
  action: string;
  payload: Json | null;
}

/**
 * Compute the chain hash for one audit record given the previous row's hash.
 * `hash = sha256(prev_hash + canonical(record))` — the prompt's formula, with
 * `payload` taken to be the canonical serialization of the full audit tuple so
 * the action and actor are bound into the chain too.
 */
export function computeAuditHash(prevHash: string | null, record: AuditRecord): string {
  return createHash("sha256")
    .update((prevHash ?? "") + canonicalStringify(record))
    .digest("hex");
}

// ── Append ───────────────────────────────────────────────────────────────────

export interface AuditEntryInput {
  writeoffId: string | null;
  actorId: string | null;
  action: string;
  payload: Record<string, unknown>;
}

export interface AppendedAudit {
  id: string;
  prevHash: string | null;
  hash: string;
}

/**
 * Append a hash-chained audit entry. `prev_hash` is the hash of the most recent
 * audit row overall (the global chain head), making the whole log tamper-
 * evident end-to-end. The new row's `hash` is derived from that prev_hash plus
 * the canonical record. Returns the inserted id + hashes.
 *
 * NOTE: the head lookup + insert is not atomic; under concurrent appends one
 * writer could read the same prev_hash. At this product's concurrency that is
 * acceptable — the chain still verifies serially. A Postgres sequence + unique
 * constraint on prev_hash would harden it if needed later.
 */
export async function appendAuditEntry(
  service: SupabaseClient<Database> | undefined,
  entry: AuditEntryInput,
): Promise<AppendedAudit> {
  const client = service ?? createServiceClient();

  // Chain head = the most recent row by created_at, ties broken by id for a
  // deterministic order. .single() returns null via error when the table is
  // empty — handled below.
  const { data: lastRow, error: headErr } = await client
    .from("audit_log")
    .select("hash")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (headErr) {
    // A failed head read must not produce a broken chain — surface it loudly.
    throw new Error(`[audit] chain head read failed: ${headErr.message}`);
  }
  const prevHash = (lastRow as { hash: string } | null)?.hash ?? null;

  const record: AuditRecord = {
    writeoff_id: entry.writeoffId,
    actor_id: entry.actorId,
    action: entry.action,
    payload: entry.payload as unknown as Json,
  };
  const hash = computeAuditHash(prevHash, record);

  const { data: inserted, error: insertErr } = await client
    .from("audit_log")
    .insert({
      writeoff_id: entry.writeoffId,
      actor_id: entry.actorId,
      action: entry.action,
      prev_hash: prevHash,
      hash,
      payload: entry.payload as unknown as Json,
    } as unknown as never)
    .select("id")
    .single();

  if (insertErr || !inserted) {
    throw new Error(
      `[audit] insert failed for ${entry.action} on ${entry.writeoffId}: ${insertErr?.message ?? "no row"}`,
    );
  }
  return { id: (inserted as { id: string }).id, prevHash, hash };
}

// ── Verify ───────────────────────────────────────────────────────────────────

export interface ChainVerification {
  verified: boolean;
  checked: number;
  /** id of the first row whose stored hash or prev_hash link is broken. */
  brokenAtId: string | null;
  /** Human-facing reason for the first break, or null when the chain is intact. */
  reason: string | null;
}

/**
 * Verify the global audit chain: replay every row in insertion order, re-derive
 * each hash from its stored prev_hash + record, confirm the stored hash matches
 * AND each row's prev_hash equals the previous row's hash. The first mismatch
 * breaks the chain. Tampering with any row's contents (or a prior hash) is
 * detected at that row and propagates to every row after it.
 */
export async function verifyAuditChain(
  service: SupabaseClient<Database> | undefined = undefined,
): Promise<ChainVerification> {
  const client = service ?? createServiceClient();
  const { data: raw, error } = await client
    .from("audit_log")
    .select("id, writeoff_id, actor_id, action, payload, prev_hash, hash, created_at")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    return {
      verified: false,
      checked: 0,
      brokenAtId: null,
      reason: `read failed: ${error.message}`,
    };
  }
  return verifyRows((raw ?? []) as AuditLog[], true);
}

/**
 * Verify only the entries for one write-off. Because the chain is GLOBAL, a
 * write-off's rows are interleaved with unrelated rows: each row's `prev_hash`
 * points at whatever row precedes it in the whole log, not the previous row of
 * THIS write-off. So the per-write-off check only re-derives each row's hash
 * from its OWN stored `prev_hash` (reproducible in isolation) and confirms it
 * matches the stored hash — it does NOT walk prev_hash links between the
 * write-off's own rows. The robust, end-to-end check is `verifyAuditChain`.
 */
export async function verifyWriteoffChain(
  writeoffId: string,
  service: SupabaseClient<Database> | undefined = undefined,
): Promise<ChainVerification> {
  const client = service ?? createServiceClient();
  const { data: raw, error } = await client
    .from("audit_log")
    .select("id, writeoff_id, actor_id, action, payload, prev_hash, hash, created_at")
    .eq("writeoff_id", writeoffId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    return {
      verified: false,
      checked: 0,
      brokenAtId: null,
      reason: `read failed: ${error.message}`,
    };
  }
  return verifyRows((raw ?? []) as AuditLog[], false);
}

/**
 * Pure re-derivation of a row sequence. Each row's stored hash must equal
 * `computeAuditHash(row.prev_hash, record)` — this is the tamper check: change
 * any row's action / actor / payload (or a prior hash it links to) and the
 * recomputed hash diverges.
 *
 * When `checkLinks` is true (the global walk), we additionally confirm each
 * row's `prev_hash` equals the previous row's `hash`, so a deleted or
 * re-ordered row in the middle of the chain is detected. Link-checking is
 * skipped for the per-write-off walk, where consecutive rows are not adjacent
 * in the global chain.
 */
function verifyRows(rows: AuditLog[], checkLinks = true): ChainVerification {
  let previousHash: string | null | undefined = undefined; // undefined = first iteration

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const record: AuditRecord = {
      writeoff_id: row.writeoff_id,
      actor_id: row.actor_id,
      action: row.action,
      payload: row.payload,
    };
    const expected = computeAuditHash(row.prev_hash, record);

    if (expected !== row.hash) {
      return {
        verified: false,
        checked: i,
        brokenAtId: row.id,
        reason: `hash mismatch on ${row.action}: stored ${row.hash.slice(0, 10)}… recomputed ${expected.slice(0, 10)}…`,
      };
    }
    if (checkLinks && previousHash !== undefined && row.prev_hash !== previousHash) {
      return {
        verified: false,
        checked: i,
        brokenAtId: row.id,
        reason: `broken prev_hash link on ${row.action}: expected ${previousHash?.slice(0, 10) ?? "null"}… got ${row.prev_hash?.slice(0, 10) ?? "null"}…`,
      };
    }
    previousHash = row.hash;
  }

  return { verified: true, checked: rows.length, brokenAtId: null, reason: null };
}
