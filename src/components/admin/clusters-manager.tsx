"use client";

/**
 * ClustersManager — admin "Кластеры" screen (Prompt B).
 *
 * The org is City → Cluster → Store, with reviewers owning clusters. Here an
 * admin assembles it: create a cluster, move stores between clusters (or leave
 * one unassigned), and assign reviewers to a cluster. The unit of review
 * ownership is the CLUSTER — so for Almaty (48 stores split into 3 clusters of
 * ~16) no single area manager owns the whole city.
 *
 * On-system: hairline rows, IconChip per city, soft shadows, Nunito, no emoji,
 * no word-pills. Joy layer is OFF.
 */

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Plus, X, Loader2, Check, Network } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
} from "@/components/ui/select";
import {
  createCluster,
  moveStore,
  setClusterReviewers,
} from "@/lib/actions/clusters";

// ── Types (shared with the server page) ───────────────────────────────────────

export interface ClusterStore {
  id: string;
  display_name: string | null;
  city: string | null;
  format: string | null;
  cluster_id: string | null;
}

export interface ClusterRow {
  id: string;
  name: string;
  city_id: string | null;
  city_name: string | null;
  store_ids: string[];
  reviewer_ids: string[];
}

export interface ReviewerOption {
  id: string;
  full_name: string;
}

export interface CityOption {
  id: string;
  name: string;
}

export interface ClustersManagerProps {
  clusters: ClusterRow[];
  stores: ClusterStore[];
  reviewers: ReviewerOption[];
  cities: CityOption[];
}

const NONE = "__none__";

// ── Component ─────────────────────────────────────────────────────────────────

export function ClustersManager({
  clusters,
  stores,
  reviewers,
  cities,
}: ClustersManagerProps) {
  const router = useRouter();
  const [toast, setToast] = useState<{ kind: "error" | "success"; msg: string } | null>(null);
  const [name, setName] = useState("");
  const [cityId, setCityId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function flash(kind: "error" | "success", msg: string) {
    setToast({ kind, msg });
  }

  async function submitCreate() {
    if (!name.trim()) {
      flash("error", "Укажите название кластера");
      return;
    }
    setCreating(true);
    const res = await createCluster({ name: name.trim(), cityId });
    setCreating(false);
    flash(res.ok ? "success" : "error", res.ok ? "Кластер создан" : res.error);
    if (res.ok) {
      setName("");
      router.refresh();
    }
  }

  // Group clusters by city for display.
  const grouped = new Map<string, ClusterRow[]>();
  for (const c of clusters) {
    const key = c.city_name ?? "Без города";
    const arr = grouped.get(key) ?? [];
    arr.push(c);
    grouped.set(key, arr);
  }
  const unassigned = stores.filter((s) => !s.cluster_id);

  return (
    <div className="fade-up space-y-6">
      {/* ── Create cluster ─────────────────────────────────────────────────── */}
      <div
        className="rounded-2xl p-5"
        style={{
          background: "var(--surface)",
          boxShadow: "var(--shadow-card)",
          border: "1px solid var(--border)",
        }}
      >
        <p className="eyebrow mb-3" style={{ color: "var(--fg-muted)" }}>
          Новый кластер
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            className="input flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Напр. Алматы — кластер 4"
          />
          <div style={{ minWidth: 220 }}>
            <Select
              value={cityId ?? NONE}
              onValueChange={(v) => setCityId(v === NONE ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="— город —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— без города —</SelectItem>
                {cities.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <button
            type="button"
            onClick={submitCreate}
            disabled={creating}
            className="btn-primary"
            style={{ paddingLeft: "1rem", paddingRight: "1rem" }}
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} strokeWidth={2.5} />}
            Создать
          </button>
        </div>
      </div>

      {/* ── Clusters grouped by city ───────────────────────────────────────── */}
      {clusters.length === 0 && (
        <div
          className="rounded-2xl p-8 text-center text-sm"
          style={{
            background: "var(--surface)",
            boxShadow: "var(--shadow-card)",
            border: "1px solid var(--border)",
            color: "var(--fg-muted)",
          }}
        >
          Кластеров пока нет. Создайте первый — например «Алматы — кластер 1».
        </div>
      )}

      {Array.from(grouped.entries()).map(([city, items]) => (
        <div key={city}>
          <div className="flex items-center gap-2 mb-3">
            <span
              className="inline-flex items-center justify-center rounded-xl"
              style={{
                width: 28,
                height: 28,
                background: "var(--brand-soft)",
                color: "var(--brand-strong)",
              }}
            >
              <MapPin size={16} strokeWidth={1.9} />
            </span>
            <h2 className="text-sm font-extrabold" style={{ color: "var(--fg)" }}>
              {city}
            </h2>
            <span className="text-xs" style={{ color: "var(--fg-faint)" }}>
              · {items.length} кл.
            </span>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            {items.map((c) => (
              <ClusterCard
                key={c.id}
                cluster={c}
                allClusters={clusters}
                stores={stores.filter((s) => s.cluster_id === c.id)}
                reviewers={reviewers}
                onFlash={flash}
                onSaved={() => router.refresh()}
              />
            ))}
          </div>
        </div>
      ))}

      {/* ── Unassigned stores ──────────────────────────────────────────────── */}
      {unassigned.length > 0 && (
        <UnassignedSection
          stores={unassigned}
          clusters={clusters}
          onFlash={flash}
          onSaved={() => router.refresh()}
        />
      )}

      {toast && (
        <div
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 rounded-full px-4 py-2.5 text-sm font-semibold shadow-card-hover"
          style={{
            background: toast.kind === "error" ? "var(--risk-fraud)" : "var(--brand)",
            color: "#fff",
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Cluster card ──────────────────────────────────────────────────────────────

function ClusterCard({
  cluster,
  allClusters,
  stores,
  reviewers,
  onFlash,
  onSaved,
}: {
  cluster: ClusterRow;
  allClusters: ClusterRow[];
  stores: ClusterStore[];
  reviewers: ReviewerOption[];
  onFlash: (kind: "error" | "success", msg: string) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function move(storeId: string, targetClusterId: string | null) {
    setBusy(true);
    const res = await moveStore({ storeId, clusterId: targetClusterId });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Точка перемещена" : res.error);
    if (res.ok) onSaved();
  }

  async function addReviewer(reviewerId: string) {
    if (!reviewerId || cluster.reviewer_ids.includes(reviewerId)) return;
    setBusy(true);
    const res = await setClusterReviewers({
      clusterId: cluster.id,
      reviewerIds: [...cluster.reviewer_ids, reviewerId],
    });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Проверяющий добавлен" : res.error);
    if (res.ok) onSaved();
  }

  async function removeReviewer(reviewerId: string) {
    setBusy(true);
    const res = await setClusterReviewers({
      clusterId: cluster.id,
      reviewerIds: cluster.reviewer_ids.filter((r) => r !== reviewerId),
    });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Проверяющий удалён" : res.error);
    if (res.ok) onSaved();
  }

  const availableReviewers = reviewers.filter((r) => !cluster.reviewer_ids.includes(r.id));

  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: "var(--surface)",
        boxShadow: "var(--shadow-card)",
        border: "1px solid var(--border)",
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-extrabold" style={{ color: "var(--fg)" }}>
          {cluster.name}
        </h3>
        {busy && <Loader2 size={13} className="animate-spin" style={{ color: "var(--fg-muted)" }} />}
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--fg-muted)" }}>
        {stores.length} {pluralStores(stores.length)}
      </p>

      {/* Reviewers (owners) */}
      <div className="mb-3">
        <p className="eyebrow mb-1.5" style={{ color: "var(--fg-faint)" }}>
          Проверяющие
        </p>
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {cluster.reviewer_ids.length === 0 && (
            <span className="text-xs" style={{ color: "var(--fg-faint)" }}>
              не назначены
            </span>
          )}
          {cluster.reviewer_ids.map((rid) => {
            const r = reviewers.find((x) => x.id === rid);
            return (
              <span
                key={rid}
                className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1 py-1 text-xs font-semibold"
                style={{ background: "var(--risk-info-soft)", color: "var(--risk-info-ink)" }}
              >
                {r?.full_name ?? rid.slice(0, 8)}
                <button
                  type="button"
                  title="Убрать"
                  onClick={() => removeReviewer(rid)}
                  className="inline-flex items-center justify-center rounded-full"
                  style={{ width: 16, height: 16 }}
                >
                  <X size={11} strokeWidth={2.5} />
                </button>
              </span>
            );
          })}
        </div>
        {availableReviewers.length > 0 && (
          <div style={{ maxWidth: 240 }}>
            <Select value="__add__" onValueChange={(v) => v !== "__add__" && addReviewer(v)}>
              <SelectTrigger style={{ minHeight: 32, fontSize: "0.8125rem" }}>
                <SelectValue placeholder="добавить проверяющего" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__add__" disabled>
                  добавить проверяющего
                </SelectItem>
                {availableReviewers.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Stores in this cluster */}
      <div>
        <p className="eyebrow mb-1.5" style={{ color: "var(--fg-faint)" }}>
          Точки
        </p>
        <ul className="space-y-1.5">
          {stores.length === 0 && (
            <li className="text-xs" style={{ color: "var(--fg-faint)" }}>
              нет точек
            </li>
          )}
          {stores.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <span
                className="text-sm flex-1 truncate"
                style={{ color: "var(--fg)" }}
              >
                {s.display_name ?? s.id}
              </span>
              <div style={{ width: 170, flexShrink: 0 }}>
                <Select
                  value={cluster.id}
                  onValueChange={(v) => move(s.id, v === NONE ? null : v)}
                >
                  <SelectTrigger style={{ minHeight: 30, fontSize: "0.75rem" }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={cluster.id}>здесь</SelectItem>
                    <SelectItem value={NONE}>без кластера</SelectItem>
                    {allClusters
                      .filter((c) => c.id !== cluster.id)
                      .map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          → {c.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Unassigned stores ─────────────────────────────────────────────────────────

function UnassignedSection({
  stores,
  clusters,
  onFlash,
  onSaved,
}: {
  stores: ClusterStore[];
  clusters: ClusterRow[];
  onFlash: (kind: "error" | "success", msg: string) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function assign(storeId: string, clusterId: string) {
    if (!clusterId || clusterId === NONE) return;
    setBusy(true);
    const res = await moveStore({ storeId, clusterId });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Точка назначена" : res.error);
    if (res.ok) onSaved();
  }

  if (clusters.length === 0) return null;

  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: "var(--surface)",
        boxShadow: "var(--shadow-card)",
        border: "1px solid var(--risk-watch)",
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Network size={16} strokeWidth={1.9} style={{ color: "var(--risk-watch-ink)" }} />
        <h2 className="text-sm font-extrabold" style={{ color: "var(--risk-watch-ink)" }}>
          Без кластера — {stores.length}
        </h2>
        {busy && <Loader2 size={13} className="animate-spin" style={{ color: "var(--fg-muted)" }} />}
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--fg-muted)" }}>
        Эти точки не входят ни в один кластер — назначьте проверяющего через
        кластер, чтобы они попали в зону контроля.
      </p>
      <ul className="space-y-1.5">
        {stores.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <span className="text-sm flex-1 truncate" style={{ color: "var(--fg)" }}>
              {s.city ? `${s.city} — ` : ""}
              {s.display_name ?? s.id}
            </span>
            <div style={{ width: 200, flexShrink: 0 }}>
              <Select value={NONE} onValueChange={(v) => assign(s.id, v)}>
                <SelectTrigger style={{ minHeight: 30, fontSize: "0.75rem" }}>
                  <SelectValue placeholder="назначить кластер" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE} disabled>
                    назначить кластер
                  </SelectItem>
                  {clusters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function pluralStores(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "точка";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "точки";
  return "точек";
}
