/**
 * Review Cockpit page — Prompt 12.
 *
 * Server Component. Loads the reviewer's context-rich queue (risky first, full
 * per-item context) and hands it to the interactive `ReviewQueue` client
 * component. The reviewer triages the queue with full context and decides in
 * one tap; the page itself is read-only server rendering.
 */

import { getCurrentProfile } from "@/lib/auth";
import { loadReviewQueue } from "@/lib/review/queue";
import { ReviewQueue } from "@/components/review/review-queue";
import { APP_NAME } from "@/lib/brand";

export const metadata = { title: `Проверка списаний · ${APP_NAME}` };
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const profile = await getCurrentProfile();
  const queue = await loadReviewQueue(profile!);

  return <ReviewQueue items={queue.items} total={queue.total} />;
}
