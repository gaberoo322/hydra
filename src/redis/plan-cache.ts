/**
 * Plan cache Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { getRedisConnection } from "./connection.ts";
import { redisKeys } from "../redis-keys.ts";

/** Metric names for persisted plan-cache counters (issue #325). */
export type PlanCacheStatMetric = "hits" | "misses" | "stored" | "invalidated" | "stale";

/** Per-day key TTL — keeps storage bounded while allowing 24h windows. */
const STAT_DAY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** UTC ISO date (YYYY-MM-DD) used to suffix per-day stat keys. */
export function statDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Get a cached plan entry by full key.
 */
export async function getPlanCacheEntry(key: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(key);
}

/**
 * Store a plan cache entry with TTL.
 */
export async function setPlanCacheEntry(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(key, value, "EX", ttlSeconds);
}

/**
 * Delete a plan cache entry by key.
 */
export async function deletePlanCacheEntry(key: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(key);
}

/**
 * Find all keys matching the plan cache prefix.
 */
export async function findPlanCacheKeys(prefix: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.keys(`${prefix}*`);
}

/**
 * Increment both the lifetime counter and the current UTC-day counter for a
 * plan-cache stat metric. Per-day key gets a 7-day TTL so the rolling 24h
 * window is computable without unbounded growth. (issue #325)
 *
 * Increments by `delta` (default 1). Pipelined for fewer round trips.
 *
 * Failures are swallowed and logged — instrumentation must never break the
 * cache path.
 */
export async function incrPlanCacheStat(
  metric: PlanCacheStatMetric,
  delta: number = 1,
): Promise<void> {
  if (delta <= 0) return;
  const r = getRedisConnection();
  const lifetimeKey = redisKeys.planCacheStatLifetime(metric);
  const dayKey = redisKeys.planCacheStatDay(metric, statDayKey());
  try {
    const pipeline = r.pipeline();
    pipeline.incrby(lifetimeKey, delta);
    pipeline.incrby(dayKey, delta);
    pipeline.expire(dayKey, STAT_DAY_TTL_SECONDS);
    await pipeline.exec();
  } catch (err: any) {
    console.error(`[PlanCache] incrPlanCacheStat(${metric}) failed: ${err.message}`);
  }
}

/**
 * Read lifetime counters for all plan-cache metrics. Returns zeros for any
 * missing keys (fresh installs).
 */
export async function getPlanCacheStatsLifetime(): Promise<
  Record<PlanCacheStatMetric, number>
> {
  const r = getRedisConnection();
  const metrics: PlanCacheStatMetric[] = ["hits", "misses", "stored", "invalidated", "stale"];
  const keys = metrics.map((m) => redisKeys.planCacheStatLifetime(m));
  try {
    const values = await r.mget(...keys);
    const out = {} as Record<PlanCacheStatMetric, number>;
    metrics.forEach((m, i) => {
      const v = values[i];
      out[m] = v ? parseInt(v, 10) || 0 : 0;
    });
    return out;
  } catch (err: any) {
    console.error(`[PlanCache] getPlanCacheStatsLifetime failed: ${err.message}`);
    return { hits: 0, misses: 0, stored: 0, invalidated: 0, stale: 0 };
  }
}

/**
 * Read a rolling 24h window of counters by summing today + yesterday's UTC
 * per-day keys. (A true sliding window would need per-minute keys; this gives
 * an operator-useful "what's the cache doing lately" view at minimal cost.)
 */
export async function getPlanCacheStatsLast24h(
  now: Date = new Date(),
): Promise<Record<PlanCacheStatMetric, number>> {
  const r = getRedisConnection();
  const metrics: PlanCacheStatMetric[] = ["hits", "misses", "stored", "invalidated", "stale"];
  const today = statDayKey(now);
  const yesterday = statDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const keys: string[] = [];
  for (const m of metrics) {
    keys.push(redisKeys.planCacheStatDay(m, today));
    keys.push(redisKeys.planCacheStatDay(m, yesterday));
  }
  try {
    const values = await r.mget(...keys);
    const out = {} as Record<PlanCacheStatMetric, number>;
    metrics.forEach((m, i) => {
      const a = values[i * 2];
      const b = values[i * 2 + 1];
      out[m] = (a ? parseInt(a, 10) || 0 : 0) + (b ? parseInt(b, 10) || 0 : 0);
    });
    return out;
  } catch (err: any) {
    console.error(`[PlanCache] getPlanCacheStatsLast24h failed: ${err.message}`);
    return { hits: 0, misses: 0, stored: 0, invalidated: 0, stale: 0 };
  }
}
