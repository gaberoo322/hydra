/**
 * WIP (Work-In-Progress) limit — prevent starting new work when too many
 * items are already in-progress. Forces the system to finish existing work.
 *
 * Distinct from the stale-claim reaper in ./reaper.ts. This file watches
 * `meta.startedAt` (date precision) and reclaims items the system has been
 * chewing on for >7 days. The reaper watches `claimedAt` (ISO timestamp,
 * stamped on every move-into-inProgress) and targets the "agent died
 * mid-claim and left a wedged WIP slot" pattern (issue #374) at 2h precision.
 */

import {
  addToBacklogLane, removeFromBacklogLane, getBacklogLaneIds, getBacklogLaneCount,
} from "../redis-adapter.ts";
import {
  WIP_LIMIT, applyLaneTransition, getItem, saveItem, getLaneItems,
} from "./internal.ts";

const STALE_IN_PROGRESS_DAYS = parseInt(process.env.HYDRA_STALE_IN_PROGRESS_DAYS) || 7;

export { WIP_LIMIT };

export async function getInProgressCount() {
  return await getBacklogLaneCount("inProgress");
}

export async function getInProgressItems() {
  return await getLaneItems("inProgress");
}

/**
 * Check if the WIP limit has been reached.
 * When true, the anchor selector should prefer completing existing work
 * over starting new items from the queue.
 */
export async function isWipLimitReached() {
  const count = await getInProgressCount();
  return { atLimit: count >= WIP_LIMIT, count, limit: WIP_LIMIT };
}

/**
 * Requeue in-progress items that have been stale for >STALE_IN_PROGRESS_DAYS
 * with no recent activity (based on startedAt timestamp).
 */
export async function requeueStaleInProgressItems() {
  const ids = await getBacklogLaneIds("inProgress");
  const now = Date.now();
  const cutoffMs = STALE_IN_PROGRESS_DAYS * 24 * 60 * 60 * 1000;
  const requeued: any[] = [];

  for (const id of ids) {
    const item = await getItem(id);
    if (!item) continue;

    const startedAt = item.meta?.startedAt;
    if (!startedAt) continue;

    const startedMs = new Date(startedAt).getTime();
    if (!Number.isFinite(startedMs)) continue;

    const ageMs = now - startedMs;
    if (ageMs > cutoffMs) {
      await removeFromBacklogLane("inProgress", id);
      item.meta = {
        ...item.meta,
        requeuedAt: new Date().toISOString().split("T")[0],
        requeueReason: `Stale in-progress for ${Math.round(ageMs / (24 * 60 * 60 * 1000))} days (WIP limit enforcement)`,
      };
      applyLaneTransition(item, "queued");
      await saveItem(item);
      await addToBacklogLane("queued", Date.now(), id);
      requeued.push(item);
      console.log(`[Backlog] Requeued stale inProgress item ${id} ("${item.title?.slice(0, 60)}") — ${Math.round(ageMs / (24 * 60 * 60 * 1000))} days old`);
    }
  }

  return requeued;
}
