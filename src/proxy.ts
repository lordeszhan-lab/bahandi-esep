/**
 * Next.js 16 Proxy — the single source of truth for auth + RBAC.
 *
 * Rules:
 *   - Public  : /login, /auth/callback  (redirect logged-in users to their home)
 *   - API     : /api/**                 (401 when unauthenticated)
 *   - Root    : /                       (redirect to role home)
 *   - App     : /capture, /my, /review, /admin — cross-role access redirects to home (admin bypasses)
 *
 * Role guard lives here only — pages are unguarded by design.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database, UserRole } from "@/lib/db/types";

// ── Route tables ──────────────────────────────────────────────────────────────

const PUBLIC_PATHS = new Set(["/login", "/auth/callback"]);

/** Default landing page for each role. */
const ROLE_HOME: Record<UserRole, string> = {
  employee: "/capture",
  reviewer: "/review",
  admin:    "/admin",
};

/** Path prefixes a role is allowed to visit. */
const ROLE_PREFIXES: Record<UserRole, string[]> = {
  employee: ["/capture", "/my"],
  reviewer: ["/review"],
  admin:    ["/admin"],
};

// ── Supabase client bound to the current request/response pair ────────────────

function buildClient(request: NextRequest) {
  /**
   * `response` is reassigned inside setAll so the proxy always returns
   * the latest response object (carrying the refreshed session cookie).
   */
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) => {
          // Sync new cookies into the mutated request so getUser can read them
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          // Rebuild response with the updated request, then attach cookie headers
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  return { supabase, getResponse: () => response };
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const { supabase, getResponse } = buildClient(request);

  // getUser validates the JWT with Supabase servers and refreshes it when needed
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Lazy, memoised role fetch — at most one DB query per request
  let _role: UserRole | undefined;
  async function getRole(): Promise<UserRole> {
    if (_role) return _role;
    const { data: rawProfile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user!.id)
      .single();
    // Explicit cast: supabase-js v2 inference can resolve to `never` with __InternalSupabase marker
    const profileRow = rawProfile as { role: string } | null;
    _role = (profileRow?.role as UserRole | undefined) ?? "employee";
    return _role;
  }

  // ── Public paths ──────────────────────────────────────────────────────────
  if (PUBLIC_PATHS.has(pathname)) {
    if (user) {
      // Already authenticated → skip login screen
      const role = await getRole();
      return NextResponse.redirect(new URL(ROLE_HOME[role], request.url));
    }
    return getResponse();
  }

  // ── API routes ────────────────────────────────────────────────────────────
  if (pathname.startsWith("/api/")) {
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return getResponse();
  }

  // ── Must be authenticated beyond this point ───────────────────────────────
  if (!user) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const role = await getRole();
  const home = ROLE_HOME[role];

  // ── Root → role home ──────────────────────────────────────────────────────
  if (pathname === "/") {
    return NextResponse.redirect(new URL(home, request.url));
  }

  // ── Cross-role guard ──────────────────────────────────────────────────────
  // admin = superuser preview; tighten before real prod if needed
  if (role !== "admin") {
    const allowed = ROLE_PREFIXES[role] ?? [];
    if (!allowed.some((p) => pathname.startsWith(p))) {
      return NextResponse.redirect(new URL(home, request.url));
    }
  }

  return getResponse();
}

export const config = {
  matcher: [
    // Exclude static assets, the service worker, the web manifest, and the
    // offline shell from the auth proxy:
    //   - /sw.js must be served as a plain static script (the browser would
    //     otherwise follow a login redirect and fail to register the SW);
    //   - /manifest.webmanifest + /offline must be reachable unauthenticated
    //     so the SW can precache the offline shell on install and the manifest
    //     is available for Add to Home Screen from the login page (P23.1).
    "/((?!_next/static|_next/image|favicon\\.ico|sw\\.js|offline|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
