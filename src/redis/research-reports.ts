/**
 * Research report Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

/** Save a research report and add to index. */
export async function saveResearchReport(researchId: string, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.researchReport(researchId), json);
  await r.zadd(redisKeys.researchReportIndex(), Date.now(), researchId);
}

/** Get a research report by ID. */
export async function getResearchReport(researchId: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.researchReport(researchId));
}

/** Get the N most recent research report IDs (newest first). */
export async function getRecentResearchIds(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.researchReportIndex(), 0, count - 1);
}

/** Trim research reports to keep only the most recent N. */
export async function trimResearchReports(maxCount: number): Promise<void> {
  const r = getRedisConnection();
  const count = await r.zcard(redisKeys.researchReportIndex());
  if (count > maxCount) {
    const old = await r.zrange(redisKeys.researchReportIndex(), 0, count - maxCount - 1);
    for (const id of old) {
      await r.del(redisKeys.researchReport(id));
      await r.zrem(redisKeys.researchReportIndex(), id);
    }
  }
}
