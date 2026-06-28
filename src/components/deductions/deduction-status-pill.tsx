/**
 * DeductionStatusPill — the status chip for a deduction case (Prompt 18).
 *
 * Stays inside the СВЕРКА risk triad: acknowledged/approved/applied = clean
 * (green), proposed = watch (amber, awaiting the employee), disputed = fraud
 * (red, blocked), cancelled = neutral-muted. The label is always paired with the
 * colour so colour isn't the only meaning carrier (a11y / b&w print of the act).
 */

import {
  DEDUCTION_STATUS_LABEL,
  DEDUCTION_STATUS_RISK,
} from "@/lib/deductions/config";
import type { DeductionStatus } from "@/lib/db/types";

export function DeductionStatusPill({ status }: { status: DeductionStatus }) {
  const label = DEDUCTION_STATUS_LABEL[status];
  const token = DEDUCTION_STATUS_RISK[status];

  if (token === "muted") {
    return (
      <span
        className="pill-status"
        style={{
          background: "var(--surface-2)",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </span>
    );
  }

  return (
    <span className="pill-status" data-risk={token}>
      {label}
    </span>
  );
}
