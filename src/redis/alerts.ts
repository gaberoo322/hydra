/**
 * Alert list Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Push an alert to the alerts list (capped at maxLen).
 */
export async function pushAlert(alertJson: string, maxLen: number): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(redisKeys.alerts(), alertJson);
  await r.ltrim(redisKeys.alerts(), 0, maxLen - 1);
}

/** Read the most recent alerts (LPUSH-ed list — index 0 is newest). */
export async function readRecentAlerts(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const r = getRedisConnection();
  return r.lrange(redisKeys.alerts(), 0, limit - 1);
}
