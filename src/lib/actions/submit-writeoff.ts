"use server";

import { after } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runPhotoForensics } from "@/lib/forensics/run";
import { recomputeAndRoute } from "@/lib/risk/recompute";
import { appendAuditEntry } from "@/lib/audit";
import type {
  Profile,
  Store,
  Writeoff,
  WriteoffInsert,
  WriteoffPhotoInsert,
  RiskEventInsert,
} from "@/lib/db/types";

// ── Validation schema ─────────────────────────────────────────────────────────

const WriteoffSchema = z.object({
  reasonCodeId: z.string().uuid(),
  qty: z.number().positive(),
  unit: z.string().min(1).max(20),
  comment: z.string().max(500).optional().nullable(),
  withholding: z.boolean(),
  chargedEmployeeId: z.string().uuid().optional().nullable(),
  storagePath: z.string().min(1),
  gpsLat: z.number().nullable(),
  gpsLng: z.number().nullable(),
  capturedAt: z.string(),
  locationId: z.string().uuid().optional().nullable(),
  /**
   * Prompt 7 anti-batch signal: true when this submission was flushed from the
   * offline queue as part of an end-of-shift burst. We never block on it — it
   * just feeds the risk engine (Prompt 10). null/undefined = filed online in
   * real time.
   */
  batchBurst: z.boolean().nullable().optional(),
});

export type WriteoffPayload = z.infer<typeof WriteoffSchema>;

export interface SubmitResult {
  id: string;
  qty: number;
  unit: string;
  locationName: string | null;
}

// ── Server action ─────────────────────────────────────────────────────────────

export async function submitWriteoff(
  payload: WriteoffPayload,
): Promise<SubmitResult> {
  const supabase = await createClient();

  // ── Auth guard ───────────────────────────────────────────────────────────────
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Не авторизован");

  // ── Validate input ───────────────────────────────────────────────────────────
  const parsed = WriteoffSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Некорректные данные: " + parsed.error.errors[0]?.message);
  }
  const d = parsed.data;

  // ── Fetch profile (server-side — don't trust client location) ────────────────
  // Explicit cast: supabase-js v2 strict inference resolves to `never` with the
  // __InternalSupabase marker. See src/lib/auth.ts for the same pattern.
  const { data: rawProfile } = await supabase
    .from("profiles")
    .select("location_id, role")
    .eq("id", user.id)
    .single();
  const profile = rawProfile as Pick<Profile, "location_id"> & {
    role: string;
  } | null;
  if (!profile) throw new Error("Профиль не найден");

  let effectiveLocationId: string;
  if (profile.location_id) {
    effectiveLocationId = profile.location_id;
  } else {
    if (!d.locationId) throw new Error("Выберите точку");
    const { data: rawLocCheck } = await supabase
      .from("stores")
      .select("id")
      .eq("id", d.locationId)
      .single();
    if (!rawLocCheck) throw new Error("Точка не найдена");
    effectiveLocationId = d.locationId;
  }

  // ── Fetch location name for success screen ───────────────────────────────────
  const { data: rawLocation } = await supabase
    .from("stores")
    .select("name")
    .eq("id", effectiveLocationId)
    .single();
  const location = rawLocation as Pick<Store, "name"> | null;

  // ── Insert writeoff ───────────────────────────────────────────────────────────
  // RLS requires profile.location_id = writeoff.location_id; session-picked locations
  // (admins / unassigned employees) bypass via service role after auth validation.
  const writeoffRow: WriteoffInsert = {
    location_id: effectiveLocationId,
    submitter_id: user.id,
    reason_code_id: d.reasonCodeId,
    qty: d.qty,
    unit: d.unit,
    comment: d.comment ?? null,
    withholding: d.withholding,
    charged_employee_id:
      d.withholding && d.chargedEmployeeId ? d.chargedEmployeeId : null,
    status: "submitted",
  };

  let rawWriteoff: Pick<Writeoff, "id"> | null = null;
  let wErr: { message: string } | null = null;

  if (profile.location_id) {
    const result = await supabase
      .from("writeoffs")
      .insert(writeoffRow as unknown as never)
      .select("id")
      .single();
    rawWriteoff = result.data as Pick<Writeoff, "id"> | null;
    wErr = result.error;
  } else {
    const serviceClient = createServiceClient();
    const result = await serviceClient
      .from("writeoffs")
      .insert(writeoffRow as unknown as never)
      .select("id")
      .single();
    rawWriteoff = result.data as Pick<Writeoff, "id"> | null;
    wErr = result.error;
  }

  const writeoff = rawWriteoff;
  if (wErr || !writeoff)
    throw new Error(`Ошибка при создании записи: ${wErr?.message}`);

  // ── Insert photo row (RLS: writeoff belongs to submitter) ────────────────────
  // created_at defaults to now() — server receive-time acts as spoofing guard
  // (the forensics pipeline compares it against captured_at).
  const photoRow: WriteoffPhotoInsert = {
    writeoff_id: writeoff.id,
    storage_path: d.storagePath,
    gps_lat: d.gpsLat,
    gps_lng: d.gpsLng,
    captured_at: d.capturedAt,
    source: "camera",
  };
  const { data: photoData, error: photoErr } = await supabase
    .from("writeoff_photos")
    .insert(photoRow as unknown as never)
    .select("id")
    .single();
  const photoId = (photoData as { id: string } | null)?.id ?? null;

  if (photoErr) {
    // Photo row failed — writeoff is already committed. Log and continue.
    console.error("[submit-writeoff] photo insert failed:", photoErr.message);
  }

  // ── Audit log (service role — no user INSERT policy by design) ───────────────
  // Hash-chained via the centralized audit module (Prompt 13): this row links
  // to the global chain head by prev_hash, so the submission is bound into the
  // tamper-evident trail alongside every later transition.
  const batchBurst = d.batchBurst === true;
  const logPayload: Record<string, unknown> = {
    qty: d.qty,
    unit: d.unit,
    reason_code_id: d.reasonCodeId,
    withholding: d.withholding,
    batch_burst: batchBurst,
    ...(d.withholding && d.chargedEmployeeId
      ? { charged_employee_id: d.chargedEmployeeId }
      : {}),
  };

  const serviceClient = createServiceClient();
  try {
    await appendAuditEntry(serviceClient, {
      writeoffId: writeoff.id,
      actorId: user.id,
      action: "submitted",
      payload: logPayload,
    });
  } catch (err) {
    // The writeoff + photo are already committed; a failed audit must not roll
    // them back, but it IS the integrity record — log loudly.
    console.error(
      "[submit-writeoff] audit insert failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── Anti-batch signal for the risk engine (Prompt 10) ───────────────────────
  // Tagged by the offline queue when a submission was flushed in an end-of-shift
  // burst. We never block submit on this — it only creates a risk_event the
  // risk engine can aggregate. Service role because risk_events INSERT is
  // restricted to reviewer/admin.
  if (batchBurst) {
    const riskEntry: RiskEventInsert = {
      writeoff_id: writeoff.id,
      feature: "batch_burst",
      weight: 0.4,
      detail: {
        source: "offline_queue",
        submitted_at: new Date().toISOString(),
      },
    };
    try {
      await serviceClient.from("risk_events").insert(riskEntry);
    } catch (err) {
      // Non-fatal: the audit log already carries the batch_burst flag, so a
      // risk_event insert failure must not roll back the writeoff.
      console.error("[submit-writeoff] risk_event insert failed:", err);
    }
  }

  // ── Photo forensics + risk/routing (Prompts 8–11) — deferred via after() ───
  // Forensics (pHash + vision verify) and the risk recompute/router can take
  // 10–30s (sharp + OpenAI + corpus scan). Running them inline blocked the
  // server-action response and, on a DB schema mismatch or timeout, corrupted
  // the RSC stream with cryptic client errors (frame.join / enqueueModel).
  // The writeoff + photo + audit log are already committed; schedule the
  // enrichment pass to run AFTER the action returns so the client gets an
  // immediate optimistic success. Sequential inside after(): forensics first
  // (emits risk_events), then recomputeAndRoute (scores + routes).
  if (photoId) {
    const bgWriteoffId = writeoff.id;
    const bgPhotoId = photoId;
    after(async () => {
      try {
        await runPhotoForensics(bgPhotoId);
      } catch (err) {
        console.error("[submit-writeoff] forensics pipeline failed:", err);
      }
      try {
        await recomputeAndRoute(bgWriteoffId);
      } catch (err) {
        console.error("[submit-writeoff] risk/routing failed:", err);
      }
    });
  }

  return {
    id: writeoff.id,
    qty: d.qty,
    unit: d.unit,
    locationName: location?.name ?? null,
  };
}
