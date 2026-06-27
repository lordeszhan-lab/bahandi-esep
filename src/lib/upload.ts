import { createClient } from "@/lib/supabase/client";

export interface PhotoUpload {
  storagePath: string;
}

/**
 * Uploads a JPEG blob to the writeoff-photos bucket.
 * Path format: {userId}/{epoch}.jpg
 * Called client-side only — uses the authenticated browser session.
 */
export async function uploadPhoto(
  blob: Blob,
  userId: string,
): Promise<PhotoUpload> {
  const supabase = createClient();
  const path = `${userId}/${Date.now()}.jpg`;

  const { data, error } = await supabase.storage
    .from("writeoff-photos")
    .upload(path, blob, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) throw new Error(`Ошибка загрузки фото: ${error.message}`);
  return { storagePath: data.path };
}
