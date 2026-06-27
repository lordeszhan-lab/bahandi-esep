/**
 * AppShell — Server Component wrapper.
 *
 * Fetches the current profile and injects a server-action logout
 * into the interactive AppShellClient.
 */

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { AppShellClient } from "./app-shell-client";
import type { Location } from "@/lib/db/types";

export default async function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getCurrentProfile();

  // Proxy already guards, but redirect as defense-in-depth
  if (!profile) redirect("/login");

  let devLocations: Pick<Location, "id" | "name">[] = [];
  if (process.env.NODE_ENV !== "production") {
    const supabase = await createClient();
    const { data: rawLocations } = await supabase
      .from("locations")
      .select("id, name")
      .order("name");
    devLocations = (rawLocations ?? []) as Pick<Location, "id" | "name">[];
  }

  async function logoutAction(_formData: FormData) {
    "use server";
    const supabase = await createClient();
    await supabase.auth.signOut();
    redirect("/login");
  }

  return (
    <AppShellClient
      profile={profile}
      logoutAction={logoutAction}
      devLocations={devLocations}
    >
      {children}
    </AppShellClient>
  );
}
