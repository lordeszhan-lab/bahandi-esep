"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  History,
  ListChecks,
  BarChart3,
  Search,
  Database,
  Workflow,
  Users,
  ShieldCheck,
  Network,
  Scale,
  Sun,
  Moon,
  LogOut,
} from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import { AccountBlock } from "@/components/account-block";
import type { CurrentProfile } from "@/lib/auth-shared";
import type { UserRole } from "@/lib/db/types";

// ── Navigation structure ──────────────────────────────────────────────────────
// Single source of truth: a flat list of nav items, each tagged with the roles
// allowed to see it. Items with `built: false` have no real screen yet and are
// never rendered (kept here so they reappear the moment they ship).

type NavGroupKey = "review" | "manage";

const NAV_GROUP_LABEL: Record<NavGroupKey, string> = {
  review: "Проверка",
  manage: "Управление",
};

interface NavItem {
  label: string;
  href: string;
  Icon: LucideIcon;
  roles: UserRole[];
  built?: boolean;
  group?: NavGroupKey;
}

const NAV_ITEMS: NavItem[] = [
  // Employee — capture flow (no section header)
  { label: "Фиксация",     href: "/capture",         Icon: ClipboardList, roles: ["employee"] },
  { label: "Мои списания", href: "/capture/history", Icon: History,        roles: ["employee"] },

  // Review — «Проверка»
  { label: "Очередь",       href: "/review",                Icon: ListChecks,  roles: ["reviewer", "admin"], group: "review" },
  { label: "Башня",         href: "/review/tower",          Icon: BarChart3,   roles: ["reviewer", "admin"], group: "review" },
  { label: "Удержания",     href: "/review/deductions",     Icon: Scale,       roles: ["reviewer", "admin"], group: "review" },
  { label: "Расследования", href: "/review/investigations", Icon: Search,      roles: ["reviewer", "admin"], group: "review", built: false },

  // Manage — «Управление»
  { label: "Iiko",         href: "/admin/iiko",     Icon: Database,    roles: ["admin"], group: "manage" },
  { label: "Маппинг",      href: "/admin/mapping",  Icon: Workflow,    roles: ["admin"], group: "manage" },
  { label: "Кластеры",     href: "/admin/clusters", Icon: Network,     roles: ["admin"], group: "manage" },
  { label: "Пользователи", href: "/admin/users",    Icon: Users,       roles: ["admin"], group: "manage" },
  { label: "Аудит",        href: "/admin/audit",    Icon: ShieldCheck, roles: ["admin"], group: "manage", built: false },
];

interface NavGroup {
  groupLabel?: string;
  items: NavItem[];
}

/** Filter to built items visible to `role`, then collapse consecutive items
 *  that share the same section label into groups. Empty sections never render. */
function buildNavGroups(role: UserRole): NavGroup[] {
  const visible = NAV_ITEMS.filter(
    (i) => i.built !== false && i.roles.includes(role),
  );
  const groups: NavGroup[] = [];
  for (const item of visible) {
    const label = item.group ? NAV_GROUP_LABEL[item.group] : undefined;
    const last = groups[groups.length - 1];
    if (last && last.groupLabel === label) {
      last.items.push(item);
    } else {
      groups.push({ groupLabel: label, items: [item] });
    }
  }
  return groups;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface AppShellClientProps {
  profile: CurrentProfile;
  logoutAction: (formData: FormData) => Promise<void>;
  children: React.ReactNode;
}

// ── Component ─────────────────────────────────────────────────────────────────

function AppShellInner({
  profile,
  logoutAction,
  children,
}: AppShellClientProps) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Sync with data-theme set on <html> server-side; runs after hydration — no mismatch.
  useEffect(() => {
    if (document.documentElement.dataset.theme === "dark") setTheme("dark");
  }, []);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }

  const navGroups = buildNavGroups(profile.role);
  const allNavHrefs = navGroups.flatMap((g) => g.items.map((i) => i.href));

  /** Exactly one nav item active: longest href that matches wins over prefixes. */
  function isActive(href: string) {
    const matches = allNavHrefs.filter(
      (h) => pathname === h || pathname.startsWith(h + "/"),
    );
    if (matches.length === 0) return false;
    const best = matches.reduce((a, b) => (a.length >= b.length ? a : b));
    return best === href;
  }
  const isEmployee = profile.role === "employee";
  const bottomItems = navGroups.flatMap((g) => g.items);

  // ── Nav link ──────────────────────────────────────────────────────────────

  function NavLink({ item }: { item: NavItem }) {
    const active = isActive(item.href);
    return (
      <Link
        href={item.href}
        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors"
        style={
          active
            ? {
                background: "var(--brand-soft)",
                color: "var(--brand-strong)",
                fontWeight: 700,
              }
            : { color: "var(--fg-muted)" }
        }
        onMouseEnter={(e) => {
          if (!active) {
            (e.currentTarget as HTMLAnchorElement).style.background =
              "var(--surface-2)";
            (e.currentTarget as HTMLAnchorElement).style.color = "var(--fg)";
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            (e.currentTarget as HTMLAnchorElement).style.background = "";
            (e.currentTarget as HTMLAnchorElement).style.color =
              "var(--fg-muted)";
          }
        }}
      >
        <item.Icon size={18} strokeWidth={active ? 2.25 : 1.75} />
        {item.label}
      </Link>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Sticky header ──────────────────────────────────────── */}
      <header
        className="sticky top-0 z-30 flex items-center h-14 px-4 gap-2"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 1px 3px 0 rgb(0 0 0 / 0.05)",
          flexShrink: 0,
        }}
      >
        {/* Wordmark */}
        <span
          className="text-base select-none"
          style={{ fontWeight: 800, color: "var(--fg)", letterSpacing: "-0.01em" }}
        >
          {APP_NAME}
        </span>

        <span className="flex-1" />

        {/* Mobile-only logout (sidebar is hidden on small screens) */}
        <form action={logoutAction} className="md:hidden">
          <button
            type="submit"
            title="Выйти"
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "var(--fg-muted)" }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.color =
                "var(--fg-muted)")
            }
          >
            <LogOut size={17} strokeWidth={1.75} />
          </button>
        </form>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: "var(--fg-muted)" }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color = "var(--fg)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.color =
              "var(--fg-muted)")
          }
        >
          {theme === "dark" ? (
            <Sun size={17} strokeWidth={1.75} />
          ) : (
            <Moon size={17} strokeWidth={1.75} />
          )}
        </button>
      </header>

      {/* ── Body row ───────────────────────────────────────────── */}
      <div className="flex flex-1">
        {/* ── Sidebar (desktop only) ───────────────────────────── */}
        <aside
          className="hidden md:flex flex-col sticky top-14 flex-shrink-0 overflow-y-auto"
          style={{
            width: 240,
            height: "calc(100vh - 3.5rem)",
            background: "var(--surface)",
            borderRight: "1px solid var(--border)",
          }}
        >
          {/* Nav groups */}
          <nav className="flex-1 p-3 space-y-3 overflow-y-auto">
            {navGroups.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && (
                  <div
                    className="my-2"
                    style={{ height: 1, background: "var(--border)" }}
                  />
                )}
                {group.groupLabel && (
                  <p className="eyebrow px-3 py-1.5">{group.groupLabel}</p>
                )}
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <NavLink key={item.href} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </nav>

          {/* Account block — identity + settings + logout */}
          <div style={{ borderTop: "1px solid var(--border)" }}>
            <AccountBlock
              profile={profile}
              logoutAction={logoutAction}
            />
          </div>
        </aside>

        {/* ── Main content ─────────────────────────────────────── */}
        <main
          className="flex-1 min-w-0"
          style={{ paddingBottom: isEmployee ? "4rem" : undefined }}
        >
          {children}
        </main>
      </div>

      {/* ── Bottom bar (employees · mobile only) ─────────────── */}
      {isEmployee && (
        <nav
          className="fixed bottom-0 left-0 right-0 flex md:hidden z-40 h-16"
          style={{
            background: "var(--surface)",
            borderTop: "1px solid var(--border)",
            boxShadow: "0 -1px 6px 0 rgb(0 0 0 / 0.06)",
          }}
        >
          {bottomItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex-1 flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors"
                style={
                  active
                    ? { color: "var(--brand-strong)" }
                    : { color: "var(--fg-muted)" }
                }
              >
                <item.Icon size={20} strokeWidth={active ? 2.25 : 1.75} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}

export function AppShellClient(props: AppShellClientProps) {
  return <AppShellInner {...props} />;
}
