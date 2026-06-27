"use server";

import { createHash } from "crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type {
  Profile,
  Location,
  Writeoff,
  WriteoffInsert,
  WriteoffPhotoInsert,
  AuditLogInsert,
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
    .select("location_id")
    .eq("id", user.id)
    .single();
  const profile = rawProfile as Pick<Profile, "location_id"> | null;
  if (!profile?.location_id) throw new Error("Нет привязки к точке");

  // ── Fetch location name for success screen ───────────────────────────────────
  const { data: rawLocation } = await supabase
    .from("locations")
    .select("name")
    .eq("id", profile.location_id)
    .single();
  const location = rawLocation as Pick<Location, "name"> | null;

  // ── Insert writeoff (RLS: submitter_id = auth.uid(), location enforced) ───────
  // WriteoffInsert satisfies validates shape; `as unknown as never` is the
  // accepted workaround when __InternalSupabase collapses insert types to never.
  const writeoffRow: WriteoffInsert = {
    location_id: profile.location_id,
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
  const { data: rawWriteoff, error: wErr } = await supabase
    .from("writeoffs")
    .insert(writeoffRow as unknown as never)
    .select("id")
    .single();

  const writeoff = rawWriteoff as Pick<Writeoff, "id"> | null;
  if (wErr || !writeoff)
    throw new Error(`Ошибка при создании записи: ${wErr?.message}`);

  // ── Insert photo row (RLS: writeoff belongs to submitter) ────────────────────
  // created_at defaults to now() — server receive-time acts as spoofing guard
  const photoRow: WriteoffPhotoInsert = {
    writeoff_id: writeoff.id,
    storage_path: d.storagePath,
    gps_lat: d.gpsLat,
    gps_lng: d.gpsLng,
    captured_at: d.capturedAt,
    source: "camera",
  };
  const { error: photoErr } = await supabase
    .from("writeoff_photos")
    .insert(photoRow as unknown as never);

  if (photoErr) {
    // Photo row failed — writeoff is already committed. Log and continue.
    console.error("[submit-writeoff] photo insert failed:", photoErr.message);
  }

  // ── Audit log (service role — no user INSERT policy by design) ───────────────
  const logPayload = {
    writeoff_id: writeoff.id,
    actor_id: user.id,
    qty: d.qty,
    unit: d.unit,
    reason_code_id: d.reasonCodeId,
    withholding: d.withholding,
    ...(d.withholding && d.chargedEmployeeId
      ? { charged_employee_id: d.chargedEmployeeId }
      : {}),
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(logPayload))
    .digest("hex");

  const serviceClient = createServiceClient();
  const auditEntry: AuditLogInsert = {
    writeoff_id: writeoff.id,
    actor_id: user.id,
    action: "submitted",
    hash,
    payload: logPayload,
  };
  await serviceClient.from("audit_log").insert(auditEntry);

  return {
    id: writeoff.id,
    qty: d.qty,
    unit: d.unit,
    locationName: location?.name ?? null,
  };
}
