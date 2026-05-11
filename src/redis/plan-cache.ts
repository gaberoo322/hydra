/**
 * Plan cache Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { getRedisConnection } from "./connection.ts";

/**
 * Get a cached plan entry by full key.
 */
export async function getPlanCacheEntry(key: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(key);
}

/**
 * Store a plan cache entry with TTL.
 */
export async function setPlanCacheEntry(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(key, value, "EX", ttlSeconds);
}

/**
 * Delete a plan cache entry by key.
 */
export async function deletePlanCacheEntry(key: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(key);
}

/**
 * Find all keys matching the plan cache prefix.
 */
export async function findPlanCacheKeys(prefix: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.keys(`${prefix}*`);
}
