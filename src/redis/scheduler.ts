/**
 * Scheduler Redis ops: research/build events, counters, atomic claim,
 * versioned state save.
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Research-to-build ratio tracking (issue #84)
// ---------------------------------------------------------------------------

/** Record a research cycle event (timestamp-scored sorted set, rolling 24h). */
export async function recordResearchEvent(): Promise<void> {
  const r = getRedisConnection();
  const now = Date.now();
  const key = redisKeys.schedulerResearchEvents();
  await r.zadd(key, now, `${now}`);
  // Prune entries older than 24h
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
}

/** Record a build cycle event (timestamp-scored sorted set, rolling 24h). */
export async function recordBuildEvent(): Promise<void> {
  const r = getRedisConnection();
  const now = Date.now();
  const key = redisKeys.schedulerBuildEvents();
  await r.zadd(key, now, `${now}`);
  // Prune entries older than 24h
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
}

/** Get count of research events in the last 24h. */
export async function getResearchEventCount24h(): Promise<number> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerResearchEvents();
  const now = Date.now();
  // Prune old entries first
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
  return r.zcard(key);
}

/** Get count of build events in the last 24h. */
export async function getBuildEventCount24h(): Promise<number> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerBuildEvents();
  const now = Date.now();
  // Prune old entries first
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
  return r.zcard(key);
}

/** Set the force-research-once flag (consumed on next maybeRunResearch). */
export async function setResearchForceOnce(): Promise<void> {
  const r = getRedisConnection();
  // TTL of 1 hour — if not consumed by then, it expires
  await r.set(redisKeys.schedulerResearchForceOnce(), "1", "EX", 3600);
}

/** Consume the force-research-once flag. Returns true if it was set. */
export async function consumeResearchForceOnce(): Promise<boolean> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerResearchForceOnce();
  const val = await r.get(key);
  if (val) {
    await r.del(key);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Atomic scheduler counters (issue #140 / #208)
// ---------------------------------------------------------------------------

/** Atomically increment the scheduler cycles-run counter. Returns new value. */
export async function incrSchedulerCyclesRun(): Promise<number> {
  const r = getRedisConnection();
  return r.incr(redisKeys.schedulerCyclesRun());
}

/** Get the current scheduler cycles-run counter value. */
export async function getSchedulerCyclesRun(): Promise<number> {
  const r = getRedisConnection();
  const val = await r.get(redisKeys.schedulerCyclesRun());
  return val ? parseInt(val, 10) : 0;
}

/**
 * Atomically increment the scheduler cycles-merged counter. Returns new value.
 * Mirrors the cyclesRun pattern (issue #208) so mergeRate is consistent across
 * orchestrator restarts and the zero-output circuit breaker reasons over real
 * lifetime history rather than a per-process counter.
 */
export async function incrSchedulerCyclesMerged(): Promise<number> {
  const r = getRedisConnection();
  return r.incr(redisKeys.schedulerCyclesMerged());
}

/** Get the current scheduler cycles-merged counter value. */
export async function getSchedulerCyclesMerged(): Promise<number> {
  const r = getRedisConnection();
  const val = await r.get(redisKeys.schedulerCyclesMerged());
  return val ? parseInt(val, 10) : 0;
}

/**
 * Atomically increment the scheduler cycles-failed counter. Returns new value.
 * Persisted alongside cyclesMerged (issue #208) so the failed/run/merged
 * triple is restart-stable.
 */
export async function incrSchedulerCyclesFailed(): Promise<number> {
  const r = getRedisConnection();
  return r.incr(redisKeys.schedulerCyclesFailed());
}

/** Get the current scheduler cycles-failed counter value. */
export async function getSchedulerCyclesFailed(): Promise<number> {
  const r = getRedisConnection();
  const val = await r.get(redisKeys.schedulerCyclesFailed());
  return val ? parseInt(val, 10) : 0;
}

// ---------------------------------------------------------------------------
// Atomic research claim (Lua-scripted check-then-set)
// ---------------------------------------------------------------------------

/**
 * Atomically claim research eligibility: checks if lastResearchAt is old enough,
 * and if so sets it to `now`. Returns true if claimed, false if throttled.
 *
 * Uses a Lua script so the check-then-set is atomic on the Redis server.
 */
const CLAIM_RESEARCH_LUA = `
  local key = KEYS[1]
  local now_ms = tonumber(ARGV[1])
  local min_interval_ms = tonumber(ARGV[2])
  local now_iso = ARGV[3]
  local current = redis.call('GET', key)
  if current then
    local last_ms = tonumber(current)
    if last_ms and (now_ms - last_ms) < min_interval_ms then
      return 0
    end
  end
  redis.call('SET', key, tostring(now_ms))
  return 1
`;

/**
 * Atomically check and claim research eligibility.
 * Stores the timestamp as epoch ms for easy comparison.
 * Returns true if claimed (caller should run research), false if throttled.
 */
export async function atomicClaimResearch(minIntervalMs: number): Promise<boolean> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerState() + ":lastResearchAt";
  const nowMs = Date.now();
  const result = await r.eval(CLAIM_RESEARCH_LUA, 1, key, nowMs, minIntervalMs, new Date().toISOString());
  return result === 1;
}

/** Read the last research timestamp (epoch ms). Returns null if never set. */
export async function getLastResearchAtMs(): Promise<number | null> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerState() + ":lastResearchAt";
  const val = await r.get(key);
  return val ? parseInt(val, 10) : null;
}

/** Unconditionally set the last research timestamp (for forced research). */
export async function setLastResearchAt(): Promise<void> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerState() + ":lastResearchAt";
  await r.set(key, Date.now().toString());
}

// ---------------------------------------------------------------------------
// Versioned scheduler state (Lua optimistic locking)
// ---------------------------------------------------------------------------

/**
 * Versioned save of scheduler state: uses a Lua script for optimistic locking.
 * Returns { saved, newVersion }. saved=false indicates a version conflict.
 */
export async function saveSchedulerStateVersioned(
  payload: string,
  expectedVersion: number,
): Promise<{ saved: boolean; newVersion: number }> {
  const r = getRedisConnection();
  const stateKey = redisKeys.schedulerState();
  const versionKey = redisKeys.schedulerStateVersion();

  // Use a Lua script for atomic check-and-set (avoids WATCH connection issues)
  const LUA = `
    local stateKey = KEYS[1]
    local versionKey = KEYS[2]
    local payload = ARGV[1]
    local expectedVersion = tonumber(ARGV[2])
    local currentVersion = tonumber(redis.call('GET', versionKey) or '0') or 0
    if currentVersion ~= expectedVersion then
      return {0, currentVersion}
    end
    local newVersion = currentVersion + 1
    redis.call('SET', stateKey, payload)
    redis.call('SET', versionKey, tostring(newVersion))
    return {1, newVersion}
  `;
  const result = await r.eval(LUA, 2, stateKey, versionKey, payload, expectedVersion);
  return { saved: result[0] === 1, newVersion: result[1] };
}

/** Get the current scheduler state version. */
export async function getSchedulerStateVersion(): Promise<number> {
  const r = getRedisConnection();
  const val = await r.get(redisKeys.schedulerStateVersion());
  return val ? parseInt(val, 10) : 0;
}
