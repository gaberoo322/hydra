/**
 * Reality report Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Fetch the most recent N reality-report IDs (newest first).
 */
export async function getRecentReportIds(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.realityReportIndex(), 0, count - 1);
}

/**
 * Fetch a single reality report by ID.
 * Returns null if missing.
 */
export async function getRealityReport(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.realityReport(id));
}

/**
 * Fetch reality report IDs with scores above a minimum.
 */
export async function getReportIdsByScore(minScore: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrangebyscore(redisKeys.realityReportIndex(), minScore + 1, "+inf");
}

/**
 * Get the score of a specific reality report ID in the index.
 */
export async function getReportScore(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.zscore(redisKeys.realityReportIndex(), id);
}

/**
 * Fetch recent report IDs from the reality-report index (newest first).
 */
export async function getRecentReportIdsDesc(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.realityReportIndex(), 0, count - 1);
}

/** Save a reality report with TTL and add to index. */
export async function saveRealityReport(
  cycleId: string,
  json: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.realityReport(cycleId), json, "EX", ttlSeconds);
  await r.zadd(redisKeys.realityReportIndex(), Date.now(), cycleId);
}

/** Trim reality report index to keep only the most recent N entries. */
export async function trimRealityReports(maxCount: number): Promise<void> {
  const r = getRedisConnection();
  const count = await r.zcard(redisKeys.realityReportIndex());
  if (count > maxCount) {
    const old = await r.zrange(redisKeys.realityReportIndex(), 0, count - maxCount - 1);
    for (const id of old) {
      await r.del(redisKeys.realityReport(id));
      await r.zrem(redisKeys.realityReportIndex(), id);
    }
  }
}
