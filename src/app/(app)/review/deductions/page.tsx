/**
 * Reviewer/admin deductions surface — Prompt 18.
 *
 * One source of truth for every open deduction case: the pending-acknowledgment
 * queue, the acknowledged → approve queue, disputed cases, and the payroll
 * hand-off. Server Component — loads under RLS (reviewer/admin see all
 * deductions) and hands the view-model list to the interactive client.
 */

import { getCurrentProfile } from "@/lib/auth";
import { APP_NAME } from "@/lib/brand";
import { loadReviewerDeductions } from "@/lib/deductions/queries";
import { DeductionsReview } from "@/components/review/deductions-review";

export const metadata = { title: `Удержания · ${APP_NAME}` };

export default async function ReviewerDeductionsPage() {
  const profile = await getCurrentProfile();
  const role = profile?.role === "admin" ? "admin" : "reviewer";
  const deductions = (await loadReviewerDeductions()) ?? [];

  const pending = deductions.filter((d) => d.status === "proposed").length;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-10 sm:py-12">
      <p className="eyebrow mb-3">Проверка</p>
      <h1
        className="text-2xl font-extrabold mb-1"
        style={{ color: "var(--fg)" }}
      >
        Удержания
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--fg-muted)" }}>
        Дела об удержаниях — сотрудник подтверждает (е-подпись) или оспаривает.
        {pending > 0 && ` · Ожидают подтверждения: ${pending}`}
      </p>

      <DeductionsReview deductions={deductions} role={role} />
    </div>
  );
}
