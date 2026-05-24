/**
 * Resolved health-anchor Redis ops (issue #25).
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

const RESOLVED_HEALTH_TTL = 86400; // 24h

/**
 * Mark a codebase-health anchor as resolved after a successful merge.
 * Uses a per-reference key with 24h TTL so stale entries auto-expire.
 */
export async function markHealthAnchorResolved(ref: string): Promise<void> {
  const r = getRedisConnection();
  const key = redisKeys.anchorResolvedHealth(ref.replace(/\s+/g, "-").slice(0, 120));
  await r.set(key, new Date().toISOString(), "EX", RESOLVED_HEALTH_TTL);
}

/**
 * Check whether a codebase-health anchor was recently resolved.
 */
export async function isHealthAnchorResolved(ref: string): Promise<boolean> {
  const r = getRedisConnection();
  const key = redisKeys.anchorResolvedHealth(ref.replace(/\s+/g, "-").slice(0, 120));
  const val = await r.exists(key);
  return val === 1;
}
