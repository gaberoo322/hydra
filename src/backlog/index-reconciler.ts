/**
 * Backlog lane-index reconciler (issue #2056).
 *
 * SOURCE OF TRUTH: the items hash (`hydra:backlog:items`) is canonical for
 * membership, and the `item.lane` field is canonical for WHICH lane. The lane
 * sorted sets (`hydra:backlog:lane:{lane}`) are a derived, REBUILDABLE index.
 * This direction is forced by the restart failure mode (#1990): a transition
 * writes the hash first (`HSET`) and the zset second (`ZADD`), so a crash /
 * Redis restart can lose a zset entry while the hash item survives. The
 * authoritative side is therefore the hash; the index is repaired FROM it,
 * never the reverse.
 *
 * Reconciliation is INDEX REPAIR, not a lane TRANSITION. It makes the zsets
 * agree with an unchanged `item.lane`; it does NOT change `item.lane`. So it
 * deliberately does NOT route through `moveItemToLane` / `applyLaneTransition`
 * — those rewrite `movedAt`, clear claim fields, and re-run the #1920
 * blocked-reason guard, all of which would be wrong for an item that never
 * moved. The CLAUDE.md "lane mutations go through moveItemToLane" rule governs
 * transitions; index repair is exempt.
 *
 * The two repair directions:
 *   - A hash item with a valid `item.lane` that is missing from its lane zset
 *     is RE-INDEXED (`ZADD` at the item's `movedAt`/`claimedAt` timestamp, so
 *     queue ordering is preserved as closely as the surviving metadata allows).
 *   - A zset member whose id has no surviving hash entry is an ORPHAN and is
 *     removed (`ZREM`).
 *
 * Items whose `item.lane` is absent or not a known lane are TOLERATED: counted
 * (and surfaced via `GET /api/backlog/audit`), never dropped and never guessed
 * into a lane — that is policy, not index repair.
 *
 * NEVER-THROW + IDEMPOTENT: this is a verification/repair path, so it returns a
 * result object and never throws (CLAUDE.md). Per-item parse/Redis failures are
 * logged and skipped — one bad item never aborts the sweep. A second immediate
 * run on a healthy board is a guaranteed no-op, so as a housekeeping chore it
 * needs no time-guard (mirrors `returnStaleInProgressItems`). The same function
 * runs at startup and hourly with identical self-healing semantics.
 *
 * Lua-atomic transition moves (closing the 3-step crash window itself) are a
 * SEPARATE issue — this module is the load-bearing self-heal that repairs any
 * half-write on the next boot/hour regardless of cause.
 */

import {
  getAllBacklogItems,
  getBacklogLaneIds,
  addToBacklogLane,
  removeFromBacklogLane,
} from "../redis/backlog.ts";
import { LANES } from "./internal.ts";

export interface ReconcileResult {
  /** Hash items re-added (ZADD) to a lane zset they were missing from. */
  reindexed: number;
  /** Zset members removed (ZREM) because no hash entry survives for the id. */
  orphansRemoved: number;
  /** Total hash items scanned. */
  scanned: number;
  /** Hash items with an absent / unknown `item.lane` — counted, left in place. */
  unLaned: number;
}

/**
 * Pick the score (sort position) to re-index a recovered item at. Prefer the
 * item's own timing metadata so queue ordering survives the repair; fall back
 * to `Date.now()` (puts it at the tail) when no usable timestamp exists.
 */
function reindexScore(item: any): number {
  const candidate = item?.movedAt ?? item?.claimedAt ?? item?.meta?.addedAt;
  if (candidate) {
    const parsed = new Date(candidate).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * Reconcile the lane sorted-set indices against the canonical items hash.
 *
 * Repairs the index FROM the hash in both directions (re-add missing members,
 * remove orphans). Never throws; returns a `{ reindexed, orphansRemoved,
 * scanned, unLaned }` summary. A no-op on a healthy board.
 */
export async function reconcileLaneIndices(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    reindexed: 0,
    orphansRemoved: 0,
    scanned: 0,
    unLaned: 0,
  };

  let rawItems: Record<string, string>;
  try {
    rawItems = await getAllBacklogItems();
  } catch (err: any) {
    console.error(`[IndexReconciler] Failed to read items hash: ${err.message}`);
    return result;
  }

  // Parse the hash once. `liveIds` is the set of ids that survive in the hash —
  // the orphan pass below removes any zset member NOT in this set.
  const liveIds = new Set<string>();
  // Per-lane membership, fetched lazily and cached so we only hit each lane zset
  // once during the re-index pass.
  const laneMembers = new Map<string, Set<string>>();

  async function membersOf(lane: string): Promise<Set<string>> {
    let cached = laneMembers.get(lane);
    if (cached) return cached;
    const ids = await getBacklogLaneIds(lane);
    cached = new Set(ids);
    laneMembers.set(lane, cached);
    return cached;
  }

  // Pass 1: re-index — every hash item with a valid lane must be in that lane's
  // zset. Build `liveIds` as we go.
  for (const [id, raw] of Object.entries(rawItems)) {
    result.scanned++;
    liveIds.add(id);

    let item: any;
    try {
      item = JSON.parse(raw);
    } catch (err: any) {
      // A malformed hash entry can't tell us its lane; it still counts as a live
      // id (so it is never orphan-removed from a zset) but is otherwise tolerated.
      console.error(`[IndexReconciler] Skipping unparseable item ${id}: ${err.message}`);
      result.unLaned++;
      continue;
    }

    const lane = item?.lane;
    if (typeof lane !== "string" || !LANES.includes(lane)) {
      // Un-laned / unknown-lane item: tolerate, count, never guess a lane.
      result.unLaned++;
      continue;
    }

    try {
      const present = await membersOf(lane);
      if (!present.has(id)) {
        await addToBacklogLane(lane, reindexScore(item), id);
        present.add(id);
        result.reindexed++;
        console.log(`[IndexReconciler] Re-indexed ${id} into lane "${lane}"`);
      }
    } catch (err: any) {
      console.error(`[IndexReconciler] Failed to re-index ${id} into "${lane}": ${err.message}`);
    }
  }

  // Pass 2: orphan removal — every zset member whose id has no surviving hash
  // entry is removed. Walk all known lanes (reuse the cached membership where we
  // already fetched it; fetch the rest).
  for (const lane of LANES) {
    let members: Set<string>;
    try {
      members = await membersOf(lane);
    } catch (err: any) {
      console.error(`[IndexReconciler] Failed to read lane "${lane}" for orphan sweep: ${err.message}`);
      continue;
    }
    for (const id of members) {
      if (liveIds.has(id)) continue;
      try {
        await removeFromBacklogLane(lane, id);
        result.orphansRemoved++;
        console.log(`[IndexReconciler] Removed orphan ${id} from lane "${lane}"`);
      } catch (err: any) {
        console.error(`[IndexReconciler] Failed to remove orphan ${id} from "${lane}": ${err.message}`);
      }
    }
  }

  if (result.reindexed > 0 || result.orphansRemoved > 0) {
    console.log(
      `[IndexReconciler] Reconciled lane indices: re-indexed ${result.reindexed}, removed ${result.orphansRemoved} orphan(s) (scanned ${result.scanned}, ${result.unLaned} un-laned)`,
    );
  }

  return result;
}

/**
 * Read-only audit of the items hash vs. the lane sorted-set indices (issue
 * #2056). Returns the divergences `reconcileLaneIndices()` would repair, WITHOUT
 * mutating anything — the diagnostics backing `GET /api/backlog/audit`.
 */
export interface BacklogAuditResult {
  /** Number of items in the canonical hash. */
  hashCount: number;
  /** Cardinality of each lane sorted set. */
  zsetCounts: Record<string, number>;
  /** Ids present in the hash with a valid lane but MISSING from that lane zset. */
  missingFromIndex: { id: string; lane: string }[];
  /** Zset members whose id has no surviving hash entry (would be ZREM'd). */
  orphanZsetEntries: { id: string; lane: string }[];
  /** Hash items with an absent / unknown `item.lane` — left in place by repair. */
  unLaned: string[];
}

export async function auditLaneIndices(): Promise<BacklogAuditResult> {
  const audit: BacklogAuditResult = {
    hashCount: 0,
    zsetCounts: {},
    missingFromIndex: [],
    orphanZsetEntries: [],
    unLaned: [],
  };

  const rawItems = await getAllBacklogItems();
  const liveIds = new Set<string>();
  const laneById = new Map<string, string>();

  for (const [id, raw] of Object.entries(rawItems)) {
    audit.hashCount++;
    liveIds.add(id);
    let item: any;
    try {
      item = JSON.parse(raw);
    } catch {
      audit.unLaned.push(id);
      continue;
    }
    const lane = item?.lane;
    if (typeof lane !== "string" || !LANES.includes(lane)) {
      audit.unLaned.push(id);
      continue;
    }
    laneById.set(id, lane);
  }

  for (const lane of LANES) {
    const ids = await getBacklogLaneIds(lane);
    audit.zsetCounts[lane] = ids.length;
    const present = new Set(ids);

    // Orphans: zset members with no surviving hash entry.
    for (const id of ids) {
      if (!liveIds.has(id)) audit.orphanZsetEntries.push({ id, lane });
    }

    // Missing-from-index: hash items that belong in this lane but aren't here.
    for (const [id, itemLane] of laneById) {
      if (itemLane === lane && !present.has(id)) {
        audit.missingFromIndex.push({ id, lane });
      }
    }
  }

  return audit;
}
