import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CaptureFlow } from "@/components/capture/capture-flow";
import { APP_NAME } from "@/lib/brand";
import type { Employee, ReasonCode } from "@/lib/db/types";

export const metadata = { title: `Фиксация списания · ${APP_NAME}` };

export default async function CapturePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();

  // Load reason codes
  const { data: rawReasonCodes } = await supabase
    .from("reason_codes")
    .select("*")
    .order("category");

  const reasonCodes = (rawReasonCodes ?? []) as ReasonCode[];

  // Load material-liability employees at this location
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
      materialLiabilityEmployees={materialLiabilityEmployees}
    />
  );
}
