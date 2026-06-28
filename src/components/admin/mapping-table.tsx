"use client";

/**
 * IikoNomenclature mapping table — Prompt 15.
 *
 * Inline-editable, hairline-row table mapping app write-off categories to Iiko
 * GUIDs (product / unit / store / account). Calls the save/delete server
 * actions in src/lib/actions/iiko-mapping.ts. Surfaces an "unmapped" warning
 * banner for reason codes that lack a mapping.
 */

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Download, Loader2, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveMapping,
  deleteMapping,
  bulkUpsertNomenclature,
  type MappingInput,
} from "@/lib/actions/iiko-mapping";
import { parseCsv, toCsv, downloadTextFile, colIndex } from "@/lib/csv";
import type { IikoNomenclature, ReasonCode } from "@/lib/db/types";

// ── Types ────────────────────────────────────────────────────────────────────

interface MappingTableProps {
  reasonCodes: ReasonCode[];
  mappings: IikoNomenclature[];
}

type FieldErrors = Partial<Record<keyof MappingInput, string>>;

const NEW_ID = "__new__";

// ── Helpers ──────────────────────────────────────────────────────────────────

const GUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isGuid(s: string): boolean {
  return GUID_RE.test(s);
}

function emptyDraft(reasonCodeId?: string | null): MappingInput {
  return {
    id: null,
    reasonCodeId: reasonCodeId ?? null,
    productLabel: "",
    iikoProductId: "",
    iikoUnit: "",
    iikoStoreId: "",
    iikoAccountId: "",
  };
}

function rowToInput(m: IikoNomenclature): MappingInput {
  return {
    id: m.id,
    reasonCodeId: m.reason_code_id,
    productLabel: m.product_label,
    iikoProductId: m.iiko_product_id,
    iikoUnit: m.iiko_unit,
    iikoStoreId: m.iiko_store_id,
    iikoAccountId: m.iiko_account_id,
  };
}

function validateDraft(d: MappingInput): FieldErrors {
  const e: FieldErrors = {};
  if (!d.productLabel.trim()) e.productLabel = "Укажите название";
  if (!isGuid(d.iikoProductId)) e.iikoProductId = "GUID";
  if (!d.iikoUnit.trim()) e.iikoUnit = "Ед.";
  if (!isGuid(d.iikoStoreId)) e.iikoStoreId = "GUID";
  if (!isGuid(d.iikoAccountId)) e.iikoAccountId = "GUID";
  if (d.reasonCodeId && !isGuid(d.reasonCodeId)) e.reasonCodeId = "GUID";
  return e;
}

function reasonLabel(reasons: ReasonCode[], id: string | null | undefined): string {
  if (!id) return "—";
  return reasons.find((r) => r.id === id)?.label_ru ?? "—";
}

function shortGuid(g: string): string {
  return g.length > 13 ? g.slice(0, 8) + "…" : g;
}

// ── Component ────────────────────────────────────────────────────────────────

export function MappingTable({ reasonCodes, mappings }: MappingTableProps) {
  const router = useRouter();
  const [rows, setRows] = useState<IikoNomenclature[]>(mappings);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MappingInput>(emptyDraft());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; msg: string } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Reset transient toast automatically.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const unmapped = reasonCodes.filter(
    (rc) => !rows.some((m) => m.reason_code_id === rc.id),
  );

  // ── Edit lifecycle ────────────────────────────────────────────────────────

  function startEdit(m: IikoNomenclature) {
    setEditingId(m.id);
    setDraft(rowToInput(m));
    setErrors({});
  }

  function startAddForReason(reasonCodeId?: string | null) {
    setEditingId(NEW_ID);
    setDraft(emptyDraft(reasonCodeId ?? null));
    setErrors({});
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft());
    setErrors({});
  }

  function updateField<K extends keyof MappingInput>(key: K, value: MappingInput[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function save() {
    const e = validateDraft(draft);
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;

    setSaving(true);
    try {
      const result = await saveMapping(draft);
      if (!result.ok) {
        setToast({ kind: "error", msg: result.error });
        return;
      }
      const saved = result.mapping;
      setRows((prev) => {
        const idx = prev.findIndex((m) => m.id === saved.id);
        if (idx === -1) return [saved, ...prev];
        const next = [...prev];
        next[idx] = saved;
        return next;
      });
      cancelEdit();
      setToast({ kind: "success", msg: "Маппинг сохранён" });
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Не удалось сохранить" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Удалить маппинг?")) return;
    setDeletingId(id);
    try {
      const result = await deleteMapping(id);
      if (!result.ok) {
        setToast({ kind: "error", msg: result.error });
        return;
      }
      setRows((prev) => prev.filter((m) => m.id !== id));
      setToast({ kind: "success", msg: "Маппинг удалён" });
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Не удалось удалить" });
    } finally {
      setDeletingId(null);
    }
  }

  const isEditing = editingId !== null;
  const isNew = editingId === NEW_ID;

  // ── Bulk import (keyed by product_label) ───────────────────────────────────

  function downloadNomenclatureTemplate() {
    const header = [
      "product_label",
      "iiko_product_id",
      "iiko_unit",
      "iiko_store_id",
      "iiko_account_id",
      "reason_code_id",
    ];
    const rows = [header];
    downloadTextFile("iiko-nomenclature-template.csv", toCsv(rows));
  }

  async function runBulkNomenclature() {
    const matrix = parseCsv(bulkText);
    if (matrix.length < 2) {
      setToast({ kind: "error", msg: "Вставьте CSV с заголовком и хотя бы одной строкой" });
      return;
    }
    const header = matrix[0];
    const iLabel = colIndex(header, "product_label");
    const iProd = colIndex(header, "iiko_product_id");
    const iUnit = colIndex(header, "iiko_unit");
    const iStore = colIndex(header, "iiko_store_id");
    const iAcc = colIndex(header, "iiko_account_id");
    if (iLabel < 0 || iProd < 0 || iUnit < 0 || iStore < 0 || iAcc < 0) {
      setToast({
        kind: "error",
        msg: "CSV должен содержать: product_label, iiko_product_id, iiko_unit, iiko_store_id, iiko_account_id",
      });
      return;
    }
    const iReason = colIndex(header, "reason_code_id");
    const payload = matrix.slice(1).map((r) => ({
      product_label: r[iLabel],
      iiko_product_id: r[iProd],
      iiko_unit: r[iUnit],
      iiko_store_id: r[iStore],
      iiko_account_id: r[iAcc],
      reason_code_id: iReason >= 0 ? r[iReason] : undefined,
    }));
    setBulkBusy(true);
    try {
      const res = await bulkUpsertNomenclature(payload);
      if (res.inserted + res.updated > 0) {
        setToast({
          kind: res.ok ? "success" : "error",
          msg: `Добавлено ${res.inserted}, обновлено ${res.updated}${res.errors.length ? `, ошибок ${res.errors.length}` : ""}`,
        });
        setBulkOpen(false);
        setBulkText("");
        router.refresh();
      } else {
        setToast({ kind: "error", msg: res.errors[0] ?? "Ничего не импортировано" });
      }
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : "Импорт не удался" });
    } finally {
      setBulkBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="fade-up">
      {/* ── Unmapped banner ─────────────────────────────────────────────────── */}
      {unmapped.length > 0 && (
        <div
          className="mb-6 rounded-2xl p-4 sm:p-5"
          style={{
            background: "var(--risk-watch-soft)",
            border: "1px solid var(--risk-watch)",
          }}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              size={18}
              strokeWidth={2}
              style={{ color: "var(--risk-watch-ink)", marginTop: 2, flexShrink: 0 }}
            />
            <div className="min-w-0 flex-1">
              <p
                className="text-sm font-bold mb-1"
                style={{ color: "var(--risk-watch-ink)" }}
              >
                Без маппинга в Iiko — {unmapped.length}
              </p>
              <p
                className="text-xs mb-3"
                style={{ color: "var(--risk-watch-ink)", opacity: 0.85 }}
              >
                Следующие категории списаний не сопоставлены с номенклатурой
                Iiko — posting по ним невозможен.
              </p>
              <div className="flex flex-wrap gap-2">
                {unmapped.map((rc) => (
                  <button
                    key={rc.id}
                    type="button"
                    onClick={() => startAddForReason(rc.id)}
                    disabled={isEditing}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--risk-watch)",
                      color: "var(--risk-watch-ink)",
                    }}
                  >
                    <Plus size={12} strokeWidth={2.5} />
                    {rc.label_ru}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Header row: title + add ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2
            className="text-base font-extrabold"
            style={{ color: "var(--fg)" }}
          >
            Номенклатура
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--fg-muted)" }}>
            {rows.length} записей
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={downloadNomenclatureTemplate}
            className="btn-ghost"
          >
            <Download size={14} strokeWidth={1.9} /> Шаблон
          </button>
          <button
            type="button"
            onClick={() => setBulkOpen((v) => !v)}
            disabled={isEditing}
            className="btn-ghost"
          >
            <Upload size={14} strokeWidth={1.9} /> Массовый импорт
          </button>
          <button
            type="button"
            onClick={() => startAddForReason(null)}
            disabled={isEditing}
            className="btn-primary"
            style={{ paddingLeft: "0.875rem", paddingRight: "0.875rem" }}
          >
            <Plus size={16} strokeWidth={2.5} />
            Добавить
          </button>
        </div>
      </div>

      {/* ── Bulk import panel ──────────────────────────────────────────────── */}
      {bulkOpen && (
        <div
          className="mb-4 rounded-2xl p-4 space-y-3"
          style={{ background: "var(--surface)", boxShadow: "var(--shadow-card)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold" style={{ color: "var(--fg)" }}>
              Массовый импорт номенклатуры
            </p>
            <button type="button" onClick={() => setBulkOpen(false)} className="btn-ghost" style={{ padding: "0.25rem" }}>
              <X size={16} />
            </button>
          </div>
          <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
            Колонки: <code>product_label, iiko_product_id, iiko_unit, iiko_store_id, iiko_account_id, reason_code_id</code>.
            Существующие записи сопоставляются по <code>product_label</code> и обновляются.
          </p>
          <textarea
            className="input font-mono"
            rows={6}
            placeholder={"product_label,iiko_product_id,iiko_unit,iiko_store_id,iiko_account_id,reason_code_id"}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setBulkOpen(false)} className="btn-ghost">
              Отмена
            </button>
            <button
              type="button"
              onClick={runBulkNomenclature}
              disabled={bulkBusy}
              className="btn-primary"
              style={{ paddingLeft: "0.85rem", paddingRight: "0.85rem" }}
            >
              {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} strokeWidth={2} />}
              Импортировать
            </button>
          </div>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────────── */}
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
                <Th>Продукт</Th>
                <Th>Причина</Th>
                <Th>Iiko продукт</Th>
                <Th>Ед.</Th>
                <Th>Склад</Th>
                <Th>Счёт</Th>
                <Th aria-label="Действия" style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {isNew && (
                <EditRow
                  draft={draft}
                  errors={errors}
                  reasons={reasonCodes}
                  saving={saving}
                  onChange={updateField}
                  onSave={save}
                  onCancel={cancelEdit}
                />
              )}

              {rows.length === 0 && !isNew && (
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-sm"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    Маппингов пока нет. Нажмите «Добавить».
                  </td>
                </tr>
              )}

              {rows.map((m) =>
                editingId === m.id ? (
                  <EditRow
                    key={m.id}
                    draft={draft}
                    errors={errors}
                    reasons={reasonCodes}
                    saving={saving}
                    onChange={updateField}
                    onSave={save}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <ViewRow
                    key={m.id}
                    m={m}
                    reasons={reasonCodes}
                    deleting={deletingId === m.id}
                    onEdit={() => startEdit(m)}
                    onDelete={() => remove(m.id)}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Toast ────────────────────────────────────────────────────────────── */}
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

// ── Sub-components ───────────────────────────────────────────────────────────

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

function ViewRow({
  m,
  reasons,
  deleting,
  onEdit,
  onDelete,
}: {
  m: IikoNomenclature;
  reasons: ReasonCode[];
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr
      className="group"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <Td>
        <span className="font-semibold" style={{ color: "var(--fg)" }}>
          {m.product_label}
        </span>
      </Td>
      <Td>
        <span style={{ color: "var(--fg-muted)" }}>
          {reasonLabel(reasons, m.reason_code_id)}
        </span>
      </Td>
      <Td>
        <code
          className="text-xs"
          style={{ color: "var(--fg-muted)" }}
          title={m.iiko_product_id}
        >
          {shortGuid(m.iiko_product_id)}
        </code>
      </Td>
      <Td>
        <span className="text-xs font-semibold" style={{ color: "var(--fg)" }}>
          {m.iiko_unit}
        </span>
      </Td>
      <Td>
        <code className="text-xs" style={{ color: "var(--fg-muted)" }} title={m.iiko_store_id}>
          {shortGuid(m.iiko_store_id)}
        </code>
      </Td>
      <Td>
        <code className="text-xs" style={{ color: "var(--fg-muted)" }} title={m.iiko_account_id}>
          {shortGuid(m.iiko_account_id)}
        </code>
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          <IconBtn label="Изменить" onClick={onEdit}>
            <Pencil size={15} strokeWidth={1.9} />
          </IconBtn>
          <IconBtn label="Удалить" onClick={onDelete} disabled={deleting} danger>
            <Trash2 size={15} strokeWidth={1.9} />
          </IconBtn>
        </div>
      </Td>
    </tr>
  );
}

function EditRow({
  draft,
  errors,
  reasons,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: MappingInput;
  errors: FieldErrors;
  reasons: ReasonCode[];
  saving: boolean;
  onChange: <K extends keyof MappingInput>(key: K, value: MappingInput[K]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const hasErrors = Object.values(errors).some(Boolean);
  return (
    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
      <Td>
        <CellInput
          value={draft.productLabel}
          onChange={(v) => onChange("productLabel", v)}
          placeholder="Напр. Говядина 1кг"
          error={errors.productLabel}
        />
      </Td>
      <Td>
        <Select
          value={draft.reasonCodeId ?? "__none__"}
          onValueChange={(v) => onChange("reasonCodeId", v === "__none__" ? null : v)}
        >
          <SelectTrigger style={{ minHeight: 38, fontSize: "0.8125rem" }}>
            <SelectValue placeholder="Без причины" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Без причины</SelectItem>
            {reasons.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.label_ru}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Td>
      <Td>
        <CellInput
          value={draft.iikoProductId}
          onChange={(v) => onChange("iikoProductId", v)}
          placeholder="GUID продукта"
          mono
          error={errors.iikoProductId}
        />
      </Td>
      <Td>
        <CellInput
          value={draft.iikoUnit}
          onChange={(v) => onChange("iikoUnit", v)}
          placeholder="кг"
          error={errors.iikoUnit}
        />
      </Td>
      <Td>
        <CellInput
          value={draft.iikoStoreId}
          onChange={(v) => onChange("iikoStoreId", v)}
          placeholder="GUID склада"
          mono
          error={errors.iikoStoreId}
        />
      </Td>
      <Td>
        <CellInput
          value={draft.iikoAccountId}
          onChange={(v) => onChange("iikoAccountId", v)}
          placeholder="GUID счёта"
          mono
          error={errors.iikoAccountId}
        />
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          <IconBtn
            label="Сохранить"
            onClick={onSave}
            disabled={saving || hasErrors}
            primary
          >
            <Check size={16} strokeWidth={2.5} />
          </IconBtn>
          <IconBtn label="Отмена" onClick={onCancel} disabled={saving}>
            <X size={16} strokeWidth={2.2} />
          </IconBtn>
        </div>
      </Td>
    </tr>
  );
}

function Td({
  children,
  style,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...rest}
      className="px-4 py-2.5 align-middle"
      style={{ color: "var(--fg)", ...style }}
    >
      {children}
    </td>
  );
}

function CellInput({
  value,
  onChange,
  placeholder,
  error,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  mono?: boolean;
}) {
  return (
    <input
      className="input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-invalid={!!error}
      title={error}
      style={{
        padding: "0.4rem 0.6rem",
        fontSize: "0.8125rem",
        fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : undefined,
        minWidth: 120,
      }}
    />
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  primary,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-40"
      style={{
        width: 30,
        height: 30,
        color: primary
          ? "var(--brand-strong)"
          : danger
            ? "var(--risk-fraud-ink)"
            : "var(--fg-muted)",
        background: "transparent",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLButtonElement).style.background = "var(--surface)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
