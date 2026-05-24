/**
 * Alert list Redis ops. Extracted from redis-adapter.ts (issue #269);
 * extended in ADR-0009 slice 5 to cover the dismiss + clear flows so
 * api/alerts.ts no longer touches the raw key.
 */

import { redisKeys } from "./keys.ts";
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

/** Read every alert in the list (used by dismiss-by-id scan). */
export async function readAllAlerts(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.alerts(), 0, -1);
}

/** Overwrite a specific position in the alerts list. */
export async function setAlertAt(index: number, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.lset(redisKeys.alerts(), index, json);
}

/** Drop every alert. */
export async function clearAlerts(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.alerts());
}
