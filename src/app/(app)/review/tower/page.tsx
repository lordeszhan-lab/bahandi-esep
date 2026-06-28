/**
 * Tower page — the network control tower (Prompt C).
 *
 * Server Component. Reads the range preset from the URL (`?range=14`), loads the
 * whole Tower payload in one `tower_analytics` RPC round trip, plus the first +
 * second half of the window so the KPI cards get a half-over-half trend. Hands
 * the typed payload to the `TowerView` client component. Employees are redirected
 * to capture — the Tower is reviewer/admin only.
 */

import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { loadTowerAnalytics, loadTowerFilterOptions } from "@/lib/analytics/tower";
import { TowerView, type TowerTrends } from "@/components/tower/tower-view";
import { pctChange, type Trend } from "@/components/tower/format";
import { APP_NAME } from "@/lib/brand";
import type { TowerKpis } from "@/lib/analytics/types";

export const metadata = { title: `Башня · ${APP_NAME}` };
export const dynamic = "force-dynamic";

const ALLOWED_RANGES = [7, 14, 30];
const DEFAULT_RANGE = 14;

function parseRange(v?: string): number {
  const n = v ? Number(v) : DEFAULT_RANGE;
  return ALLOWED_RANGES.includes(n) ? n : DEFAULT_RANGE;
}

export default async function TowerPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.role === "employee") redirect("/capture");

  const sp = await searchParams;
  const rangeDays = parseRange(sp.range);

  const toMs = Date.now();
  const fromMs = toMs - rangeDays * 86_400_000;
  const midMs = fromMs + (toMs - fromMs) / 2;
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const mid = new Date(midMs).toISOString();

  // Full window for display + first/second half for KPI trends (one RPC each).
  const [analytics, firstHalf, secondHalf, filters] = await Promise.all([
    loadTowerAnalytics({ from, to }),
    loadTowerAnalytics({ from, to: mid }),
    loadTowerAnalytics({ from: mid, to }),
    loadTowerFilterOptions(),
  ]);

  const trends = buildTrends(firstHalf.kpis, secondHalf.kpis);

  return (
    <TowerView
      analytics={analytics}
      filters={filters}
      trends={trends}
      rangeDays={rangeDays}
      from={from}
      to={to}
    />
  );
}

/** Half-over-half trends: second half vs first half, with good-direction per KPI. */
function buildTrends(prev: TowerKpis, curr: TowerKpis): TowerTrends {
  const t = (prevV: number, currV: number, positiveIsGood: boolean): Trend => ({
    deltaPct: pctChange(prevV, currV),
    positiveIsGood,
  });
  return {
    totalLoss: t(prev.totalLoss, curr.totalLoss, false),
    fraudCaughtValue: t(prev.fraudCaughtValue, curr.fraudCaughtValue, true),
    recoveredValue: t(prev.recoveredValue, curr.recoveredValue, true),
    unexplainedGap: t(prev.unexplainedGap, curr.unexplainedGap, false),
  };
}
