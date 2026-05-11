/**
 * Reflection Redis ops (buffer + per-anchor + outcomes).
 * Extracted from redis-adapter.ts (issue #269).
 *
 * Note: low-level Redis primitives. Higher-level reflection logic lives in
 * src/learning/reflections.ts.
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

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
 * Delete a reflection key.
 */
export async function deleteReflectionKey(key: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(key);
}

/**
 * Record a reflection outcome (whether a retry with reflections succeeded or failed).
 * Stored as a sorted set (by timestamp) for time-ordered retrieval.
 */
export async function pushReflectionOutcome(json: string, score: number): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(redisKeys.reflectionOutcomes(), score, json);
}

/**
 * Get all reflection outcomes (oldest first).
 */
export async function getReflectionOutcomes(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.reflectionOutcomes(), 0, -1);
}

/**
 * Set TTL on a reflection key (for extending effective reflections).
 */
export async function setReflectionKeyTTL(key: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.expire(key, ttlSeconds);
}
