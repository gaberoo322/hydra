/**
 * Backlog Redis ops. Extracted from redis-adapter.ts (issue #269).
 *
 * NOTE: This is the low-level Redis backlog adapter, not the higher-level
 * Backlog Module (src/backlog/) which uses these primitives. Naming kept
 * to satisfy issue #269's acceptance criteria.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Get backlog lane entries with scores (for stale-check).
 * Returns [id1, score1, id2, score2, ...].
 */
export async function getBacklogLaneWithScores(lane: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.backlogLane(lane), 0, -1, "WITHSCORES");
}

/**
 * Get a backlog item by ID.
 */
export async function getBacklogItem(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.backlogItems(), id);
}

/**
 * Get the entire backlog items hash as an `id → raw JSON string` map (issue
 * #2056). HGETALL over `hydra:backlog:items` — the typed hash-scan accessor the
 * lane-index reconciler uses to read the canonical item set behind the Redis
 * seam (ADR-0017 Category A: shared domain state, so the scan MUST live here,
 * not as a raw `getRedisConnection()` HSCAN inside the reconciler). The items
 * hash is the source of truth; the lane sorted sets are a rebuildable index, so
 * the reconciler walks this map to repair the index FROM the hash.
 */
export async function getAllBacklogItems(): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.backlogItems());
}

/**
 * Update a backlog item and move it between lanes atomically.
 */
export async function moveBacklogItem(
  id: string,
  itemJson: string,
  fromLane: string,
  toLane: string,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.backlogItems(), id, itemJson);
  await r.zrem(redisKeys.backlogLane(fromLane), id);
  await r.zadd(redisKeys.backlogLane(toLane), Date.now(), id);
}

/** Increment the backlog counter and return new ID. */
export async function incrBacklogCounter(): Promise<string> {
  const r = getRedisConnection();
  const id = await r.incr(redisKeys.backlogCounter());
  return `item-${id}`;
}

/** Get a backlog item by ID (raw JSON string). */
export async function getBacklogItemRaw(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.backlogItems(), id);
}

/** Save a backlog item. */
export async function saveBacklogItem(id: string, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.backlogItems(), id, json);
}

/** Delete a backlog item from hash and all lane sorted sets. */
export async function removeBacklogItem(id: string, lanes: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.hdel(redisKeys.backlogItems(), id);
  for (const lane of lanes) {
    await r.zrem(redisKeys.backlogLane(lane), id);
  }
}

// ---------------------------------------------------------------------------
// By-title secondary index (issue #2500): hydra:backlog:title-index — a Hash
// mapping exact `item.title` → itemId. The four title-based lane mutations in
// src/backlog/lanes.ts (moveToInProgress / moveToDone / blockByTitle /
// returnToBacklog) used to scan whole lanes (one HGET per item) to resolve an
// id from a title; with this index they do a single HGET. The items hash stays
// canonical — this index is a derived, rebuildable view (the lane-index
// reconciler repairs it FROM the hash), exactly like the lane zsets.
//
// Title equality is the existing exact, case-sensitive `item.title === title`
// match; the index key is the raw title string, so no normalisation is applied.
// ---------------------------------------------------------------------------

/** Resolve an itemId from the by-title index. Returns null on a miss. */
export async function getBacklogItemIdByTitle(title: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.backlogTitleIndex(), title);
}

/** Point the by-title index at `id` for `title` (create / title-change). */
export async function setBacklogTitleIndex(title: string, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.backlogTitleIndex(), title, id);
}

/**
 * Remove a title→id entry from the index, but only if it still points at `id`
 * (compare-and-delete). A different live item may have claimed the same title
 * since this id was created; deleting unconditionally would orphan that item's
 * lookup. Owned here because the index key is owned by this seam (ADR-0017).
 */
export async function clearBacklogTitleIndex(title: string, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.eval(
    LUA_CLEAR_TITLE_INDEX_IF_MATCH,
    1,
    redisKeys.backlogTitleIndex(),
    title,
    id,
  );
}

const LUA_CLEAR_TITLE_INDEX_IF_MATCH = `
-- KEYS[1] = hydra:backlog:title-index
-- ARGV[1] = title (hash field)
-- ARGV[2] = expected id
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

/**
 * Overwrite the entire by-title index from a fresh `title → id` map (issue
 * #2500) — the lane-index reconciler's rebuild step. DEL the old index then
 * HSET the new entries in one atomic Lua step so a reader never observes an
 * empty index mid-rebuild. ARGV is a flat [title1, id1, title2, id2, ...] list.
 */
export async function rebuildBacklogTitleIndex(titleToId: Record<string, string>): Promise<void> {
  const r = getRedisConnection();
  const flat: string[] = [];
  for (const [title, id] of Object.entries(titleToId)) {
    flat.push(title, id);
  }
  await r.eval(
    LUA_REBUILD_TITLE_INDEX,
    1,
    redisKeys.backlogTitleIndex(),
    ...flat,
  );
}

const LUA_REBUILD_TITLE_INDEX = `
-- KEYS[1] = hydra:backlog:title-index
-- ARGV    = flat [title1, id1, title2, id2, ...]
redis.call('DEL', KEYS[1])
for i = 1, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
return 'OK'
`;

/** Get all IDs in a backlog lane. */
export async function getBacklogLaneIds(lane: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.backlogLane(lane), 0, -1);
}

/** Get cardinality of a backlog lane. */
export async function getBacklogLaneCount(lane: string): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(redisKeys.backlogLane(lane));
}

/** Add an item to a backlog lane sorted set. */
export async function addToBacklogLane(lane: string, score: number, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(redisKeys.backlogLane(lane), score, id);
}

/** Remove an item from a backlog lane sorted set. */
export async function removeFromBacklogLane(lane: string, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(redisKeys.backlogLane(lane), id);
}

// ---------------------------------------------------------------------------
// Atomic lane transition (issue #1990) — close the {ZREM old, HSET item,
// ZADD new} half-write race.
//
// Every lane transition in src/backlog/lanes.ts used to run as THREE separate
// Redis round-trips (removeFromBacklogLane → saveItem HSET → addToBacklogLane
// ZADD). A crash / Redis restart between the HSET and the ZADD lost the zset
// entry while the hash item survived, yielding item.lane=done with the done
// zset short by that id — the 166 "phantom done" items. This accessor runs the
// three ops in ONE atomic server-side step (Lua `eval`), so no observer can
// ever see a half-write. Mirrors `claimNextQueuedBacklogItem`: the script body
// is owned here (the keys it touches are owned by this seam, ADR-0017).
//
// The from-lanes are passed as a list (not a single lane) so the id-based
// `moveItemToLane` — which defensively ZREMs every lane before re-adding — can
// share the same atomic primitive as the title-based single-source moves. The
// caller computes the score (the done lane uses a NEGATED score, -now, so an
// ascending ZRANGE lists most-recently-done first — that invariant lives with
// the caller, this accessor just ZADDs whatever score it is handed).
// ---------------------------------------------------------------------------

const LUA_APPLY_LANE_TRANSITION = `
-- KEYS[1]   = hydra:backlog:items
-- KEYS[2]   = hydra:backlog:lane:{toLane}
-- KEYS[3..] = hydra:backlog:lane:{fromLane} (one or more lanes to ZREM)
-- ARGV[1]   = item id
-- ARGV[2]   = item JSON (already lane-stamped by applyLaneTransition)
-- ARGV[3]   = score for the to-lane ZADD (negated by caller for done)
local id = ARGV[1]
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[i], id)
end
redis.call('HSET', KEYS[1], id, ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], id)
return 'OK'
`;

/**
 * Atomically move a backlog item between lanes (issue #1990): ZREM the id from
 * every `fromLanes` zset, HSET the (already lane-stamped) item JSON into the
 * canonical items hash, and ZADD the id into the `toLane` zset at `score` — all
 * in a single Lua `eval` so a crash can never observe a half-write where
 * `item.lane` disagrees with zset membership.
 *
 * The caller owns the decision logic (find-by-title, WIP cap, blocked-reason
 * guard) and stamps the item via `applyLaneTransition` before passing
 * `itemJson` in; this accessor is the write-commit step only. `score` is
 * supplied by the caller because the done lane ZADDs at a negated score
 * (`-now`) — see src/backlog/lanes.ts.
 */
export async function applyAtomicLaneTransition(
  id: string,
  itemJson: string,
  fromLanes: string[],
  toLane: string,
  score: number,
): Promise<void> {
  const r = getRedisConnection();
  const fromLaneKeys = fromLanes.map((lane) => redisKeys.backlogLane(lane));
  await r.eval(
    LUA_APPLY_LANE_TRANSITION,
    2 + fromLaneKeys.length,
    redisKeys.backlogItems(),
    redisKeys.backlogLane(toLane),
    ...fromLaneKeys,
    id,
    itemJson,
    score,
  );
}

// ---------------------------------------------------------------------------
// Claim-next-queued Lua claim — script body owned by caller (domain logic),
// the three backlog keys it needs are owned here.
// ---------------------------------------------------------------------------

export async function claimNextQueuedBacklogItem(
  lua: string,
  nowMs: number,
  wipLimit: number,
  itemId?: string,
): Promise<string | null> {
  const r = getRedisConnection();
  const result = await r.eval(
    lua,
    3,
    redisKeys.backlogLane("queued"),
    redisKeys.backlogItems(),
    redisKeys.backlogLane("inProgress"),
    nowMs,
    wipLimit,
    // ARGV[3]: optional targeted-claim item id (issue #1682). Empty string
    // means "pop the queue head" — the pre-#1682 behavior.
    itemId ?? "",
  );
  return result === null || result === undefined ? null : String(result);
}

// ---------------------------------------------------------------------------
// Claims-reaper counters (issue #374)
// ---------------------------------------------------------------------------

export async function getClaimsReapedLifetime(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.claimsReapedLifetime());
}

export async function incrClaimsReapedLifetime(): Promise<void> {
  const r = getRedisConnection();
  await r.incr(redisKeys.claimsReapedLifetime());
}

export async function getClaimsReapedDay(isoDate: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.claimsReapedDay(isoDate));
}

/** Increment today's reaped counter and stamp its TTL so the per-day bucket ages out. */
export async function incrClaimsReapedDay(isoDate: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  const key = redisKeys.claimsReapedDay(isoDate);
  await r.incr(key);
  await r.expire(key, ttlSeconds);
}

export async function getClaimsReapedLast(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.claimsReapedLast());
}

export async function setClaimsReapedLast(iso: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.claimsReapedLast(), iso);
}
