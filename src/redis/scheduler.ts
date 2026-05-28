/**
 * Scheduler Redis ops: research/build events, counters, atomic claim,
 * versioned state save.
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "./keys.ts";
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

// ---------------------------------------------------------------------------
// Scheduler state + spend blobs (caller owns JSON shape; this owns key+TTL)
// ---------------------------------------------------------------------------

/** Read the raw scheduler-state JSON blob, or null when unset. */
export async function getSchedulerStateRaw(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.schedulerState());
}

/** Write the raw scheduler-state JSON blob. */
export async function setSchedulerStateRaw(payload: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.schedulerState(), payload);
}

/** Read the raw daily-spend JSON blob, or null when unset. */
export async function getDailySpendRaw(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.schedulerDailySpend());
}

/** Write the raw daily-spend JSON blob. */
export async function setDailySpendRaw(payload: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.schedulerDailySpend(), payload);
}

// ---------------------------------------------------------------------------
// Deliberate-stop flag (issue #388 — survives a 24h restart window)
// ---------------------------------------------------------------------------

/** Set the deliberate-stop sentinel with a TTL. */
export async function setSchedulerDeliberateStop(payload: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.schedulerDeliberateStop(), payload, "EX", ttlSeconds);
}

/** Read the deliberate-stop sentinel, or null when absent / expired. */
export async function getSchedulerDeliberateStop(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.schedulerDeliberateStop());
}

/** Clear the deliberate-stop sentinel. */
export async function clearSchedulerDeliberateStop(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.schedulerDeliberateStop());
}

// ---------------------------------------------------------------------------
// Budget-threshold idempotency (issue #673)
// ---------------------------------------------------------------------------

/**
 * Atomically claim a budget-threshold crossing. Uses SET NX EX so the first
 * caller for a (date, thresholdPct) pair wins and every subsequent caller
 * for the rest of the TTL window is a no-op.
 *
 * Returns true when the caller is the FIRST to cross this threshold today
 * (i.e. the caller should emit the event), false otherwise.
 */
export async function claimBudgetThresholdSeen(
  isoDate: string,
  thresholdPct: number,
  ttlSeconds: number,
): Promise<boolean> {
  const r = getRedisConnection();
  const key = redisKeys.budgetThresholdSeen(isoDate, thresholdPct);
  const result = await r.set(key, Date.now().toString(), "NX", "EX", ttlSeconds);
  return result === "OK";
}

/** Read the budget-threshold sentinel, or null when absent. Exposed for tests. */
export async function getBudgetThresholdSeen(
  isoDate: string,
  thresholdPct: number,
): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.budgetThresholdSeen(isoDate, thresholdPct));
}

/** Test helper: wipe a single budget-threshold sentinel. */
export async function _clearBudgetThresholdSeen(
  isoDate: string,
  thresholdPct: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.budgetThresholdSeen(isoDate, thresholdPct));
}

// ---------------------------------------------------------------------------
// Blocked-issue escalation cooldown (per-item timestamp hash)
// ---------------------------------------------------------------------------

/** Read the last-escalation timestamp for a blocked item, or null when absent. */
export async function getBlockedLastEscalation(itemId: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.blockedLastEscalation(), itemId);
}

/** Record the last-escalation timestamp for a blocked item. */
export async function setBlockedLastEscalation(itemId: string, value: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.blockedLastEscalation(), itemId, value);
}

// ---------------------------------------------------------------------------
// Weekly digest + memory consolidation timestamps
// ---------------------------------------------------------------------------

export async function getDigestLastWeekly(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.digestLastWeekly());
}

export async function setDigestLastWeekly(value: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.digestLastWeekly(), value);
}

export async function getMemoryLastConsolidation(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.memoryLastConsolidation());
}

export async function setMemoryLastConsolidation(value: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.memoryLastConsolidation(), value);
}

// ---------------------------------------------------------------------------
// Research floor (issue #84) — empty-streak + suppression-until + stats
// ---------------------------------------------------------------------------

/** Atomic INCR returning new streak length. */
export async function incrResearchFloorEmptyStreak(): Promise<number> {
  const r = getRedisConnection();
  return r.incr(redisKeys.researchFloorEmptyStreak());
}

export async function resetResearchFloorEmptyStreak(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.researchFloorEmptyStreak());
}

export async function getResearchFloorEmptyStreak(): Promise<number> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.researchFloorEmptyStreak());
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function setResearchFloorSuppressedUntilMs(deadlineMs: number): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.researchFloorSuppressedUntil(), String(deadlineMs));
}

export async function getResearchFloorSuppressedUntilMs(): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.researchFloorSuppressedUntil());
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export async function clearResearchFloorSuppressedUntil(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.researchFloorSuppressedUntil());
}

export async function incrResearchFloorStat(name: string, by: number): Promise<void> {
  const r = getRedisConnection();
  await r.hincrby(redisKeys.researchFloorStats(), name, by);
}

export async function setResearchFloorLastTriggeredAt(iso: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.researchFloorLastTriggeredAt(), iso);
}

export async function getResearchFloorStatsHash(): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.researchFloorStats());
}

export async function getResearchFloorLastTriggeredAt(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.researchFloorLastTriggeredAt());
}

/** Test helper: wipe all research-floor state. */
export async function _resetAllResearchFloorState(): Promise<void> {
  const r = getRedisConnection();
  await Promise.all([
    r.del(redisKeys.researchFloorStats()),
    r.del(redisKeys.researchFloorLastTriggeredAt()),
    r.del(redisKeys.researchFloorEmptyStreak()),
    r.del(redisKeys.researchFloorSuppressedUntil()),
  ]);
}
