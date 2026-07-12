/**
 * Cycle metrics Redis ops. Extracted from redis-adapter.ts (issue #269).
 * The cost accessors over the writer-less `:agents`/`:costs` sub-keys were
 * retired with the USD attribution plane (#1651, ADR-0016).
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Store a cycle's flattened metrics hash and add to the index.
 */
export async function setCycleMetrics(
  cycleId: string,
  flat: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.metrics(cycleId), ...Object.entries(flat).flat());
  await r.expire(redisKeys.metrics(cycleId), ttlSeconds);
  await r.zadd(redisKeys.metricsIndex(), Date.now(), cycleId);
}

/**
 * Additively HSET a subset of fields onto a cycle's metrics hash WITHOUT
 * touching the metrics index (issue #3252). Used only for the cross-key
 * test-count mirror in `recordCycleMetrics`: reap keys its cycle-record on the
 * bare worktree-hash `task_id` (the deposit key it can read the grounding test
 * counts from) while the merge-watch enrichment + dashboards read the SEPARATE
 * `worktreeBranch`-keyed record — an un-joinable runToken vs worktree-hash split
 * that left `testsAfter` recording 0 on the branch record every cycle. This
 * mirror copies the four test fields onto the branch record so the record the
 * aggregators sample finally carries them.
 *
 * Deliberately does NOT `zadd` the index: the mirror must never mint a fresh
 * index entry for a branch cycleId that no other writer indexed (that would
 * inflate the cycle count with a fields-partial phantom). It also does not touch
 * TTL — the record's own writer (merge-watch, or a reap write under that key)
 * owns the TTL; a bare enrich of an as-yet-unwritten branch hash gets no TTL and
 * is a harmless self-expiring no-op until the real writer lands and (re)sets it.
 * A no-op when `fields` is empty.
 */
export async function enrichCycleMetrics(
  cycleId: string,
  fields: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const r = getRedisConnection();
  await r.hset(redisKeys.metrics(cycleId), ...entries.flat());
}

/**
 * Fetch the N most recent cycle IDs from the metrics index.
 */
export async function getRecentMetricIds(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.metricsIndex(), 0, count - 1);
}

/**
 * Fetch all fields of a cycle's metrics hash.
 */
export async function getCycleMetrics(cycleId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.metrics(cycleId));
}

/**
 * Remove metrics index entries below a score cutoff.
 * Returns the number of entries removed.
 */
export async function pruneMetricsIndex(cutoffMs: number): Promise<number> {
  const r = getRedisConnection();
  return r.zremrangebyscore(redisKeys.metricsIndex(), "-inf", cutoffMs);
}

/**
 * Get the cardinality of the metrics index.
 */
export async function getMetricsIndexSize(): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(redisKeys.metricsIndex());
}

/**
 * Trim the metrics index to keep only the top maxEntries (by score).
 * Removes the lowest-scored entries.
 */
export async function trimMetricsIndex(excess: number): Promise<void> {
  const r = getRedisConnection();
  await r.zremrangebyrank(redisKeys.metricsIndex(), 0, excess - 1);
}

/**
 * Fetch recent metric cycle IDs from the metrics index (newest first).
 */
export async function getRecentMetricIdsDesc(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.metricsIndex(), 0, count - 1);
}
