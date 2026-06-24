/**
 * Housekeeping Redis ops: per-chore idempotency time-guards.
 *
 * Extracted from redis/scheduler.ts (issue #1956). These 8 accessors carry
 * non-scheduler key namespaces (hydra:blocked:*, hydra:digest:*,
 * hydra:memory:*, hydra:cleanup:*) and are consumed ONLY by
 * src/scheduler/housekeeping.ts. Moving them here:
 *
 *   1. Concentrates the Housekeeping Redis contract at a natural boundary
 *      (new time-guard → add here + one import line in housekeeping.ts).
 *   2. Eliminates the cross-domain coupling in redis/scheduler.ts (which
 *      now honestly owns only Scheduler ops: counters, state, research
 *      events, deliberate-stop).
 *   3. Makes the Seam unit-testable in isolation (stub getRedisConnection,
 *      exercise time-guard round-trips without importing Lua scripts or
 *      scheduler cycle counters).
 *
 * KEY STRINGS ARE UNCHANGED — this is a source-location move, not a key
 * migration. npm test exercises the time-guard round-trips through the
 * housekeeping API route (api-maintenance.test.mts) and would fail if any
 * accessor was dropped or renamed.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

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

// Weekly usage-snapshot cadence stamp (issue #2404). Same shape as the
// weekly-digest guard above — the chore persists the per-skill rollup at most
// once per ISO week; this is the composition-level cadence stamp.
export async function getUsageSnapshotLastWeekly(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.usageSnapshotLastWeekly());
}

export async function setUsageSnapshotLastWeekly(value: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.usageSnapshotLastWeekly(), value);
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
// Cleanup daily-sweep timestamp (issue #1876)
// ---------------------------------------------------------------------------
//
// The stale-Redis-key sweep was folded out of the cleanup.ts in-process 24h
// setInterval into a housekeeping Chore. Housekeeping runs hourly, so the
// chore carries a daily time-guard stamped here — the same shape as the
// weekly-digest / memory-consolidation guards above.

export async function getCleanupLastDaily(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.cleanupLastDaily());
}

export async function setCleanupLastDaily(value: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cleanupLastDaily(), value);
}
