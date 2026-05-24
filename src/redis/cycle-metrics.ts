/**
 * Cycle metrics + cost Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Fetch the list of agent run entries for a cycle.
 */
export async function getCycleAgentRuns(cycleId: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.cycleAgents(cycleId), 0, -1);
}

/**
 * Store a cycle's flattened metrics hash and add to the index.
 */
export async function setCycleMetrics(
  cycleId: string,
  flat: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.metrics(cycleId), ...Object.entries(flat).flat());
  await r.expire(redisKeys.metrics(cycleId), ttlSeconds);
  await r.zadd(redisKeys.metricsIndex(), Date.now(), cycleId);
}

/**
 * Fetch the N most recent cycle IDs from the metrics index.
 */
export async function getRecentMetricIds(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.metricsIndex(), 0, count - 1);
}

/**
 * Fetch all fields of a cycle's metrics hash.
 */
export async function getCycleMetrics(cycleId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.metrics(cycleId));
}

/**
 * Remove metrics index entries below a score cutoff.
 * Returns the number of entries removed.
 */
export async function pruneMetricsIndex(cutoffMs: number): Promise<number> {
  const r = getRedisConnection();
  return r.zremrangebyscore(redisKeys.metricsIndex(), "-inf", cutoffMs);
}

/**
 * Get the cardinality of the metrics index.
 */
export async function getMetricsIndexSize(): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(redisKeys.metricsIndex());
}

/**
 * Trim the metrics index to keep only the top maxEntries (by score).
 * Removes the lowest-scored entries.
 */
export async function trimMetricsIndex(excess: number): Promise<void> {
  const r = getRedisConnection();
  await r.zremrangebyrank(redisKeys.metricsIndex(), 0, excess - 1);
}

/**
 * Fetch recent metric cycle IDs from the metrics index (newest first).
 */
export async function getRecentMetricIdsDesc(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.metricsIndex(), 0, count - 1);
}

/**
 * Get the cost microdollars field from a cycle's costs hash.
 */
export async function getCycleCostMicrodollars(cycleId: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.cycleCosts(cycleId), "costMicrodollars");
}

/** Get all cost fields for a cycle. */
export async function getCycleCosts(cycleId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.cycleCosts(cycleId));
}
