/**
 * Anchor-selection Redis seam — typed accessors for the anchor-selection
 * family's Redis surfaces. ADR-0009 closure follow-up: drains the
 * src/anchor-selection/* baseline by hiding raw kv primitives behind a
 * named operation per business action.
 *
 * Key shapes live in src/anchor-selection/constants.ts (next to their
 * policy thresholds — REFRAME_QUEUE_CAP, ABANDONMENT_COUNTER_TTL, etc.).
 * This module imports those keys and exposes the operations that touch
 * them.
 */

import {
  ABANDONMENT_COUNTER_TTL,
  PERM_SKIP_PREFIX,
  PRIOR_FAILURES_KEY,
  PROCESSING_QUEUE,
  REFRAME_QUEUE,
  REGRESSION_HUNT_LAST_KEY,
  WORK_QUEUE,
  anchorKey,
  taskKey,
} from "../anchor-selection/constants.ts";
import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Abandonment counter (per-anchor circuit breaker)
// ---------------------------------------------------------------------------

/** Increment the abandonment counter for `anchorRef` and refresh its TTL. */
export async function incrAbandonment(anchorRef: string): Promise<number> {
  const r = getRedisConnection();
  const key = anchorKey(anchorRef);
  const count = await r.incr(key);
  await r.expire(key, ABANDONMENT_COUNTER_TTL);
  return count;
}

/** Clear the abandonment counter (called on successful reframe escalation). */
export async function clearAbandonment(anchorRef: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(anchorKey(anchorRef));
}

/** Read the current abandonment count for `anchorRef` (0 when absent). */
export async function readAbandonment(anchorRef: string): Promise<number> {
  const r = getRedisConnection();
  const raw = await r.get(anchorKey(anchorRef));
  if (raw == null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Permanent-skip counter (low-confidence anchor suppression)
// ---------------------------------------------------------------------------

function permSkipKey(anchorRef: string): string {
  return PERM_SKIP_PREFIX + anchorRef.replace(/\s+/g, "-").slice(0, 120);
}

/** Increment the perm-skip counter for `anchorRef` and refresh its TTL. */
export async function incrPermSkip(anchorRef: string): Promise<number> {
  const r = getRedisConnection();
  const key = permSkipKey(anchorRef);
  const count = await r.incr(key);
  await r.expire(key, ABANDONMENT_COUNTER_TTL);
  return count;
}

/** Read the current perm-skip count for `anchorRef` (0 when absent). */
export async function readPermSkip(anchorRef: string): Promise<number> {
  const r = getRedisConnection();
  const raw = await r.get(permSkipKey(anchorRef));
  if (raw == null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Reframe queue (failed-task retry lane)
// ---------------------------------------------------------------------------

/** Read every item in the reframe queue, oldest-first. */
export async function getReframeQueueItems(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(REFRAME_QUEUE, 0, -1);
}

/** Length of the reframe queue. */
export async function getReframeQueueLength(): Promise<number> {
  const r = getRedisConnection();
  return r.llen(REFRAME_QUEUE);
}

/** Pop the head (oldest) item off the reframe queue. */
export async function popReframeQueueHead(): Promise<string | null> {
  const r = getRedisConnection();
  return r.lpop(REFRAME_QUEUE);
}

/** Append a single item to the reframe queue. */
export async function pushReframeItem(json: string): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(REFRAME_QUEUE, json);
}

/** Overwrite the reframe queue with `items` (drops existing entries). */
export async function replaceReframeQueue(items: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.del(REFRAME_QUEUE);
  if (items.length > 0) await r.rpush(REFRAME_QUEUE, ...items);
}

// ---------------------------------------------------------------------------
// Prior-failures queue
// ---------------------------------------------------------------------------

/** Read every prior-failure entry, oldest-first. */
export async function getPriorFailures(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(PRIOR_FAILURES_KEY, 0, -1);
}

/** Length of the prior-failures queue. */
export async function getPriorFailuresLen(): Promise<number> {
  const r = getRedisConnection();
  return r.llen(PRIOR_FAILURES_KEY);
}

/** Append a serialized prior-failure entry. */
export async function appendPriorFailure(json: string): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(PRIOR_FAILURES_KEY, json);
}

/** Remove a specific entry (by value) from the prior-failures queue. */
export async function removePriorFailure(json: string): Promise<void> {
  const r = getRedisConnection();
  await r.lrem(PRIOR_FAILURES_KEY, 1, json);
}

/** Pop the oldest prior-failure entry. */
export async function popOldestPriorFailure(): Promise<string | null> {
  const r = getRedisConnection();
  return r.lpop(PRIOR_FAILURES_KEY);
}

/** Read the per-task hash (title, description, etc.) used by selectPriorFailureAnchor. */
export async function getTaskHash(taskId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(taskKey(taskId));
}

/** Does a task hash still exist for `taskId`? Used to prune orphan prior-failures. */
export async function taskHashExists(taskId: string): Promise<boolean> {
  const r = getRedisConnection();
  return (await r.exists(taskKey(taskId))) === 1;
}

// ---------------------------------------------------------------------------
// Anchor work queue + processing queue (POST /queue + research auto-queue)
// ---------------------------------------------------------------------------

/** Read every item currently in the processing queue (for crash recovery). */
export async function getProcessingQueueItems(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(PROCESSING_QUEUE, 0, -1);
}

/** Append a serialized work-queue entry to WORK_QUEUE. */
export async function pushToAnchorWorkQueue(json: string): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(WORK_QUEUE, json);
}

/** Drop the entire processing queue (called after crash-recovery move-back). */
export async function clearProcessingQueue(): Promise<void> {
  const r = getRedisConnection();
  await r.del(PROCESSING_QUEUE);
}

/**
 * Atomically move the head of WORK_QUEUE onto the tail of PROCESSING_QUEUE.
 * Returns the moved item, or null when WORK_QUEUE is empty.
 */
export async function claimNextWorkQueueItem(): Promise<string | null> {
  const r = getRedisConnection();
  return r.lmove(WORK_QUEUE, PROCESSING_QUEUE, "LEFT", "RIGHT");
}

/** Remove one occurrence of `json` from the processing queue. */
export async function removeFromProcessingQueue(json: string): Promise<void> {
  const r = getRedisConnection();
  await r.lrem(PROCESSING_QUEUE, 1, json);
}

// ---------------------------------------------------------------------------
// Regression-hunt cooldown marker
// ---------------------------------------------------------------------------

/** Read the most recent regression-hunt timestamp (null when cooled down). */
export async function getRegressionHuntLast(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(REGRESSION_HUNT_LAST_KEY);
}

/** Stamp the regression-hunt cooldown marker with an explicit TTL. */
export async function setRegressionHuntLast(iso: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.set(REGRESSION_HUNT_LAST_KEY, iso, "EX", ttlSeconds);
}

/** Read the cycle-metrics ZSET index (re-export — used by drift-filter + regression-hunt). */
export { getRecentMetricIds, getCycleMetrics } from "./cycle-metrics.ts";
