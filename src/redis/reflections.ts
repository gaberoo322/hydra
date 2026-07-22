/**
 * Reflection Redis ops (per-anchor + by-file index).
 * Extracted from redis-adapter.ts (issue #269).
 *
 * Note: low-level Redis primitives. Higher-level reflection logic lives in
 * src/learning/reflections.ts.
 *
 * Issue #1454: the global reflection buffer (a Redis list) and its accessors
 * were deleted as a dead subsystem. Issue #1655: the reflection-outcomes zset
 * reader followed (its writer died in earlier retirements). Issue #3546: the
 * residual reflection-outcomes liveness PROBE (a read-only ZSET scaffold that
 * only existed to explain the retired corpse on the health surface) was buried
 * too — the retired key is DEL'd, so nothing needs to observe it. The per-anchor
 * list and the by-file index survive — they back the live #841 injection path.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/** Shared prefix all per-anchor reflection keys live under. */
export const REFLECTION_PREFIX = redisKeys.reflectionPrefix();

/**
 * Count the per-anchor reflection keys via SCAN. Used by the health probe
 * to expose `reflectionKeys` without unbounded KEYS calls.
 */
export async function countReflectionKeys(): Promise<number> {
  const r = getRedisConnection();
  const pattern = redisKeys.reflection("*");
  let cursor = "0";
  let count = 0;
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    count += batch.length;
  } while (cursor !== "0");
  return count;
}

/**
 * Push a reflection entry for a specific anchor and set TTL.
 * Trims to maxEntries.
 */
export async function pushAnchorReflection(
  key: string,
  json: string,
  ttlSeconds: number,
  maxEntries: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(key, json);
  await r.expire(key, ttlSeconds);
  const len = await r.llen(key);
  if (len > maxEntries) {
    await r.ltrim(key, len - maxEntries, -1);
  }
}

/**
 * Fetch all entries from a reflection list.
 */
export async function getAnchorReflections(key: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(key, 0, -1);
}

// ===========================================================================
// By-file secondary index (issue #326)
// ===========================================================================
//
// Reflections are primarily keyed by `hydra:reflections:<normalized-anchor-ref>`,
// which is too narrow: 103/127 stored reflection keys are unique within the
// first 40 chars, so retries with a different anchor string but the same
// underlying file never re-use the reflection.
//
// This secondary index maps `file -> { anchorKey, anchorKey, ... }` via a
// Redis Set per file, so a new anchor touching `foo.ts` can fan out to
// every reflection key whose source anchor also touched `foo.ts`.

const BY_FILE_PREFIX = "hydra:reflections:by-file:";

/** Returns the Redis key holding the anchor-key set for `file`. */
function reflectionByFileKey(file: string): string {
  return BY_FILE_PREFIX + file;
}

/**
 * Add `anchorKey` to the by-file index for `file` and set TTL.
 * Idempotent — SADD is a no-op on duplicates.
 */
export async function addReflectionToFileIndex(
  file: string,
  anchorKey: string,
  ttlSeconds: number,
): Promise<void> {
  if (!file || !anchorKey) return;
  const r = getRedisConnection();
  const key = reflectionByFileKey(file);
  await r.sadd(key, anchorKey);
  await r.expire(key, ttlSeconds);
}

/**
 * Return all anchor keys associated with `file`. Empty array if none.
 */
export async function getReflectionKeysByFile(file: string): Promise<string[]> {
  if (!file) return [];
  const r = getRedisConnection();
  return r.smembers(reflectionByFileKey(file));
}
