"use server";

import { createClient } from "@/lib/supabase/server";
import type { Employee } from "@/lib/db/types";

export async function getMaterialLiabilityEmployees(
  locationId: string,
): Promise<Employee[]> {
  const supabase = await createClient();

  const { data: raw } = await supabase
    .from("employees")
    .select("*")
    .eq("location_id", locationId)
    .eq("material_liability", true)
    .order("full_name");

  return (raw ?? []) as Employee[];
}
