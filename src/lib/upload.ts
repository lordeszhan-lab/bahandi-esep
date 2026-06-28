import { createClient } from "@/lib/supabase/client";

export const PHOTOS_BUCKET = "writeoff-photos";

export interface PhotoUpload {
  storagePath: string;
}

/**
 * Uploads a JPEG blob to the private `writeoff-photos` bucket.
 * Path format: {userId}/{epoch}.jpg — the per-user folder is organizational
 * only; the storage.objects INSERT policy (0009_storage_rls.sql) admits any
 * authenticated user to the bucket and does NOT enforce an auth.uid() prefix,
 * so the path written here always satisfies the policy.
 *
 * Called client-side only — uses the authenticated browser session. A failed
 * upload is non-fatal: the caller (offline flush) keeps the submission in the
 * IndexedDB queue and retries with backoff, so the write-off is never silently
 * dropped on a photo failure.
 */
export async function uploadPhoto(
  blob: Blob,
  userId: string,
): Promise<PhotoUpload> {
  const supabase = createClient();
  const path = `${userId}/${Date.now()}.jpg`;

  const { data, error } = await supabase.storage
    .from(PHOTOS_BUCKET)
    .upload(path, blob, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) {
    // Log the exact bucket + path + raw message so RLS / storage
    // misconfigurations are traceable in the devtool console without leaking
    // the raw Postgres string to the employee-facing UI.
    console.error("[upload] photo upload failed", {
      bucket: PHOTOS_BUCKET,
      path,
      message: error.message,
    });

    // Translate the opaque RLS message into something actionable for the
    // employee. The flush layer stores this as `lastError` and surfaces it
    // under the "Filed" confirmation; the queue keeps the row for retry.
    const isRls = /row-level security|policy/i.test(error.message);
    const friendly = isRls
      ? "Нет прав на загрузку фото — повторим при подключении."
      : "Не удалось загрузить фото. Проверьте связь и попробуйте снова.";
    throw new Error(friendly);
  }
  return { storagePath: data.path };
}
