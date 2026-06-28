"use client";

/**
 * StoreMappingTable — Iiko store GUID mapping (Prompt B).
 *
 * Handles all 87 stores in one screen instead of editing one-by-one:
 *   • unmapped banner (count) + "only unmapped" filter + text search
 *   • downloadable template pre-filled with every store's id / display_name /
 *     city so ops only pastes GUIDs
 *   • bulk CSV import (store_id, iiko_store_id, iiko_account_id) → one upsert pass
 *   • sandbox auto-fill: stamp deterministic fake GUIDs onto every unmapped
 *     store so the Iiko export pipeline demos end-to-end with no real GUIDs
 *   • inline edit of a single store's GUIDs
 *
 * On-system: hairline rows, soft surfaces, Nunito, no emoji, no word-pills.
 */

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Save,
  Upload,
  X,
} from "lucide-react";
import { parseCsv, toCsv, downloadTextFile, colIndex } from "@/lib/csv";
import {
  bulkUpsertStoreMappings,
  autoFillSandboxStoreMappings,
  saveStoreMapping,
} from "@/lib/actions/iiko-mapping";

export interface StoreMappingRow {
  id: string;
  display_name: string | null;
  city: string | null;
  iiko_store_id: string | null;
  iiko_account_id: string | null;
}

export interface StoreMappingTableProps {
  stores: StoreMappingRow[];
}

interface EditState {
  iikoStoreId: string;
  iikoAccountId: string;
}

export function StoreMappingTable({ stores }: StoreMappingTableProps) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState<null | "bulk" | "sandbox">(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; msg: string } | null>(null);
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const flash = (kind: "error" | "success", msg: string) => setToast({ kind, msg });

  const unmappedCount = stores.filter((s) => !s.iiko_store_id).length;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return stores.filter((s) => {
      if (onlyUnmapped && s.iiko_store_id) return false;
      if (!q) return true;
      return (
        (s.display_name ?? "").toLowerCase().includes(q) ||
        (s.city ?? "").toLowerCase().includes(q)
      );
    });
  }, [stores, filter, onlyUnmapped]);

  function editFor(s: StoreMappingRow): EditState {
    return (
      edits[s.id] ?? {
        iikoStoreId: s.iiko_store_id ?? "",
        iikoAccountId: s.iiko_account_id ?? "",
      }
    );
  }

  function setEdit(id: string, patch: Partial<EditState>) {
    const cur = edits[id] ?? {
      iikoStoreId: stores.find((s) => s.id === id)?.iiko_store_id ?? "",
      iikoAccountId: stores.find((s) => s.id === id)?.iiko_account_id ?? "",
    };
    setEdits((e) => ({ ...e, [id]: { ...cur, ...patch } }));
  }

  function isDirty(s: StoreMappingRow): boolean {
    const e = edits[s.id];
    if (!e) return false;
    return (
      e.iikoStoreId !== (s.iiko_store_id ?? "") ||
      e.iikoAccountId !== (s.iiko_account_id ?? "")
    );
  }

  async function saveOne(s: StoreMappingRow) {
    const e = editFor(s);
    if (!e.iikoStoreId.trim()) {
      flash("error", "Укажите iiko_store_id");
      return;
    }
    setSavingId(s.id);
    try {
      const res = await saveStoreMapping({
        storeId: s.id,
        iikoStoreId: e.iikoStoreId.trim(),
        iikoAccountId: e.iikoAccountId.trim() || null,
      });
      flash(res.ok ? "success" : "error", res.ok ? "Сохранено" : res.error);
      if (res.ok) {
        setEdits((ed) => {
          const next = { ...ed };
          delete next[s.id];
          return next;
        });
        router.refresh();
      }
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setSavingId(null);
    }
  }

  function downloadTemplate() {
    const header = ["store_id", "display_name", "city", "iiko_store_id", "iiko_account_id"];
    const rows = [header, ...stores.map((s) => [
      s.id,
      s.display_name ?? "",
      s.city ?? "",
      s.iiko_store_id ?? "",
      s.iiko_account_id ?? "",
    ])];
    downloadTextFile("iiko-store-mapping-template.csv", toCsv(rows));
  }

  async function runBulk() {
    const matrix = parseCsv(bulkText);
    if (matrix.length < 2) {
      flash("error", "Вставьте CSV с заголовком и хотя бы одной строкой");
      return;
    }
    const header = matrix[0];
    const iStore = colIndex(header, "store_id");
    const iIiko = colIndex(header, "iiko_store_id");
    const iAcc = colIndex(header, "iiko_account_id");
    if (iStore < 0 || iIiko < 0) {
      flash("error", "CSV должен содержать колонки store_id и iiko_store_id");
      return;
    }
    const rows = matrix.slice(1).map((r) => ({
      store_id: r[iStore],
      iiko_store_id: r[iIiko],
      iiko_account_id: iAcc >= 0 ? r[iAcc] : undefined,
    }));
    setBusy("bulk");
    try {
      const res = await bulkUpsertStoreMappings(rows);
      flash(
        res.ok ? "success" : "error",
        res.ok
          ? `Обновлено точек: ${res.updated}`
          : `Обновлено ${res.updated}. Ошибки: ${res.errors.slice(0, 2).join("; ")}`,
      );
      if (res.updated > 0) {
        setBulkOpen(false);
        setBulkText("");
        router.refresh();
      }
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Импорт не удался");
    } finally {
      setBusy(null);
    }
  }

  async function runSandbox() {
    setBusy("sandbox");
    try {
      const res = await autoFillSandboxStoreMappings();
      flash(
        res.ok ? "success" : "error",
        res.ok ? `Заполнено точек: ${res.filled}` : (res.error ?? "Ошибка"),
      );
      if (res.ok && res.filled > 0) router.refresh();
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Sandbox-заполнение не удалось");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fade-up space-y-4">
      {/* ── Unmapped banner (always visible so the count is observable at 0) ──── */}
      <div
        className="rounded-2xl px-4 py-3 flex items-center gap-3 flex-wrap"
        style={
          unmappedCount > 0
            ? { background: "var(--risk-watch-soft)", border: "1px solid var(--risk-watch)" }
            : { background: "var(--risk-info-soft)", border: "1px solid var(--risk-info)" }
        }
      >
        {unmappedCount > 0 ? (
          <AlertTriangle size={16} strokeWidth={1.9} style={{ color: "var(--risk-watch-ink)" }} />
        ) : (
          <Check size={16} strokeWidth={1.9} style={{ color: "var(--risk-info-ink)" }} />
        )}
        <span
          className="text-sm font-semibold"
          style={unmappedCount > 0 ? { color: "var(--risk-watch-ink)" } : { color: "var(--risk-info-ink)" }}
        >
          Не замаплено: {unmappedCount} из {stores.length}
        </span>
        {unmappedCount > 0 && (
          <>
            <label
              className="ml-auto flex items-center gap-2 text-xs"
              style={{ color: "var(--risk-watch-ink)" }}
            >
              <input
                type="checkbox"
                checked={onlyUnmapped}
                onChange={(e) => setOnlyUnmapped(e.target.checked)}
              />
              только незамапленные
            </label>
            <button
              type="button"
              onClick={runSandbox}
              disabled={busy !== null}
              className="btn-ghost"
              style={{ paddingLeft: "0.6rem", paddingRight: "0.6rem", fontSize: "0.75rem" }}
            >
              {busy === "sandbox" && <Loader2 size={13} className="animate-spin" />}
              sandbox-заполнить
            </button>
          </>
        )}
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          placeholder="Поиск по точке / городу"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" onClick={downloadTemplate} className="btn-ghost">
          <Download size={14} strokeWidth={1.9} /> Шаблон CSV
        </button>
        <button
          type="button"
          onClick={() => setBulkOpen((v) => !v)}
          className="btn-primary"
          style={{ paddingLeft: "0.85rem", paddingRight: "0.85rem" }}
        >
          <Upload size={14} strokeWidth={2} /> Массовый импорт
        </button>
      </div>

      {/* ── Bulk import panel ──────────────────────────────────────────────── */}
      {bulkOpen && (
        <div
          className="rounded-2xl p-4 space-y-3"
          style={{ background: "var(--surface)", boxShadow: "var(--shadow-card)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
              Массовый импорт GUID
            </p>
            <button type="button" onClick={() => setBulkOpen(false)} className="btn-ghost" style={{ padding: "0.25rem" }}>
              <X size={16} />
            </button>
          </div>
          <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
            Колонки: <code>store_id, iiko_store_id, iiko_account_id</code>. Скачайте шаблон,
            проставьте GUID и вставьте содержимое файла ниже.
          </p>
          <textarea
            className="input font-mono"
            rows={6}
            placeholder={"store_id,iiko_store_id,iiko_account_id\n<uuid>,<uuid>,<uuid>"}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setBulkOpen(false)} className="btn-ghost">
              Отмена
            </button>
            <button
              type="button"
              onClick={runBulk}
              disabled={busy !== null}
              className="btn-primary"
              style={{ paddingLeft: "0.85rem", paddingRight: "0.85rem" }}
            >
              {busy === "bulk" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} strokeWidth={2} />}
              Импортировать
            </button>
          </div>
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: "var(--surface)", boxShadow: "var(--shadow-card)", border: "1px solid var(--border)" }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-2)" }}>
                <Th>Точка</Th>
                <Th>iiko_store_id</Th>
                <Th>iiko_account_id</Th>
                <Th style={{ width: 80 }}></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-xs" style={{ color: "var(--fg-faint)" }}>
                    Ничего не найдено
                  </td>
                </tr>
              )}
              {filtered.map((s) => {
                const e = editFor(s);
                const dirty = isDirty(s);
                return (
                  <tr key={s.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="px-4 py-2.5">
                      <div style={{ color: "var(--fg)" }}>{s.display_name ?? s.id}</div>
                      {s.city && (
                        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
                          {s.city}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <input
                        className="input font-mono"
                        style={{ fontSize: "0.75rem", minWidth: 260 }}
                        value={e.iikoStoreId}
                        onChange={(ev) => setEdit(s.id, { iikoStoreId: ev.target.value })}
                        placeholder="— GUID —"
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <input
                        className="input font-mono"
                        style={{ fontSize: "0.75rem", minWidth: 260 }}
                        value={e.iikoAccountId}
                        onChange={(ev) => setEdit(s.id, { iikoAccountId: ev.target.value })}
                        placeholder="— GUID —"
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {dirty && (
                        <button
                          type="button"
                          onClick={() => saveOne(s)}
                          disabled={savingId === s.id}
                          className="btn-ghost"
                          style={{ padding: "0.35rem 0.6rem" }}
                        >
                          {savingId === s.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} strokeWidth={2} />}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
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

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      className="px-4 py-2.5 text-left text-xs font-extrabold uppercase tracking-wide"
      style={{ color: "var(--fg-muted)", ...style }}
    >
      {children}
    </th>
  );
}
