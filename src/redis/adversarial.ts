/**
 * Adversarial validation tracking Redis ops.
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Track a merged commit for revert correlation.
 * Maintains a rolling window of maxLen entries.
 */
export async function pushTrackedMerge(entryJson: string, maxLen: number): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(redisKeys.adversarialTracking(), entryJson);
  await r.ltrim(redisKeys.adversarialTracking(), 0, maxLen - 1);
}

/**
 * Get all tracked merge entries (for revert correlation).
 */
export async function getTrackedMerges(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.adversarialTracking(), 0, -1);
}

/**
 * Persist adversarial precision stats.
 */
export async function setAdversarialStats(statsJson: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.adversarialStats(), statsJson);
}
