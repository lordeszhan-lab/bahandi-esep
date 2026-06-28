"use server";

/**
 * Employee onboarding server actions (Prompt B).
 *
 * This is "IT enrolls you into the base": an admin creates/invites a user with
 * the service-role admin API (auth.admin.createUser / inviteUserByEmail), sets
 * full_name + role, and ASSIGNS a store (employee) or clusters (reviewer). The
 * user never self-selects a location — it's attached here, before first login.
 *
 * Every action re-checks the caller's role via the user-bound client (the proxy
 * already gates /admin/* to admins, but defense-in-depth), then uses the service
 * client for the admin API + profile/cluster writes. RLS would block a user-bound
 * client from writing another user's profile, so assignments are service-role.
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { UserRole } from "@/lib/db/types";

// ── Validation ───────────────────────────────────────────────────────────────

const RoleSchema = z.enum(["employee", "reviewer", "admin"]);

const CreateUserSchema = z.object({
  email: z.string().trim().email("Некорректный email"),
  password: z.string().trim().min(6, "Пароль — минимум 6 символов"),
  fullName: z.string().trim().min(1, "Укажите ФИО").max(120),
  role: RoleSchema,
  locationId: z.string().uuid().nullable().optional(),
  clusterIds: z.array(z.string().uuid()).optional(),
});

const InviteUserSchema = z.object({
  email: z.string().trim().email("Некорректный email"),
  fullName: z.string().trim().min(1, "Укажите ФИО").max(120),
  role: RoleSchema,
  locationId: z.string().uuid().nullable().optional(),
  clusterIds: z.array(z.string().uuid()).optional(),
});

const UpdateUserSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().trim().min(1).max(120).optional(),
  role: RoleSchema.optional(),
  locationId: z.string().uuid().nullable().optional(),
});

const SetClustersSchema = z.object({
  reviewerId: z.string().uuid(),
  clusterIds: z.array(z.string().uuid()),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type InviteUserInput = z.infer<typeof InviteUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

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
  return user.id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Upsert the profile row + (for reviewers) their cluster assignments. */
async function writeProfileAndClusters(
  service: ReturnType<typeof createServiceClient>,
  args: {
    id: string;
    fullName: string;
    role: UserRole;
    locationId: string | null;
    clusterIds?: string[];
  },
): Promise<ActionResult> {
  const { error: profileErr } = await service
    .from("profiles")
    .upsert(
      {
        id: args.id,
        full_name: args.fullName,
        role: args.role,
        location_id: args.role === "employee" ? args.locationId : null,
      },
      { onConflict: "id" },
    );
  if (profileErr) return { ok: false, error: profileErr.message };

  // Reviewers own clusters (not a single store). Replace their assignments.
  if (args.role === "reviewer") {
    const clusterIds = args.clusterIds ?? [];
    const { error: delErr } = await service
      .from("reviewer_clusters")
      .delete()
      .eq("reviewer_id", args.id);
    if (delErr) return { ok: false, error: delErr.message };
    if (clusterIds.length > 0) {
      const { error: insErr } = await service
        .from("reviewer_clusters")
        .insert(clusterIds.map((cluster_id) => ({ reviewer_id: args.id, cluster_id })));
      if (insErr) return { ok: false, error: insErr.message };
    }
  } else {
    // Non-reviewers must not keep stale cluster assignments.
    const { error: delErr } = await service
      .from("reviewer_clusters")
      .delete()
      .eq("reviewer_id", args.id);
    if (delErr) return { ok: false, error: delErr.message };
  }

  return { ok: true };
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** Create a user with a password (email confirmed) + attach role/branch. */
export async function createUser(input: CreateUserInput): Promise<ActionResult> {
  const parsed = CreateUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  const d = parsed.data;
  await requireAdmin();

  const service = createServiceClient();
  const { data, error } = await service.auth.admin.createUser({
    email: d.email,
    password: d.password,
    email_confirm: true,
    user_metadata: { full_name: d.fullName, role: d.role },
  });
  if (error) return { ok: false, error: error.message };
  return writeProfileAndClusters(service, {
    id: data.user.id,
    fullName: d.fullName,
    role: d.role,
    locationId: d.locationId ?? null,
    clusterIds: d.clusterIds,
  });
}

/** Invite a user by email — they set their own password; role/branch are pre-attached. */
export async function inviteUser(input: InviteUserInput): Promise<ActionResult> {
  const parsed = InviteUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  const d = parsed.data;
  await requireAdmin();

  const service = createServiceClient();
  const { data, error } = await service.auth.admin.inviteUserByEmail(d.email, {
    data: { full_name: d.fullName, role: d.role },
  });
  if (error) return { ok: false, error: error.message };
  return writeProfileAndClusters(service, {
    id: data.user.id,
    fullName: d.fullName,
    role: d.role,
    locationId: d.locationId ?? null,
    clusterIds: d.clusterIds,
  });
}

/** Update an existing user's full_name / role / assigned branch. */
export async function updateUser(input: UpdateUserInput): Promise<ActionResult> {
  const parsed = UpdateUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  const d = parsed.data;
  await requireAdmin();

  const service = createServiceClient();

  // Load the current row so partial updates merge correctly.
  const { data: cur, error: loadErr } = await service
    .from("profiles")
    .select("full_name, role, location_id")
    .eq("id", d.id)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!cur) return { ok: false, error: "Профиль не найден" };

  const cur2 = cur as { full_name: string; role: string; location_id: string | null };
  const role = (d.role ?? cur2.role) as UserRole;
  const fullName = d.fullName ?? cur2.full_name;
  // employees get a store; reviewers/admins don't carry a single store.
  const locationId =
    role === "employee" ? (d.locationId !== undefined ? d.locationId : cur2.location_id) : null;

  return writeProfileAndClusters(service, {
    id: d.id,
    fullName,
    role,
    locationId,
  });
}

/** Replace a reviewer's cluster assignments (add-only control on the users screen). */
export async function setReviewerClusters(input: z.infer<typeof SetClustersSchema>): Promise<ActionResult> {
  const parsed = SetClustersSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Некорректные данные" };
  }
  const d = parsed.data;
  await requireAdmin();

  const service = createServiceClient();
  const { error: delErr } = await service
    .from("reviewer_clusters")
    .delete()
    .eq("reviewer_id", d.reviewerId);
  if (delErr) return { ok: false, error: delErr.message };
  if (d.clusterIds.length > 0) {
    const { error: insErr } = await service
      .from("reviewer_clusters")
      .insert(d.clusterIds.map((cluster_id) => ({ reviewer_id: d.reviewerId, cluster_id })));
    if (insErr) return { ok: false, error: insErr.message };
  }
  return { ok: true };
}
