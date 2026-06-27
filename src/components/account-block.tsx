"use client";

import Link from "next/link";
import { Settings, LogOut } from "lucide-react";
import { ROLE_LABEL } from "@/lib/auth-shared";
import { useDevPreview } from "@/lib/dev-preview";
import type { CurrentProfile } from "@/lib/auth-shared";
import type { UserRole } from "@/lib/db/types";
import type { DevLocationOption } from "@/components/dev/role-switcher";

export interface AccountBlockProps {
  profile: CurrentProfile;
  logoutAction: (formData: FormData) => Promise<void>;
  devLocations?: DevLocationOption[];
}

function IconBtn({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <span
      className="flex items-center justify-center w-8 h-8 rounded-lg cursor-pointer transition-colors"
      title={title}
      style={{ color: "var(--fg-muted)" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
        (e.currentTarget as HTMLElement).style.color = "var(--fg)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "";
        (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)";
      }}
    >
      {children}
    </span>
  );
}

function DevSwitcherSlot({
  realRole,
  locations,
}: {
  realRole: UserRole;
  locations: DevLocationOption[];
}) {
  if (process.env.NODE_ENV === "production") return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DevRoleSwitcher } = require("@/components/dev/role-switcher") as typeof import("@/components/dev/role-switcher");
  return <DevRoleSwitcher realRole={realRole} locations={locations} />;
}

export function AccountBlock({
  profile,
  logoutAction,
  devLocations = [],
}: AccountBlockProps) {
  const { effectiveRole } = useDevPreview();

  return (
    <div className="p-3 space-y-2">
      {/* Identity row */}
      <div className="flex items-center gap-2.5 px-1">
        {/* Avatar circle */}
        <div
          className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center select-none"
          style={{
            background: "var(--brand-soft)",
            color: "var(--brand-strong)",
            fontSize: "0.75rem",
            fontWeight: 700,
          }}
        >
          {profile.initials}
        </div>

        {/* Name + role */}
        <div className="flex-1 min-w-0">
          <p
            className="text-sm truncate leading-snug"
            style={{ fontWeight: 600, color: "var(--fg)" }}
          >
            {profile.full_name}
          </p>
          <p
            className="leading-tight truncate"
            style={{ fontSize: 12, color: "var(--fg-muted)" }}
          >
            {ROLE_LABEL[effectiveRole]}
          </p>
        </div>
      </div>

      {/* Dev role / location preview */}
      {process.env.NODE_ENV !== "production" && (
        <DevSwitcherSlot realRole={profile.role} locations={devLocations} />
      )}

      {/* Action row */}
      <div className="flex items-center gap-1 px-1">
        <Link href="/settings" className="flex-1 flex justify-center">
          <IconBtn title="Настройки">
            <Settings size={15} strokeWidth={1.75} />
          </IconBtn>
        </Link>

        <form action={logoutAction} className="flex-1 flex justify-center">
          <button type="submit" className="contents">
            <IconBtn title="Выйти">
              <LogOut size={15} strokeWidth={1.75} />
            </IconBtn>
          </button>
        </form>
      </div>
    </div>
  );
}
