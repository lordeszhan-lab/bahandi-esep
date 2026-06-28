/**
 * Admin "Пользователи" screen (Prompt B) — server component.
 *
 * Lists every user (auth.users + profiles) with their assigned branch /
 * clusters and hands them to the interactive UsersManager. The profile table
 * is RLS-locked to self-read, so this page reads via the service role (admin
 * sees all — the proxy already gates /admin/* to admins; the role check is
 * defense-in-depth).
 */

import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { APP_NAME } from "@/lib/brand";
import {
  UsersManager,
  type UserRow,
  type StoreOption,
  type ClusterOption,
} from "@/components/admin/users-manager";
import type { Profile, Store, StoreCluster, ReviewerCluster, City } from "@/lib/db/types";

export const metadata = { title: `Пользователи · ${APP_NAME}` };

export default async function UsersPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "admin") redirect("/admin");

  const service = createServiceClient();

  // ── auth.users emails (paginated — the admin API caps perPage at 1000) ───────
  const emailById = new Map<string, string>();
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage });
    if (error) break;
    for (const u of data.users) if (u.email) emailById.set(u.id, u.email);
    if (data.users.length < perPage) break;
    page += 1;
  }

  // ── profiles + stores + clusters + cities + reviewer_clusters ───────────────
  const [
    { data: rawProfiles },
    { data: rawStores },
    { data: rawClusters },
    { data: rawCities },
    { data: rawReviewerClusters },
  ] = await Promise.all([
    service.from("profiles").select("*"),
    service.from("stores").select("id, display_name, city").order("city").order("display_name"),
    service.from("store_clusters").select("*").order("name"),
    service.from("cities").select("id, name"),
    service.from("reviewer_clusters").select("reviewer_id, cluster_id"),
  ]);

  const profiles = (rawProfiles as Profile[] | null) ?? [];
  const stores = (rawStores as Pick<Store, "id" | "display_name" | "city">[] | null) ?? [];
  const clusters = (rawClusters as StoreCluster[] | null) ?? [];
  const cities = (rawCities as City[] | null) ?? [];
  const reviewerClusters = (rawReviewerClusters as ReviewerCluster[] | null) ?? [];

  const storeById = new Map(stores.map((s) => [s.id, s]));
  const cityNameById = new Map(cities.map((c) => [c.id, c.name]));
  const clusterIdsByReviewer = new Map<string, string[]>();
  for (const rc of reviewerClusters) {
    const arr = clusterIdsByReviewer.get(rc.reviewer_id) ?? [];
    arr.push(rc.cluster_id);
    clusterIdsByReviewer.set(rc.reviewer_id, arr);
  }

  const users: UserRow[] = profiles.map((p) => {
    const store = p.location_id ? (storeById.get(p.location_id) ?? null) : null;
    return {
      id: p.id,
      email: emailById.get(p.id) ?? null,
      full_name: p.full_name,
      role: p.role as UserRow["role"],
      location_id: p.location_id,
      store: store
        ? { id: store.id, display_name: store.display_name, city: store.city }
        : null,
      cluster_ids: clusterIdsByReviewer.get(p.id) ?? [],
    };
  });

  const clusterOptions: ClusterOption[] = clusters.map((c) => ({
    id: c.id,
    name: c.name,
    city_name: c.city_id ? (cityNameById.get(c.city_id) ?? null) : null,
  }));

  const storeOptions: StoreOption[] = stores.map((s) => ({
    id: s.id,
    display_name: s.display_name,
    city: s.city,
  }));

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-12">
      <p className="eyebrow mb-3">Управление</p>
      <h1 className="text-2xl font-extrabold mb-1" style={{ color: "var(--fg)" }}>
        Пользователи
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--fg-muted)" }}>
        Зачисление сотрудников в систему. Точка назначается администратором,
        никогда не выбирается самостоятельно.
      </p>

      <UsersManager
        users={users}
        stores={storeOptions}
        clusters={clusterOptions}
      />
    </div>
  );
}
