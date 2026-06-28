"use client";

/**
 * MyDeductions — the charged employee's own deduction cases (Prompt 18).
 *
 * The employee-facing half of the workflow: each `proposed` case waits for the
 * charged employee to either Acknowledge (e-signature — type their own name +
 * tick "I have read and agree") or Dispute (state a reason). Acknowledged cases
 * are handed to the reviewer to approve; disputed cases are blocked until an
 * admin decides. The legal basis + the enforced cap are shown on every card so
 * the employee signs knowing exactly what and why.
 *
 * Calm surface — no count-up, no ledges (СВЕРКА joy-matrix: deductions = no joy).
 */

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Loader2,
  PenLine,
  ShieldQuestion,
  X,
} from "lucide-react";
import { DeductionCaseCard } from "@/components/deductions/deduction-case-card";
import {
  acknowledgeDeductionAction,
  disputeDeductionAction,
} from "@/lib/actions/deductions";
import { LABOR_CODE } from "@/lib/deductions/config";
import type { DeductionView } from "@/lib/deductions/queries";

type Mode = "ack" | "dispute" | null;

export interface MyDeductionsProps {
  deductions: DeductionView[];
  /** The viewer's profile name — the e-signature must match it. */
  myName: string;
}

export function MyDeductions({ deductions, myName }: MyDeductionsProps) {
  const router = useRouter();
  const [modeById, setModeById] = useState<Record<string, Mode>>({});
  const [sigName, setSigName] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [disputeReason, setDisputeReason] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "error" | "success"; msg: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const flash = (kind: "error" | "success", msg: string) => setToast({ kind, msg });

  function setMode(id: string, m: Mode) {
    setModeById((s) => ({ ...s, [id]: m }));
  }

  async function runAck(d: DeductionView) {
    const name = (sigName[d.id] ?? "").trim();
    if (!agreed[d.id]) {
      flash("error", "Подтвердите, что ознакомлены с основанием");
      return;
    }
    if (name.toLowerCase() !== myName.trim().toLowerCase()) {
      flash("error", "Подпись должна совпадать с вашим именем в профиле");
      return;
    }
    setBusyId(d.id);
    try {
      const res = await acknowledgeDeductionAction(d.id, name);
      flash(res.ok ? "success" : "error", res.ok ? "Удержание подтверждено подписью" : res.error ?? "Ошибка");
      if (res.ok) {
        setMode(d.id, null);
        router.refresh();
      }
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Ошибка");
    } finally {
      setBusyId(null);
    }
  }

  async function runDispute(d: DeductionView) {
    const reason = (disputeReason[d.id] ?? "").trim();
    if (reason.length < 3) {
      flash("error", "Опишите причину оспаривания (мин. 3 символа)");
      return;
    }
    setBusyId(d.id);
    try {
      const res = await disputeDeductionAction(d.id, reason);
      flash(res.ok ? "success" : "error", res.ok ? "Удержание оспорено" : res.error ?? "Ошибка");
      if (res.ok) {
        setMode(d.id, null);
        router.refresh();
      }
    } catch (err) {
      flash("error", err instanceof Error ? err.message : "Ошибка");
    } finally {
      setBusyId(null);
    }
  }

  function footerFor(d: DeductionView): React.ReactNode {
    if (d.status !== "proposed") return null;
    const mode = modeById[d.id] ?? null;
    const busy = busyId === d.id;
    const spinner = <Loader2 size={14} className="animate-spin" />;

    if (mode === "ack") {
      return (
        <div className="w-full space-y-2">
          <label
            className="flex items-start gap-2 text-xs"
            style={{ color: "var(--fg)" }}
          >
            <input
              type="checkbox"
              checked={agreed[d.id] ?? false}
              onChange={(e) => setAgreed((s) => ({ ...s, [d.id]: e.target.checked }))}
              style={{ marginTop: 2 }}
            />
            <span>
              Я ознакомлен с основанием удержания и согласен с удержанием в
              пределах 50% моей зарплаты ({LABOR_CODE.deduction}).
            </span>
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              className="input"
              style={{ fontSize: "0.8125rem", flex: 1, minWidth: 200 }}
              placeholder={`Введите имя: ${myName}`}
              value={sigName[d.id] ?? ""}
              onChange={(e) => setSigName((s) => ({ ...s, [d.id]: e.target.value }))}
              autoFocus
            />
            <button
              type="button"
              className="btn-primary"
              style={{ paddingLeft: "0.7rem", paddingRight: "0.7rem", fontSize: "0.8125rem" }}
              disabled={busy}
              onClick={() => runAck(d)}
            >
              {busy ? spinner : <PenLine size={14} strokeWidth={2} />} Подписать
            </button>
            <button
              type="button"
              className="btn-ghost"
              style={{ fontSize: "0.8125rem" }}
              disabled={busy}
              onClick={() => setMode(d.id, null)}
            >
              Отмена
            </button>
          </div>
        </div>
      );
    }

    if (mode === "dispute") {
      return (
        <div className="w-full space-y-2">
          <textarea
            className="input"
            rows={3}
            style={{ fontSize: "0.8125rem" }}
            placeholder="Опишите, почему не согласны с удержанием"
            value={disputeReason[d.id] ?? ""}
            onChange={(e) => setDisputeReason((s) => ({ ...s, [d.id]: e.target.value }))}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              style={{
                paddingLeft: "0.7rem",
                paddingRight: "0.7rem",
                fontSize: "0.8125rem",
                background: "var(--risk-fraud)",
              }}
              disabled={busy}
              onClick={() => runDispute(d)}
            >
              {busy ? spinner : <ShieldQuestion size={14} strokeWidth={2} />} Оспорить
            </button>
            <button
              type="button"
              className="btn-ghost"
              style={{ fontSize: "0.8125rem" }}
              disabled={busy}
              onClick={() => setMode(d.id, null)}
            >
              Отмена
            </button>
          </div>
        </div>
      );
    }

    return (
      <>
        <button
          type="button"
          className="btn-primary"
          style={{ paddingLeft: "0.7rem", paddingRight: "0.7rem", fontSize: "0.8125rem" }}
          onClick={() => setMode(d.id, "ack")}
        >
          <PenLine size={14} strokeWidth={2} /> Подтвердить (e-подпись)
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: "0.8125rem", color: "var(--risk-fraud-ink)" }}
          onClick={() => setMode(d.id, "dispute")}
        >
          <X size={14} strokeWidth={1.9} /> Оспорить
        </button>
      </>
    );
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
          У вас нет удержаний. Здесь появятся дела, открытые по утверждённым актам
          с удержанием.
        </p>
      </div>
    );
  }

  const actionNeeded = deductions.filter((d) => d.status === "proposed");
  const rest = deductions.filter((d) => d.status !== "proposed");

  return (
    <div className="space-y-8">
      {actionNeeded.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="text-base font-extrabold" style={{ color: "var(--fg)" }}>
              Требуют вашего действия
            </h2>
            <span
              className="text-xs font-bold"
              style={{
                color: "var(--risk-watch-ink)",
                background: "var(--risk-watch-soft)",
                borderRadius: 9999,
                padding: "0.15rem 0.5rem",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {actionNeeded.length}
            </span>
          </div>
          <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
            Подтвердите e-подписью или оспорьте. До подтверждения удержание не
            применяется.
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {actionNeeded.map((d) => (
              <DeductionCaseCard key={d.id} d={d} footer={footerFor(d)} />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-extrabold" style={{ color: "var(--fg)" }}>
            История
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {rest.map((d) => (
              <DeductionCaseCard key={d.id} d={d} footer={footerFor(d)} />
            ))}
          </div>
        </section>
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
