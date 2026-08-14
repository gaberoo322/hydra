/**
 * Cycle lifecycle tracking Redis ops (active, last, hash, sources, merge lock).
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Standard cycle-record TTL (7 days), matching `CYCLE_TTL_SECONDS` in
 * `src/autopilot/cycle-close.ts` and the `604800` literal in the
 * `/cycle/register` handler (`src/api/cycles.ts`). Kept here so
 * `updateCycleHash` can re-apply the same window when it finds a hash with no
 * TTL — see the leak-backstop rationale on that function (issue #2926).
 */
export const CYCLE_HASH_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800

/** Read the active cycle ID, or null if none. */
export async function getActiveCycleId(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.cycleActive());
}

/** Read the full cycle hash for the given ID. Returns an empty object when absent. */
export async function getCycleHash(cycleId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.cycle(cycleId));
}

/**
 * List every cycle id ever recorded, newest-first, via the recent-cycles index.
 *
 * Reads the `hydra:cycle:index` ZSET with ZREVRANGE, so the ids come back
 * ordered by recency. Used by `getCycleHistory()` to enumerate completed
 * cycles for the /cycle/history endpoint.
 *
 * Why the index and not a keyspace scan (issue #3997): the previous
 * implementation matched `hydra:cycle:cycle-*`, but live cycle keys are
 * `hydra:cycle:<hex>` (e.g. `hydra:cycle:aeef970d909cccd8a`) — no `cycle-`
 * segment — so the pattern matched nothing and /cycle/history silently returned
 * `[]` while 118 real records sat in Redis. The index is the single source of
 * truth for which ids exist; reading it can never accidentally enumerate a
 * non-cycle sibling that merely shares the `hydra:cycle:` prefix
 * (`hydra:cycle:active`, `hydra:cycle:index`, `hydra:cycle:active:<source>`),
 * and ordering by ZSET score is chronologically correct for the hex id shape,
 * unlike a lexical reverse-sort over id strings which assumed
 * ISO-timestamp-shaped ids.
 *
 * The index is kept authoritative at the WRITE seam, not by convention (issue
 * #3997 follow-up / PR #4058 QA): `initCycleHash()` and `updateCycleHash()` —
 * the only two functions that ever create or touch a cycle hash — each ZADD
 * the id into `hydra:cycle:index` themselves. There were previously TWO
 * independent cycle-hash writers (`recordCycle()` in
 * `src/autopilot/cycle-close.ts`, and `POST /cycle/register` /
 * `POST /cycle/complete` in `src/api/cycles.ts`), but only `recordCycle` also
 * called `addCycleToIndex()` explicitly — so cycles registered via
 * `/cycle/register` were silently invisible to `/cycle/history`, the same bug
 * the issue reports, just narrowed to one write path. Indexing inside
 * `initCycleHash`/`updateCycleHash` instead of at each call site means ANY
 * caller — including a future third writer — inherits correct indexing for
 * free; a cycle hash written by some other means entirely (bypassing both
 * functions) is the only way to end up unindexed.
 */
export async function listCycleIds(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.cycleIndex(), 0, -1);
}

/**
 * Init cycle hash fields, set TTL, and index the id (issue #3997 follow-up:
 * this is one of the two write-seam functions that keep `hydra:cycle:index`
 * authoritative — see `listCycleIds()`'s docstring). The index ZADD is
 * idempotent per cycleId (a member re-add just updates its score), so a
 * register-then-complete sequence never produces a duplicate index entry.
 */
export async function initCycleHash(
  cycleId: string,
  fields: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.cycle(cycleId), ...Object.entries(fields).flat());
  await r.expire(redisKeys.cycle(cycleId), ttlSeconds);
  await r.zadd(redisKeys.cycleIndex(), Date.now(), cycleId);
}

/**
 * Update cycle hash fields, keeping the record from leaking without a TTL.
 *
 * Leak backstop (issue #2926): a bare `HSET` neither sets nor resets a key's
 * TTL. `/cycle/complete` (`src/api/cycles.ts`) reaches here without any
 * guarantee that `/cycle/register` (which sets the 7-day TTL via
 * `initCycleHash`) ran first — an external caller can `complete` a cycle that
 * was never registered, or whose TTL already lapsed mid-run. In either case the
 * `HSET` (re)creates a hash with **no expiry**, and the record becomes a
 * permanent, dateless orphan that the date-fallback stale-key sweep
 * (`stale-key-prune.ts`) can never age out — the exact leak the 270-key symptom
 * pointed at.
 *
 * Fix: after the write, read the key's current TTL and apply the standard
 * `CYCLE_HASH_TTL_SECONDS` window only when it has none (`ttl === -1`, "exists,
 * no expiry"). A live TTL (`ttl >= 0`) is left untouched so routine status
 * updates never extend the window; a missing key (`ttl === -2`) can't occur
 * here because the preceding `HSET` guarantees existence.
 *
 * `redis` is injectable (default: the shared connection) so the TTL-preserving
 * branch is exercisable without standing up real Redis.
 *
 * Also indexes the id (issue #3997 follow-up: the other write-seam function
 * that keeps `hydra:cycle:index` authoritative — see `listCycleIds()`'s
 * docstring). This closes the complete-without-register gap too: if a caller
 * completes a cycle whose `/cycle/register` never ran (the same scenario the
 * TTL backstop above already guards), the id still lands in the index here.
 * The ZADD is idempotent per cycleId, so re-indexing an already-indexed id
 * (the common register-then-complete case) just refreshes its score to the
 * latest touch — never a duplicate entry.
 */
export async function updateCycleHash(
  cycleId: string,
  fields: Record<string, string>,
  redis: Pick<
    ReturnType<typeof getRedisConnection>,
    "hset" | "ttl" | "expire" | "zadd"
  > = getRedisConnection(),
): Promise<void> {
  const key = redisKeys.cycle(cycleId);
  await redis.hset(key, ...Object.entries(fields).flat());
  // Re-apply the standard cycle TTL only when the hash currently has none, so a
  // complete-without-register (or a post-expiry re-touch) can't leak a
  // TTL-less orphan. -1 = exists but no TTL; >= 0 = live TTL (leave it).
  const ttl = await redis.ttl(key);
  if (ttl === -1) {
    await redis.expire(key, CYCLE_HASH_TTL_SECONDS);
  }
  await redis.zadd(redisKeys.cycleIndex(), Date.now(), cycleId);
}

/** Register a cycle source (codex/claude) with TTL. */
export async function registerCycleSource(
  source: string,
  cycleId: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cycleActiveSource(source), cycleId, "EX", ttlSeconds);
}

/** Release a cycle source registration. */
export async function releaseCycleSource(source: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.cycleActiveSource(source));
}

// ---------------------------------------------------------------------------
// Merge lock
// ---------------------------------------------------------------------------

/** Try to acquire the merge lock. Returns true if acquired. */
export async function acquireMergeLock(cycleId: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(redisKeys.mergeLock(), cycleId, "EX", ttlSeconds, "NX");
  return result === "OK";
}

/** Get current merge lock holder. */
export async function getMergeLockHolder(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.mergeLock());
}

/** Release the merge lock. */
export async function releaseMergeLock(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.mergeLock());
}

// ---------------------------------------------------------------------------
// Cycle index (ZSET scored by completed-at epoch)
// ---------------------------------------------------------------------------

/**
 * Add a cycle to the recent-cycles ZSET index, with an explicit score.
 *
 * `initCycleHash`/`updateCycleHash` now also index internally (issue #3997
 * follow-up), so most callers no longer need this directly. `recordCycle()`
 * (`src/autopilot/cycle-close.ts`) still calls it explicitly alongside
 * `deps.cycle.initCycleHash` so the index score comes from its injectable
 * `now()` clock rather than `Date.now()` — needed for its deterministic,
 * no-Redis unit tests (`test/autopilot-runs-deps.test.mts`). In production
 * this means the id gets ZADDed twice in quick succession (once via
 * `initCycleHash`'s internal `Date.now()`, once via this explicit call); ZADD
 * on an existing member just updates its score, so this is a harmless,
 * intentional redundancy — not a bug to "clean up" by removing either call.
 */
export async function addCycleToIndex(cycleId: string, score: number): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(redisKeys.cycleIndex(), score, cycleId);
}

/**
 * Pipelined fetch of multiple cycle hashes — used by autopilot's
 * /runs/current to attach outcomes onto dispatch actions in one Redis
 * round-trip rather than N. Returns a map of cycleId → hash; cycles
 * with no recorded hash are absent from the map.
 */
export async function getCycleHashesBatch(
  cycleIds: string[],
): Promise<Record<string, Record<string, string>>> {
  if (cycleIds.length === 0) return {};
  const r = getRedisConnection();
  const uniqueIds = Array.from(new Set(cycleIds));
  const pipeline = r.pipeline();
  for (const cid of uniqueIds) {
    pipeline.hgetall(redisKeys.cycle(cid));
  }
  const results: any[] = await pipeline.exec();
  const out: Record<string, Record<string, string>> = {};
  uniqueIds.forEach((cid, i) => {
    const entry = results?.[i];
    const hash = entry && Array.isArray(entry) ? entry[1] : null;
    if (hash && typeof hash === "object" && Object.keys(hash).length > 0) {
      out[cid] = hash as Record<string, string>;
    }
  });
  return out;
}
