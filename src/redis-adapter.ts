/**
 * Redis Adapter — singleton connection + typed methods.
 *
 * Replaces per-module `new Redis()` and `getTracker().getRedisClient()` calls
 * with a single shared connection and domain-specific methods that use
 * redis-keys.ts for all key generation.
 *
 * Incrementally adoptable: modules can migrate one at a time.
 */

import Redis from "ioredis";
import { redisKeys } from "./redis-keys.ts";

// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let _instance: Redis | null = null;

/** Shared Redis connection. Lazy-initialized on first call. */
export function getRedisConnection(): Redis {
  if (!_instance) _instance = new Redis(REDIS_URL);
  return _instance;
}

// ---------------------------------------------------------------------------
// Workspace operations
// ---------------------------------------------------------------------------

/**
 * Acquire the workspace lock (NX + 60s TTL).
 * Returns true if lock was acquired, false if already held.
 */
export async function acquireWorkspaceLock(pid: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(redisKeys.workspaceLock(), `${pid}`, "NX", "EX", 60);
  return result === "OK";
}

/** Release the workspace lock. */
export async function releaseWorkspaceLock(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.workspaceLock());
}

// ---------------------------------------------------------------------------
// Reality-report lookups (used by preflight duplicate check)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Anchor calibration (used by anchor-scorer)
// ---------------------------------------------------------------------------

/**
 * Record a calibration outcome for an anchor confidence prediction.
 */
export async function setCalibrationOutcome(
  cycleId: string,
  data: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.anchorCalibration(cycleId), data, "EX", ttlSeconds);
  await r.zadd(redisKeys.anchorCalibrationIndex(), Date.now(), cycleId);
}

// ---------------------------------------------------------------------------
// Pattern-detector operations
// ---------------------------------------------------------------------------

/**
 * Get the last alert timestamp for a given pattern name.
 * Returns null if never alerted.
 */
export async function getPatternCooldown(pattern: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.patternDetectorCooldowns(), pattern);
}

/**
 * Set the cooldown timestamp for a pattern name.
 */
export async function setPatternCooldown(pattern: string, timestamp: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.patternDetectorCooldowns(), pattern, timestamp);
}

/**
 * Push an alert to the alerts list (capped at maxLen).
 */
export async function pushAlert(alertJson: string, maxLen: number): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(redisKeys.alerts(), alertJson);
  await r.ltrim(redisKeys.alerts(), 0, maxLen - 1);
}

// ---------------------------------------------------------------------------
// Adversarial-validation operations
// ---------------------------------------------------------------------------

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
