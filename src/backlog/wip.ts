/**
 * WIP (Work-In-Progress) limit — prevent starting new work when too many
 * items are already in-progress. Forces the system to finish existing work.
 *
 * Stale-inProgress reclamation lives elsewhere: the stale-claim reaper in
 * ./reaper.ts watches `claimedAt` (ISO timestamp, stamped on every
 * move-into-inProgress) and reclaims items whose claimant died — the "agent
 * died mid-claim and left a wedged WIP slot" pattern (issue #374) at 2h
 * precision; the housekeeping stale-inProgress return chore
 * (`src/scheduler/chores/stale-inprogress-return.ts`) returns items stuck in
 * `inProgress` for >24h back to `queued`. The prior `startedAt`/7-day
 * `requeueStaleInProgressItems` export lived here but had no production caller
 * and was removed (issue #2583) as a dead export.
 */

import { getBacklogLaneCount } from "../redis/backlog.ts";
import { WIP_LIMIT, getLaneItems } from "./internal.ts";

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
