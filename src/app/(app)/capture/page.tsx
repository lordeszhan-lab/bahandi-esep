import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CaptureFlow } from "@/components/capture/capture-flow";
import { APP_NAME } from "@/lib/brand";
import type { Employee, Location, ReasonCode } from "@/lib/db/types";

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

  const { data: rawLocations } = await supabase
    .from("locations")
    .select("id, name, lat, lng, geofence_radius_m")
    .order("name");

  const locations = (rawLocations ?? []) as Pick<
    Location,
    "id" | "name" | "lat" | "lng" | "geofence_radius_m"
  >[];

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

  return (
    <CaptureFlow
      profile={profile}
      reasonCodes={reasonCodes}
      locations={locations}
      materialLiabilityEmployees={materialLiabilityEmployees}
    />
  );
}
