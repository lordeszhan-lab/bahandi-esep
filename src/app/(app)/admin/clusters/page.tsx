/**
 * Admin "Кластеры" screen (Prompt B) — server component.
 *
 * Lists every cluster (grouped by city on the client) with its store count,
 * its stores, and its assigned reviewers; lets an admin move stores between
 * clusters and assign reviewers. Loaded via the service role (admin sees all;
 * the proxy already gates /admin/* to admins, the role check is belt-and-braces).
 */

import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { APP_NAME } from "@/lib/brand";
import {
  ClustersManager,
  type ClusterRow,
  type ClusterStore,
  type ReviewerOption,
  type CityOption,
} from "@/components/admin/clusters-manager";
import type { Store, StoreCluster, ReviewerCluster, City, Profile } from "@/lib/db/types";

export const metadata = { title: `Кластеры · ${APP_NAME}` };

export default async function ClustersPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "admin") redirect("/admin");

  const service = createServiceClient();

  const [
    { data: rawClusters },
    { data: rawCities },
    { data: rawStores },
    { data: rawReviewerClusters },
    { data: rawReviewerProfiles },
  ] = await Promise.all([
    service.from("store_clusters").select("*").order("name"),
    service.from("cities").select("id, name").order("name"),
    service
      .from("stores")
      .select("id, display_name, city, format, cluster_id")
      .order("city")
      .order("display_name"),
    service.from("reviewer_clusters").select("reviewer_id, cluster_id"),
    service
      .from("profiles")
      .select("id, full_name, role")
      .eq("role", "reviewer")
      .order("full_name"),
  ]);

  const clusters = (rawClusters as StoreCluster[] | null) ?? [];
  const cities = (rawCities as City[] | null) ?? [];
  const stores = (rawStores as Pick<Store, "id" | "display_name" | "city" | "format" | "cluster_id">[] | null) ?? [];
  const reviewerClusters = (rawReviewerClusters as ReviewerCluster[] | null) ?? [];
  const reviewerProfiles = (rawReviewerProfiles as Pick<Profile, "id" | "full_name" | "role">[] | null) ?? [];

  const cityNameById = new Map(cities.map((c) => [c.id, c.name]));
  const reviewerIdsByCluster = new Map<string, string[]>();
  for (const rc of reviewerClusters) {
    const arr = reviewerIdsByCluster.get(rc.cluster_id) ?? [];
    arr.push(rc.reviewer_id);
    reviewerIdsByCluster.set(rc.cluster_id, arr);
  }

  const clusterRows: ClusterRow[] = clusters.map((c) => ({
    id: c.id,
    name: c.name,
    city_id: c.city_id,
    city_name: c.city_id ? (cityNameById.get(c.city_id) ?? null) : null,
    store_ids: stores.filter((s) => s.cluster_id === c.id).map((s) => s.id),
    reviewer_ids: reviewerIdsByCluster.get(c.id) ?? [],
  }));

  const clusterStoreList: ClusterStore[] = stores.map((s) => ({
    id: s.id,
    display_name: s.display_name,
    city: s.city,
    format: s.format,
    cluster_id: s.cluster_id,
  }));

  const reviewerOptions: ReviewerOption[] = reviewerProfiles.map((r) => ({
    id: r.id,
    full_name: r.full_name,
  }));

  const cityOptions: CityOption[] = cities.map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-12">
      <p className="eyebrow mb-3">Управление</p>
      <h1 className="text-2xl font-extrabold mb-1" style={{ color: "var(--fg)" }}>
        Кластеры
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--fg-muted)" }}>
        Структура «Город → Кластер → Точка». Проверяющий владеет кластером, не
        точкой, чтобы один человек не контролировал весь город (Алматы — 48 точек
        — разбит на 3 кластера).
      </p>

      <ClustersManager
        clusters={clusterRows}
        stores={clusterStoreList}
        reviewers={reviewerOptions}
        cities={cityOptions}
      />
    </div>
  );
}
