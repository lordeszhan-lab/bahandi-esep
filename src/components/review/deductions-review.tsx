"use client";

/**
 * DeductionsReview — the reviewer/admin deduction surface (Prompt 18).
 *
 * One source of truth for every open case across the network, bucketed by the
 * stage that needs action next:
 *   • Pending acknowledgment (proposed)  — waiting on the charged employee.
 *   • Acknowledged → ready to approve     — reviewer's green-light queue.
 *   • Disputed                          — blocked; admin re-opens or upholds.
 *   • Approved → ready to apply (admin)  — the payroll hand-off.
 *   • Applied / cancelled                — history.
 *
 * The legal graph (config.ts) is enforced server-side; here we only show the
 * buttons the actor may press given the case's status + the viewer's role.
 * Calm premium-business surface — no count-up, no ledges (СВЕРКА joy-matrix).
 */

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Loader2,
  RotateCcw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { DeductionCaseCard } from "@/components/deductions/deduction-case-card";
import {
  approveDeductionAction,
  applyDeductionAction,
  cancelDeductionAction,
  reopenDeductionAction,
} from "@/lib/actions/deductions";
import type { DeductionView } from "@/lib/deductions/queries";

type Role = "reviewer" | "admin";

interface Bucket {
  key: string;
  title: string;
  hint?: string;
  items: DeductionView[];
}

function bucketOf(status: DeductionView["status"]): string {
  switch (status) {
    case "proposed":
      return "pending";
    case "acknowledged":
      return "ready";
    case "disputed":
      return "disputed";
    case "approved":
      return "approved";
    case "applied":
    case "cancelled":
      return "history";
    default:
      return "history";
  }
}

export interface DeductionsReviewProps {
  deductions: DeductionView[];
  role: Role;
}

export function DeductionsReview({ deductions, role }: DeductionsReviewProps) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [toast, setToast] = useState<{ kind: "error" | "success"; msg: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const flash = (kind: "error" | "success", msg: string) => setToast({ kind, msg });

  async function run(
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    successMsg: string,
  ) {
    setBusyId(id);
    try {
      const res = await fn();
      flash(res.ok ? "success" : "error", res.ok ? successMsg : res.error ?? "Ошибка");
      if (res.ok) {
        setCancelingId(null);
        setCancelReason("");
        router.refresh();
      }
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Ошибка");
    } finally {
      setBusyId(null);
    }
  }

  const buckets: Bucket[] = [
    {
      key: "pending",
      title: "Ожидают подтверждения сотрудником",
      hint: "Сотрудник должен ознакомиться и подписать (или оспорить).",
      items: [],
    },
    {
      key: "ready",
      title: "Подтверждены — готовы к утверждению",
      hint: "Сотрудник подписал. Можно утверждать.",
      items: [],
    },
    {
      key: "disputed",
      title: "Оспорены",
      hint: "Заблокированы до решения администратора.",
      items: [],
    },
    {
      key: "approved",
      title: "Утверждены — передать в payroll",
      hint: role === "admin" ? "Применить — удержание уходит в расчёт зарплаты." : "Применить может только администратор.",
      items: [],
    },
    {
      key: "history",
      title: "Применено / отменено",
      items: [],
    },
  ];
  for (const d of deductions) {
    const b = buckets.find((x) => x.key === bucketOf(d.status));
    b?.items.push(d);
  }

  function footerFor(d: DeductionView): React.ReactNode {
    const busy = busyId === d.id;
    const spinner = <Loader2 size={14} className="animate-spin" />;
    const cancelActive = cancelingId === d.id;

    const cancelForm = cancelActive ? (
      <div className="flex items-center gap-2 w-full">
        <input
          className="input"
          style={{ fontSize: "0.8125rem", flex: 1 }}
          placeholder="Причина отмены (мин. 3 символа)"
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          autoFocus
        />
        <button
          type="button"
          className="btn-primary"
          style={{ paddingLeft: "0.7rem", paddingRight: "0.7rem", fontSize: "0.8125rem" }}
          disabled={busy || cancelReason.trim().length < 3}
          onClick={() =>
            run(d.id, () => cancelDeductionAction(d.id, cancelReason), "Отменено")
          }
        >
          {busy ? spinner : <X size={14} strokeWidth={2} />} Отменить
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: "0.8125rem" }}
          disabled={busy}
          onClick={() => {
            setCancelingId(null);
            setCancelReason("");
          }}
        >
          Не сейчас
        </button>
      </div>
    ) : null;

    const cancelBtn = !cancelActive ? (
      <button
        type="button"
        className="btn-ghost"
        style={{ fontSize: "0.8125rem" }}
        disabled={busy}
        onClick={() => {
          setCancelingId(d.id);
          setCancelReason("");
        }}
      >
        <X size={14} strokeWidth={1.9} /> Отменить
      </button>
    ) : null;

    switch (d.status) {
      case "proposed":
        return (
          <>
            <span className="ml-auto" />
            {cancelBtn}
            {cancelForm}
          </>
        );
      case "acknowledged":
        return (
          <>
            <button
              type="button"
              className="btn-primary"
              style={{ paddingLeft: "0.7rem", paddingRight: "0.7rem", fontSize: "0.8125rem" }}
              disabled={busy}
              onClick={() => run(d.id, () => approveDeductionAction(d.id), "Утверждено")}
            >
              {busy ? spinner : <Check size={14} strokeWidth={2.25} />} Утвердить
            </button>
            <span className="ml-auto" />
            {cancelBtn}
            {cancelForm}
          </>
        );
      case "disputed":
        return (
          <>
            {role === "admin" && (
              <button
                type="button"
                className="btn-ghost"
                style={{ fontSize: "0.8125rem" }}
                disabled={busy}
                onClick={() => run(d.id, () => reopenDeductionAction(d.id), "Переоткрыто")}
              >
                {busy ? spinner : <RotateCcw size={14} strokeWidth={1.9} />} Переоткрыть
              </button>
            )}
            <span className="ml-auto" />
            {cancelBtn}
            {cancelForm}
          </>
        );
      case "approved":
        return (
          <>
            {role === "admin" ? (
              <button
                type="button"
                className="btn-primary"
                style={{ paddingLeft: "0.7rem", paddingRight: "0.7rem", fontSize: "0.8125rem" }}
                disabled={busy}
                onClick={() => run(d.id, () => applyDeductionAction(d.id), "Применено")}
              >
                {busy ? spinner : <Send size={14} strokeWidth={2} />} Применить
              </button>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 text-xs"
                style={{ color: "var(--fg-muted)" }}
              >
                <ShieldCheck size={14} strokeWidth={1.9} /> Применяет администратор
              </span>
            )}
            <span className="ml-auto" />
            {cancelBtn}
            {cancelForm}
          </>
        );
      default:
        return null;
    }
  }

  if (deductions.length === 0) {
    return (
      <div
        className="rounded-2xl px-6 py-12 text-center"
        style={{
          background: "var(--surface)",
          boxShadow: "var(--shadow-card)",
          border: "1px solid var(--border)",
        }}
      >
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
          Нет удержаний. Утверждённые акты с удержанием откроют дело здесь.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {buckets
        .filter((b) => b.items.length > 0)
        .map((b) => (
          <section key={b.key} className="space-y-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2
                className="text-base font-extrabold"
                style={{ color: "var(--fg)" }}
              >
                {b.title}
              </h2>
              <span
                className="text-xs font-bold"
                style={{
                  color: "var(--fg-muted)",
                  background: "var(--surface-2)",
                  borderRadius: 9999,
                  padding: "0.15rem 0.5rem",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {b.items.length}
              </span>
            </div>
            {b.hint && (
              <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
                {b.hint}
              </p>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {b.items.map((d) => (
                <DeductionCaseCard key={d.id} d={d} footer={footerFor(d)} />
              ))}
            </div>
          </section>
        ))}

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
