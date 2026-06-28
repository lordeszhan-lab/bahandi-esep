import * as React from "react";

/**
 * Form section label — Nunito 600, 13 px, --fg-muted, sentence case.
 *
 * Use this inside capture and form screens.
 * Do NOT use `.eyebrow` (mono UPPERCASE) for form sections — that class is
 * reserved for brand-level page headers (login screen eyebrow, etc.).
 */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={className}
      style={{
        fontSize: "0.8125rem",
        fontWeight: 600,
        color: "var(--fg-muted)",
        letterSpacing: "normal",
        textTransform: "none",
        lineHeight: 1.4,
        marginBottom: "0.625rem",
      }}
    >
      {children}
    </p>
  );
}
