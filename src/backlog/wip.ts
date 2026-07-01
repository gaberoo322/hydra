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
import {
  WIP_LIMIT, getItem, saveItem, getLaneItems,
} from "./internal.ts";
import { moveItemToLane } from "./lanes.ts";

export { WIP_LIMIT };

/**
 * Return a single `inProgress` item (by id) to the `queued` lane through the
 * canonical `moveItemToLane` boundary (issue #2582).
 *
 * This is the backlog-module boundary for the housekeeping stale-inProgress
 * return chore (`src/scheduler/chores/stale-inprogress-return.ts`). Routing the
 * chore's lane mutation through the backlog module's `moveItemToLane` — rather
 * than the pre-#1990 non-atomic `redis/backlog.ts:moveBacklogItem` (raw
 * sequential HSET+ZREM+ZADD) — buys two invariants the chore's inline mutation
 * lacked, both of which `moveItemToLane` already guarantees for a `→ queued`
 * move:
 *
 *  1. **Atomic write-commit** — `moveItemToLane` commits via
 *     `applyAtomicLaneTransition`, running {ZREM lanes, HSET item, ZADD queued}
 *     as one Lua step, so a crash / Redis restart can never observe a half-write
 *     where `item.lane` (canonical hash) disagrees with zset membership (the
 *     #1990 "phantom done" class of bug).
 *  2. **Claim fields cleared** — `moveItemToLane` runs `applyLaneTransition`
 *     internally, which nulls `claimedAt` + `claimedBy` on any transition that
 *     is NOT into `inProgress`, so the stale-claims reaper, in-flight-PR
 *     suppression, and WIP counters don't observe corrupted claim state on a
 *     returned item.
 *
 * The caller owns the *decision* (which items are stale, on what age signal)
 * and stamps its own `meta` (e.g. `returnedReason`); this function owns the
 * *mutation*. Because `moveItemToLane` re-reads the item by id, the supplied
 * `meta` must be persisted with `saveItem` BEFORE the move so the stamp
 * survives that re-read. Returns the mutated item on success, or `null` when
 * the id is missing or no longer in `inProgress` (idempotent — a concurrent
 * move already handled it).
 */
export async function returnInProgressItemToQueued(
  id: string,
  meta: Record<string, unknown> = {},
  now: number = Date.now(),
): Promise<any | null> {
  const item = await getItem(id);
  if (!item || item.lane !== "inProgress") return null;
  // Persist the caller's meta stamp first: moveItemToLane re-reads the item by
  // id, so an un-saved in-memory meta merge would be lost on that re-read.
  item.meta = { ...item.meta, ...meta };
  await saveItem(item);
  const res = await moveItemToLane(id, "queued", {}, now);
  if (!res.ok) return null;
  // Re-read to return the item exactly as persisted by the atomic move
  // (lane=queued, claimedAt/claimedBy nulled, meta stamp intact).
  return await getItem(id);
}

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
