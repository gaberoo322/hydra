/**
 * Stale-inProgress return chore (issue #1876).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 *
 * Folded out of the cleanup.ts module-level 24h `setInterval` into a
 * housekeeping chore (#1876). `returnStaleInProgressItems` is naturally
 * idempotent (it re-checks each item's age every call) so it has no Redis
 * time-guard.
 */

import {
  getBacklogLaneWithScores,
  getBacklogItem,
  moveBacklogItem,
} from "../../redis/backlog.ts";

const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000; // 24 hours

/** External touchpoints of the stale-inProgress return chore. */
export interface ReturnStaleInProgressItemsDeps {
  getBacklogLaneWithScores?: typeof getBacklogLaneWithScores;
  getBacklogItem?: typeof getBacklogItem;
  moveBacklogItem?: typeof moveBacklogItem;
  now?: () => number;
}

/**
 * Return backlog items stuck in the `inProgress` lane for > 24h back to
 * `queued`. The same body that ran on the cleanup.ts timer. Naturally
 * idempotent: each invocation re-checks item age.
 */
export async function returnStaleInProgressItems(
  deps: ReturnStaleInProgressItemsDeps = {},
): Promise<void> {
  const getBacklogLaneWithScoresFn = deps.getBacklogLaneWithScores ?? getBacklogLaneWithScores;
  const getBacklogItemFn = deps.getBacklogItem ?? getBacklogItem;
  const moveBacklogItemFn = deps.moveBacklogItem ?? moveBacklogItem;
  const nowFn = deps.now ?? Date.now;
  try {
    const ids = await getBacklogLaneWithScoresFn("inProgress");
    const now = nowFn();
    let returned = 0;

    // ids is [id1, score1, id2, score2, ...]
    for (let i = 0; i < ids.length; i += 2) {
      const id = ids[i];
      const score = Number(ids[i + 1]);
      if (now - score > STALE_IN_PROGRESS_MS) {
        const raw = await getBacklogItemFn(id);
        if (!raw) continue;
        const item = JSON.parse(raw);
        item.lane = "queued";
        item.meta = { ...item.meta, returnedReason: "stale_in_progress", returnedAt: new Date().toISOString() };
        await moveBacklogItemFn(id, JSON.stringify(item), "inProgress", "queued");
        returned++;
        console.log(`[Housekeeping] Returned stale inProgress item ${id} ("${item.title?.slice(0, 60)}") to queued`);
      }
    }

    if (returned > 0) {
      console.log(`[Housekeeping] Returned ${returned} stale inProgress items to queued`);
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Stale inProgress check failed: ${err.message}`);
  }
}
