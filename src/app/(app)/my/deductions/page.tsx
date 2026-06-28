/**
 * Employee "my deductions" surface — Prompt 18.
 *
 * The charged employee's own cases: the ones awaiting their e-signature or
 * dispute, plus the history of acknowledged / disputed / applied cases. Server
 * Component — RLS (`deductions_select`) scopes the employee to deductions for
 * charged employees in their location.
 */

import { getCurrentProfile } from "@/lib/auth";
import { APP_NAME } from "@/lib/brand";
import { loadEmployeeDeductions } from "@/lib/deductions/queries";
import { MyDeductions } from "@/components/employee/my-deductions";

export const metadata = { title: `Мои удержания · ${APP_NAME}` };

export default async function MyDeductionsPage() {
  const profile = await getCurrentProfile();
  const deductions = (await loadEmployeeDeductions()) ?? [];

  const pending = deductions.filter((d) => d.status === "proposed").length;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-10 sm:py-12">
      <p className="eyebrow mb-3">Личное</p>
      <h1
        className="text-2xl font-extrabold mb-1"
        style={{ color: "var(--fg)" }}
      >
        Мои удержания
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--fg-muted)" }}>
        Дела об удержаниях по вашей точке — подтвердите (е-подпись) или оспорьте до применения.
        {pending > 0 && ` · Требуют действия: ${pending}`}
      </p>

      <MyDeductions
        deductions={deductions}
        myName={profile?.full_name ?? ""}
      />
    </div>
  );
}
