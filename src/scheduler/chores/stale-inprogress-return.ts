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

import { getBacklogLaneWithScores } from "../../redis/backlog.ts";
import { returnInProgressItemToQueued } from "../../backlog/wip.ts";

const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000; // 24 hours

/** External touchpoints of the stale-inProgress return chore. */
export interface ReturnStaleInProgressItemsDeps {
  getBacklogLaneWithScores?: typeof getBacklogLaneWithScores;
  /**
   * Return one `inProgress` item (by id) to `queued`. Defaults to the
   * backlog-module `returnInProgressItemToQueued`, which runs the write through
   * the atomic seam (`applyAtomicLaneTransition`) AND clears the claim fields
   * via `applyLaneTransition` (issue #2582). Returns the moved item, or `null`
   * if it was already handled / no longer in `inProgress`.
   */
  returnInProgressItemToQueued?: typeof returnInProgressItemToQueued;
  now?: () => number;
}

/**
 * Return backlog items stuck in the `inProgress` lane for > 24h back to
 * `queued`. Naturally idempotent: each invocation re-checks item age.
 *
 * The lane mutation itself is delegated to the backlog module's
 * `returnInProgressItemToQueued` (issue #2582) so it goes through the atomic
 * write-commit seam and clears the item's stale `claimedAt` / `claimedBy`
 * fields — the chore's earlier inline `item.lane = "queued"` +
 * `moveBacklogItem` path did neither.
 */
export async function returnStaleInProgressItems(
  deps: ReturnStaleInProgressItemsDeps = {},
): Promise<void> {
  const getBacklogLaneWithScoresFn = deps.getBacklogLaneWithScores ?? getBacklogLaneWithScores;
  const returnInProgressItemToQueuedFn = deps.returnInProgressItemToQueued ?? returnInProgressItemToQueued;
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
        const item = await returnInProgressItemToQueuedFn(
          id,
          { returnedReason: "stale_in_progress", returnedAt: new Date(now).toISOString() },
          now,
        );
        if (!item) continue;
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
