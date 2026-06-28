"use client";

/**
 * UsersManager — admin "Пользователи" screen (Prompt B).
 *
 * IT enrolls staff into the base: create a user (with password) or invite them
 * (they set their own password), set full_name + role, and ASSIGN a store
 * (employee) or clusters (reviewer) — never self-selected. Existing users are
 * listed with their branch / clusters and can be reassigned inline.
 *
 * On-system: shadcn Table + Select, hairline rows, IconChip per role, Nunito
 * sentence-case labels, no emoji, no word-pills. Joy layer is OFF here.
 */

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X, Loader2, Check } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createUser,
  inviteUser,
  updateUser,
  setReviewerClusters,
  type CreateUserInput,
  type InviteUserInput,
} from "@/lib/actions/users";
import type { UserRole } from "@/lib/db/types";

// ── Types (shared with the server page) ───────────────────────────────────────

export interface UserRow {
  id: string;
  email: string | null;
  full_name: string;
  role: UserRole;
  location_id: string | null;
  store: { id: string; display_name: string | null; city: string | null } | null;
  cluster_ids: string[];
}

export interface StoreOption {
  id: string;
  display_name: string | null;
  city: string | null;
}

export interface ClusterOption {
  id: string;
  name: string;
  city_name: string | null;
}

export interface UsersManagerProps {
  users: UserRow[];
  stores: StoreOption[];
  clusters: ClusterOption[];
}

// ── Role chip palette (slate / blue / green — no red, no emoji) ────────────────

const ROLE_CHIP: Record<UserRole, { bg: string; ink: string; label: string }> = {
  employee: { bg: "var(--surface-2)", ink: "var(--fg-muted)", label: "Сотрудник" },
  reviewer: { bg: "var(--risk-info-soft)", ink: "var(--risk-info-ink)", label: "Проверяющий" },
  admin: { bg: "var(--brand-soft)", ink: "var(--brand-strong)", label: "Администратор" },
};

const ROLE_VALUES: UserRole[] = ["employee", "reviewer", "admin"];

// ── Component ─────────────────────────────────────────────────────────────────

export function UsersManager({ users, stores, clusters }: UsersManagerProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: "error" | "success"; msg: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function flash(kind: "error" | "success", msg: string) {
    setToast({ kind, msg });
  }

  function refresh() {
    router.refresh();
  }

  return (
    <div className="fade-up">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-extrabold" style={{ color: "var(--fg)" }}>
            Пользователи
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--fg-muted)" }}>
            {users.length} записей
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen((v) => !v)}
          className="btn-primary"
          style={{ paddingLeft: "0.875rem", paddingRight: "0.875rem" }}
        >
          <UserPlus size={16} strokeWidth={2.5} />
          {createOpen ? "Закрыть" : "Добавить"}
        </button>
      </div>

      {createOpen && (
        <CreateUserForm
          stores={stores}
          clusters={clusters}
          onDone={(ok, msg) => {
            flash(ok ? "success" : "error", msg);
            if (ok) {
              setCreateOpen(false);
              refresh();
            }
          }}
        />
      )}

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: "var(--surface)",
          boxShadow: "var(--shadow-card)",
          border: "1px solid var(--border)",
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <Th>Сотрудник</Th>
                <Th>Роль</Th>
                <Th>Филиал / кластеры</Th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <td
                    colSpan={3}
                    className="px-4 py-10 text-center text-sm"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    Пользователей пока нет. Нажмите «Добавить».
                  </td>
                </tr>
              )}
              {users.map((u) => (
                <UserRowView
                  key={u.id}
                  user={u}
                  stores={stores}
                  clusters={clusters}
                  onFlash={flash}
                  onSaved={refresh}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

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

// ── Create / invite form ──────────────────────────────────────────────────────

function CreateUserForm({
  stores,
  clusters,
  onDone,
}: {
  stores: StoreOption[];
  clusters: ClusterOption[];
  onDone: (ok: boolean, msg: string) => void;
}) {
  const [mode, setMode] = useState<"create" | "invite">("create");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("employee");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [clusterIds, setClusterIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const storeGroups = groupByCity(stores);

  function toggleCluster(id: string) {
    setClusterIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }

  async function submit() {
    if (!email.trim() || !fullName.trim()) {
      onDone(false, "Заполните email и ФИО");
      return;
    }
    if (mode === "create" && password.trim().length < 6) {
      onDone(false, "Пароль — минимум 6 символов");
      return;
    }
    setBusy(true);
    const base = { email: email.trim(), fullName: fullName.trim(), role, locationId, clusterIds };
    const res =
      mode === "create"
        ? await createUser({ ...base, password: password.trim() } as CreateUserInput)
        : await inviteUser(base as InviteUserInput);
    setBusy(false);
    onDone(res.ok, res.ok ? "Пользователь добавлен" : res.error);
  }

  return (
    <div
      className="rounded-2xl p-5 mb-5"
      style={{
        background: "var(--surface)",
        boxShadow: "var(--shadow-card)",
        border: "1px solid var(--border)",
      }}
    >
      {/* Mode toggle */}
      <div
        className="flex rounded-xl p-1 gap-1 mb-4"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      >
        {(["create", "invite"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              padding: "0.5rem 0.75rem",
              borderRadius: "10px",
              fontWeight: 700,
              fontSize: "0.8125rem",
              background: mode === m ? "var(--brand)" : "transparent",
              color: mode === m ? "#fff" : "var(--fg-muted)",
              border: "none",
              cursor: "pointer",
            }}
          >
            {m === "create" ? "С паролем" : "По приглашению"}
          </button>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Email">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@bahandi.kz"
          />
        </Field>
        <Field label="ФИО">
          <input
            className="input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Иванов Иван"
          />
        </Field>
        {mode === "create" && (
          <Field label="Пароль">
            <input
              className="input"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="минимум 6 символов"
            />
          </Field>
        )}
        <Field label="Роль">
          <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_VALUES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_CHIP[r].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {role === "employee" && (
          <Field label="Филиал" full>
            <Select
              value={locationId ?? "__none__"}
              onValueChange={(v) => setLocationId(v === "__none__" ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="— не назначен —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— не назначен —</SelectItem>
                {storeGroups.map(({ city, items }) => (
                  <SelectGroup key={city}>
                    <SelectLabel>{city}</SelectLabel>
                    {items.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.display_name ?? s.id}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        {role === "reviewer" && (
          <Field label="Кластеры" full>
            <ClusterPicker
              clusters={clusters}
              selected={clusterIds}
              onToggle={toggleCluster}
            />
          </Field>
        )}
      </div>

      <div className="flex justify-end mt-4">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="btn-primary"
          style={{ paddingLeft: "1rem", paddingRight: "1rem" }}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} strokeWidth={2.5} />}
          {mode === "create" ? "Создать" : "Пригласить"}
        </button>
      </div>
    </div>
  );
}

// ── User row (inline role + branch + cluster assignment) ──────────────────────

function UserRowView({
  user,
  stores,
  clusters,
  onFlash,
  onSaved,
}: {
  user: UserRow;
  stores: StoreOption[];
  clusters: ClusterOption[];
  onFlash: (kind: "error" | "success", msg: string) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const storeGroups = groupByCity(stores);

  async function changeRole(next: UserRole) {
    if (next === user.role) return;
    setBusy(true);
    const res = await updateUser({ id: user.id, role: next });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Роль обновлена" : res.error);
    if (res.ok) onSaved();
  }

  async function changeStore(locId: string | null) {
    if (locId === user.location_id) return;
    setBusy(true);
    const res = await updateUser({ id: user.id, role: "employee", locationId: locId });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Филиал обновлён" : res.error);
    if (res.ok) onSaved();
  }

  async function addCluster(clusterId: string) {
    if (user.cluster_ids.includes(clusterId)) return;
    setBusy(true);
    const res = await setReviewerClusters({
      reviewerId: user.id,
      clusterIds: [...user.cluster_ids, clusterId],
    });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Кластер добавлен" : res.error);
    if (res.ok) onSaved();
  }

  async function removeCluster(clusterId: string) {
    setBusy(true);
    const res = await setReviewerClusters({
      reviewerId: user.id,
      clusterIds: user.cluster_ids.filter((c) => c !== clusterId),
    });
    setBusy(false);
    onFlash(res.ok ? "success" : "error", res.ok ? "Кластер удалён" : res.error);
    if (res.ok) onSaved();
  }

  const chip = ROLE_CHIP[user.role];
  const availableClusters = clusters.filter((c) => !user.cluster_ids.includes(c.id));

  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      {/* Сотрудник */}
      <td className="px-4 py-3 align-middle">
        <p className="text-sm font-semibold truncate" style={{ color: "var(--fg)" }}>
          {user.full_name}
        </p>
        <p className="text-xs truncate" style={{ color: "var(--fg-muted)" }}>
          {user.email ?? "—"}
        </p>
      </td>

      {/* Роль */}
      <td className="px-4 py-3 align-middle">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold"
            style={{ background: chip.bg, color: chip.ink }}
          >
            {chip.label}
          </span>
          {busy && <Loader2 size={13} className="animate-spin" style={{ color: "var(--fg-muted)" }} />}
        </div>
        <div className="mt-1.5" style={{ maxWidth: 160 }}>
          <Select value={user.role} onValueChange={(v) => changeRole(v as UserRole)}>
            <SelectTrigger style={{ minHeight: 34, fontSize: "0.8125rem" }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_VALUES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_CHIP[r].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </td>

      {/* Филиал / кластеры */}
      <td className="px-4 py-3 align-middle">
        {user.role === "employee" ? (
          <div style={{ maxWidth: 240 }}>
            <Select
              value={user.location_id ?? "__none__"}
              onValueChange={(v) => changeStore(v === "__none__" ? null : v)}
            >
              <SelectTrigger style={{ minHeight: 34, fontSize: "0.8125rem" }}>
                <SelectValue placeholder="— не назначен —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— не назначен —</SelectItem>
                {storeGroups.map(({ city, items }) => (
                  <SelectGroup key={city}>
                    <SelectLabel>{city}</SelectLabel>
                    {items.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.display_name ?? s.id}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {user.store && (
              <p className="text-xs mt-1" style={{ color: "var(--fg-faint)" }}>
                {user.store.city ? `${user.store.city} — ` : ""}
                {user.store.display_name ?? user.store.id}
              </p>
            )}
          </div>
        ) : user.role === "reviewer" ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {user.cluster_ids.length === 0 && (
                <span className="text-xs" style={{ color: "var(--fg-faint)" }}>
                  Кластеры не назначены
                </span>
              )}
              {user.cluster_ids.map((cid) => {
                const c = clusters.find((x) => x.id === cid);
                return (
                  <span
                    key={cid}
                    className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1 py-1 text-xs font-semibold"
                    style={{ background: "var(--risk-info-soft)", color: "var(--risk-info-ink)" }}
                  >
                    {c?.name ?? cid.slice(0, 8)}
                    <button
                      type="button"
                      title="Убрать кластер"
                      onClick={() => removeCluster(cid)}
                      className="inline-flex items-center justify-center rounded-full"
                      style={{ width: 16, height: 16 }}
                    >
                      <X size={11} strokeWidth={2.5} />
                    </button>
                  </span>
                );
              })}
            </div>
            {availableClusters.length > 0 && (
              <div style={{ maxWidth: 240 }}>
                <Select value="__add__" onValueChange={(v) => v !== "__add__" && addCluster(v)}>
                  <SelectTrigger style={{ minHeight: 32, fontSize: "0.8125rem" }}>
                    <SelectValue placeholder="добавить кластер" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__add__" disabled>
                      добавить кластер
                    </SelectItem>
                    {availableClusters.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs" style={{ color: "var(--fg-faint)" }}>
            Полный доступ
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Cluster picker (create form) ──────────────────────────────────────────────

function ClusterPicker({
  clusters,
  selected,
  onToggle,
}: {
  clusters: ClusterOption[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (clusters.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--fg-faint)" }}>
        Кластеров пока нет — создайте их на экране «Кластеры».
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {clusters.map((c) => {
        const on = selected.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onToggle(c.id)}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors"
            style={{
              background: on ? "var(--risk-info)" : "var(--surface-2)",
              color: on ? "#fff" : "var(--fg-muted)",
              border: "1px solid var(--border)",
            }}
          >
            {on && <Check size={11} strokeWidth={2.5} />}
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "sm:col-span-2" : undefined}>
      <p className="eyebrow mb-1.5" style={{ color: "var(--fg-muted)" }}>
        {label}
      </p>
      {children}
    </div>
  );
}

function Th({
  children,
  style,
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...rest}
      className="eyebrow px-4 py-3 text-left font-semibold"
      style={{ color: "var(--fg-muted)", ...style }}
    >
      {children}
    </th>
  );
}

function groupByCity(stores: StoreOption[]): Array<{ city: string; items: StoreOption[] }> {
  const map = new Map<string, StoreOption[]>();
  for (const s of stores) {
    const key = s.city || "—";
    const arr = map.get(key) ?? [];
    arr.push(s);
    map.set(key, arr);
  }
  return Array.from(map.entries()).map(([city, items]) => ({ city, items }));
}
