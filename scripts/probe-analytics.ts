/* Throwaway probe — isolates which analytics function throws. */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createServiceClient } from "../src/lib/supabase/service";

async function callRpc(s: ReturnType<typeof createServiceClient>, name: string) {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const r = await s.rpc(name as never, { p_from: from, p_to: to } as never);
  if (r.error) {
    console.log(`${name}: ERR ${r.error.message}`);
  } else {
    const d = r.data as unknown;
    const len = Array.isArray(d) ? d.length : Object.keys(d ?? {}).length;
    console.log(`${name}: OK (${len})`);
  }
}

async function main() {
  const s = createServiceClient();
  for (const fn of [
    "network_kpis",
    "per_store_metrics",
    "per_format_metrics",
    "per_city_metrics",
    "per_cluster_metrics",
    "tower_analytics",
  ]) {
    await callRpc(s, fn);
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
