/**
 * Reflection Redis ops (buffer + per-anchor + outcomes).
 * Extracted from redis-adapter.ts (issue #269).
 *
 * Note: low-level Redis primitives. Higher-level reflection logic lives in
 * src/learning/reflections.ts.
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
 * Append a reflection to the global buffer list and cap at maxSize.
 */
export async function pushReflection(json: string, maxSize: number): Promise<void> {
  const r = getRedisConnection();
  await r.rpush("hydra:reflections:buffer", json);
  const len = await r.llen("hydra:reflections:buffer");
  if (len > maxSize) {
    await r.ltrim("hydra:reflections:buffer", len - maxSize, -1);
  }
}

/**
 * Fetch all entries from the reflections buffer.
 */
export async function getReflectionBuffer(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange("hydra:reflections:buffer", 0, -1);
}

/**
 * Atomically replace the reflections buffer with a filtered list.
 */
export async function replaceReflectionBuffer(entries: string[]): Promise<void> {
  const r = getRedisConnection();
  const pipeline = r.pipeline();
  pipeline.del("hydra:reflections:buffer");
  if (entries.length > 0) {
    pipeline.rpush("hydra:reflections:buffer", ...entries);
  }
  await pipeline.exec();
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

/**
 * Get all reflection outcomes (oldest first).
 */
export async function getReflectionOutcomes(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.reflectionOutcomes(), 0, -1);
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
