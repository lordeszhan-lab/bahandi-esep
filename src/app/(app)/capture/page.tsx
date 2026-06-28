import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CaptureFlow } from "@/components/capture/capture-flow";
import { APP_NAME } from "@/lib/brand";
import type { Employee, Store, ReasonCode } from "@/lib/db/types";

export const metadata = { title: `Фиксация списания · ${APP_NAME}` };

export default async function CapturePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();

  const { data: rawReasonCodes } = await supabase
    .from("reason_codes")
    .select("*")
    .order("category");

  const reasonCodes = (rawReasonCodes ?? []) as ReasonCode[];

  // Employees capture against their ASSIGNED branch (profile.location) — they
  // never see the store network. Only the admin session picker needs the full
  // list, so fetch it for admins only.
  let materialLiabilityEmployees: Employee[] = [];
  if (profile.location_id) {
    const { data: rawEmployees } = await supabase
      .from("employees")
      .select("*")
      .eq("location_id", profile.location_id)
      .eq("material_liability", true)
      .order("full_name");
    materialLiabilityEmployees = (rawEmployees ?? []) as Employee[];
  }

  const stores =
    profile.role === "admin"
      ? ((await supabase
          .from("stores")
          .select("id, name, display_name, city, lat, lng, geofence_radius_m")
          .order("city", { ascending: true })
          .order("name", { ascending: true })).data ??
        []) as Pick<
          Store,
          "id" | "name" | "display_name" | "city" | "lat" | "lng" | "geofence_radius_m"
        >[]
      : [];

  return (
    <CaptureFlow
      profile={profile}
      reasonCodes={reasonCodes}
      stores={stores}
      materialLiabilityEmployees={materialLiabilityEmployees}
    />
  );
}
