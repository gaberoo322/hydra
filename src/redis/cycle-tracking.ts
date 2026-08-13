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
 * List all cycle IDs, newest-first, from the `hydra:cycle:index` ZSET.
 *
 * Used by `getCycleHistory()` to enumerate cycles for the /cycle/history
 * endpoint. The index is the single source of truth for "which cycle ids
 * exist": `recordCycle()` in `src/autopilot/cycle-close.ts` populates it
 * (`addCycleToIndex`, scored by completion epoch) in the same write that
 * creates the per-cycle hash (`initCycleHash`), so every live cycle record is
 * a ZSET member and the two can never drift apart at write time.
 *
 * Why the index and not a keyspace SCAN (issue #3997): the previous
 * implementation MATCH-scanned `hydra:cycle:cycle-*`, a pattern no real key
 * matches — live keys are `hydra:cycle:<hex>` (e.g. `hydra:cycle:aeef970d909cccd8a`),
 * so the scan returned `[]` and /cycle/history answered an empty array while
 * Redis held 118 real records (a silent wrong answer, not an error). Reading
 * the index also side-steps the WRONGTYPE trap a broader `hydra:cycle:*` scan
 * would hit: the active pointer (`hydra:cycle:active`), per-source active
 * pointers (`hydra:cycle:active:<source>`), the index ZSET itself, and
 * per-cycle sub-keys (`:agents` / `:costs` / `:tasks`) all share the prefix but
 * are not cycle-record hashes. `addCycleToIndex` only ever stores a bare
 * cycleId, so the ZSET contains neither structural siblings nor sub-keys by
 * construction — no filtering is needed.
 *
 * `ZREVRANGE 0 -1` returns members highest-score (newest) first, so ordering is
 * chronologically correct by completion time. The old lexical `.sort().reverse()`
 * assumed ISO-timestamp-shaped ids and was meaningless for the real hex shape.
 *
 * Members whose hash has since TTL-expired (7-day window) are returned here and
 * filtered downstream by `getCycleHistory()`'s `!cycle.status` guard — that is
 * the intended behaviour, not a leak: the index is a historical log, the
 * per-cycle hash is the live record.
 */
export async function listCycleIds(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.cycleIndex(), 0, -1);
}

/** Init cycle hash fields and set TTL. */
export async function initCycleHash(
  cycleId: string,
  fields: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.cycle(cycleId), ...Object.entries(fields).flat());
  await r.expire(redisKeys.cycle(cycleId), ttlSeconds);
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
 */
export async function updateCycleHash(
  cycleId: string,
  fields: Record<string, string>,
  redis: Pick<ReturnType<typeof getRedisConnection>, "hset" | "ttl" | "expire"> = getRedisConnection(),
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

/** Add a cycle to the recent-cycles ZSET index. */
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
