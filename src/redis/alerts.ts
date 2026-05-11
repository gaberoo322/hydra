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
