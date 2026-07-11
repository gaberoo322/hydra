/**
 * Scheduler Redis ops: research/build events, counters, atomic claim,
 * versioned state save.
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Research-force-once flag (issue #84) — fully retired in #2489
// ---------------------------------------------------------------------------
//
// The research/build event-count accessors (recordResearchEvent,
// recordBuildEvent, getResearchEventCount24h, getBuildEventCount24h) and the
// consumeResearchForceOnce reader were removed in #2488: they backed the
// in-process research-floor decision plane deleted in #706 (scheduler fold
// PR-1/4) and had zero live callers. The writer, `setResearchForceOnce`, and
// its Redis key (`schedulerResearchForceOnce` → `hydra:scheduler:research-force-once`)
// were removed in #2489 (Option A): with the consumer gone, the flag was
// write-only and the POST /research/force endpoint that called it returned a
// hollow success. The research-force policy now lives entirely in the autopilot
// brain (`scripts/autopilot/decide.py` `_research_force_allowed`).

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

/**
 * Atomically increment the scheduler cycles-unaccounted counter (issue #1919).
 * Returns new value. Bumped on the exact recordCycle else-branch where a
 * cycle's status fell in NEITHER MERGED_STATUSES nor FAILED_STATUSES, so the
 * run = merged + failed + unaccounted identity holds as a first-class counter
 * rather than an inferred (run - merged - failed) subtraction. Persisted
 * alongside cyclesMerged/cyclesFailed (issue #208 pattern) so the full
 * accounting is restart-stable.
 */
export async function incrSchedulerCyclesUnaccounted(): Promise<number> {
  const r = getRedisConnection();
  return r.incr(redisKeys.schedulerCyclesUnaccounted());
}

/** Get the current scheduler cycles-unaccounted counter value. */
export async function getSchedulerCyclesUnaccounted(): Promise<number> {
  const r = getRedisConnection();
  const val = await r.get(redisKeys.schedulerCyclesUnaccounted());
  return val ? parseInt(val, 10) : 0;
}

// ---------------------------------------------------------------------------
// Research timestamp reader (issue #140)
// ---------------------------------------------------------------------------
//
// The atomic-claim writer (`atomicClaimResearch`, Lua check-then-set) and the
// unconditional writer (`setLastResearchAt`) were removed in #3132: they backed
// the in-process research-decision plane deleted in #706 (scheduler fold PR-1/4)
// and had zero live callers (only test coverage). The remaining reader,
// `getLastResearchAtMs`, is still imported by the observability heartbeat
// (`src/scheduler/heartbeat.ts`); its own removal is tracked by #3133, which
// deletes that consumer wiring first.

/** Read the last research timestamp (epoch ms). Returns null if never set. */
export async function getLastResearchAtMs(): Promise<number | null> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerState() + ":lastResearchAt";
  const val = await r.get(key);
  return val ? parseInt(val, 10) : null;
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

// `setSchedulerStateRaw` (the write side of `hydra:scheduler:state`) was removed
// in #2488: it had no live caller (writes go through saveSchedulerStateVersioned).
// The read side `getSchedulerStateRaw` is retained — still called by the
// observability heartbeat (`src/scheduler/heartbeat.ts`).

// `getDailySpendRaw` + the `hydra:scheduler:daily-spend` key were removed in
// #704. The key had no live writer (its writer + budget-threshold bridge were
// deleted in #703) and its sole reader was the `src/cost/surrogate.ts` legacy
// back-compat path, which #704 also removed. The live cost guardrail is
// `src/cost/usage-tracker.ts`.

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
// Budget-threshold idempotency (issue #673) accessors removed in #703 together
// with the dead budget-threshold bridge that was their only consumer. The
// bridge polled `hydra:scheduler:daily-spend` (no live writer) and never
// emitted an event. The live cost guardrail is `src/cost/usage-tracker.ts`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Housekeeping Redis ops moved to src/redis/housekeeping.ts (issue #1956)
// ---------------------------------------------------------------------------
//
// The 8 Housekeeping-domain time-guard accessors (getBlockedLastEscalation,
// setBlockedLastEscalation, getDigestLastWeekly, setDigestLastWeekly,
// getMemoryLastConsolidation, setMemoryLastConsolidation, getCleanupLastDaily,
// setCleanupLastDaily) that previously lived here have been relocated to
// src/redis/housekeeping.ts. They carried non-scheduler key namespaces
// (hydra:blocked:*, hydra:digest:*, hydra:memory:*, hydra:cleanup:*) and
// were consumed only by src/scheduler/housekeeping.ts. The key strings on
// disk are UNCHANGED — this was a source-location move, not a key migration.

// ---------------------------------------------------------------------------
// Research floor (issue #84/#327) accessors removed in #706 (scheduler fold
// PR-1/4) together with the research-decision plane that was their only
// consumer. The research-force policy now lives in the autopilot brain
// (`scripts/autopilot/decide.py` `_research_force_allowed`).
// ---------------------------------------------------------------------------
