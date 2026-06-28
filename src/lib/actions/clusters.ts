"use server";

/**
 * Cluster admin server actions (Prompt B).
 *
 * An admin assembles the org from the /admin/clusters screen: create a cluster,
 * move a store between clusters (or unassign it), and assign reviewers to a
 * cluster (the unit of review ownership — a reviewer owns a CLUSTER, not a
 * store, so an area manager's scope is a sane slice, never a whole city).
 *
 * Same guard pattern as users.ts: re-check the caller's role via the user-bound
 * client, then write via the service role (RLS restricts these writes to
 * admins, but the service client is the consistent writer for admin tooling).
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// ── Validation ───────────────────────────────────────────────────────────────

const CreateClusterSchema = z.object({
  name: z.string().trim().min(1, "Укажите название").max(120),
  cityId: z.string().uuid().nullable().optional(),
});

const MoveStoreSchema = z.object({
  storeId: z.string().uuid(),
  clusterId: z.string().uuid().nullable(), // null → unassign
});

const SetClusterReviewersSchema = z.object({
  clusterId: z.string().uuid(),
  reviewerIds: z.array(z.string().uuid()),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

// ── Guard ─────────────────────────────────────────────────────────────────────

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Не авторизован");
  const { data: rawProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (rawProfile as { role: string } | null)?.role;
  if (role !== "admin") throw new Error("Недостаточно прав");
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** Create a new cluster within a city. */
export async function createCluster(
  input: z.infer<typeof CreateClusterSchema>,
): Promise<ActionResult> {
  const parsed = CreateClusterSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  await requireAdmin();
  const service = createServiceClient();
  const { error } = await service
    .from("store_clusters")
    .insert({ name: parsed.data.name, city_id: parsed.data.cityId ?? null });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Move a store to a cluster (or unassign it when clusterId is null). */
export async function moveStore(
  input: z.infer<typeof MoveStoreSchema>,
): Promise<ActionResult> {
  const parsed = MoveStoreSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  await requireAdmin();
  const service = createServiceClient();
  const { error } = await service
    .from("stores")
    .update({ cluster_id: parsed.data.clusterId })
    .eq("id", parsed.data.storeId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Replace a cluster's reviewer roster (the reviewers who own this cluster). */
export async function setClusterReviewers(
  input: z.infer<typeof SetClusterReviewersSchema>,
): Promise<ActionResult> {
  const parsed = SetClusterReviewersSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  await requireAdmin();
  const service = createServiceClient();
  const { error: delErr } = await service
    .from("reviewer_clusters")
    .delete()
    .eq("cluster_id", parsed.data.clusterId);
  if (delErr) return { ok: false, error: delErr.message };
  if (parsed.data.reviewerIds.length > 0) {
    const { error: insErr } = await service
      .from("reviewer_clusters")
      .insert(
        parsed.data.reviewerIds.map((reviewer_id) => ({
          reviewer_id,
          cluster_id: parsed.data.clusterId,
        })),
      );
    if (insErr) return { ok: false, error: insErr.message };
  }
  return { ok: true };
}
