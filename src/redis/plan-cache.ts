/**
 * Plan cache Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { getRedisConnection } from "./connection.ts";
import { redisKeys } from "../redis-keys.ts";

/** Metric names for persisted plan-cache counters (issue #325). */
export type PlanCacheStatMetric = "hits" | "misses" | "stored" | "invalidated" | "stale";

/**
 * Miss-reason labels for the histogram persisted alongside the plan-cache
 * stats (issue #363). Every cache miss is attributed to exactly one reason so
 * operators can answer "why is the hit rate 0?" without rerunning the system.
 *
 * Labels:
 *  - `not-found`             — cache lookup returned no entry for the key
 *  - `non-cacheable-type`    — anchor.type not in CACHEABLE_TYPES
 *  - `reflection-bypass`     — reflections exist; cache deliberately skipped
 *                              (reserved for explicit-skip paths, e.g. high-risk
 *                              anchors; the default path now uses reflection
 *                              digest comparison via `reflection-changed`)
 *  - `reflection-changed`    — entry evicted: reflection digest differs from
 *                              the digest stored with the cached plan, so the
 *                              cached plan was produced under a stale set of
 *                              prior-attempt reflections (issue #375)
 *  - `actionability-skipped` — pre-planner gate fired before cache was queried
 *  - `stale-tests`           — entry evicted: test count dropped since cache
 *  - `stale-files`           — entry evicted: scope file modified since cache
 *  - `get-error`             — Redis read failed; treated as miss
 *
 * Both reflection-bypass and actionability-skipped are bookkeeping reasons
 * (the cache was never queried), recorded at the call site in planner-prompt.
 * They count toward the misses total so the hit rate stays interpretable as
 * "of all planner calls that needed a plan, what fraction reused one?".
 */
export type PlanCacheMissReason =
  | "not-found"
  | "non-cacheable-type"
  | "reflection-bypass"
  | "reflection-changed"
  | "actionability-skipped"
  | "stale-tests"
  | "stale-files"
  | "get-error";

/** Per-day key TTL — keeps storage bounded while allowing 24h windows. */
const STAT_DAY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Shared prefix all plan-cache entries (and the `stats:` sub-namespace) live under. */
export const PLAN_CACHE_PREFIX = redisKeys.planCachePrefix();

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
 * Increment the miss-reason histogram (issue #363). Stores into a Redis hash
 * keyed by reason, alongside a per-day variant with the same TTL strategy as
 * the metric counters above.
 *
 * Fire-and-forget: errors are logged and swallowed. The cache hot path must
 * never break because of instrumentation.
 */
export async function incrPlanCacheMissReason(
  reason: PlanCacheMissReason,
): Promise<void> {
  const r = getRedisConnection();
  const lifetimeKey = redisKeys.planCacheMissReasonsLifetime();
  const dayKey = redisKeys.planCacheMissReasonsDay(statDayKey());
  try {
    const pipeline = r.pipeline();
    pipeline.hincrby(lifetimeKey, reason, 1);
    pipeline.hincrby(dayKey, reason, 1);
    pipeline.expire(dayKey, STAT_DAY_TTL_SECONDS);
    await pipeline.exec();
  } catch (err: any) {
    console.error(`[PlanCache] incrPlanCacheMissReason(${reason}) failed: ${err.message}`);
  }
}

/**
 * Read the lifetime miss-reason histogram. Returns a Record keyed by reason
 * label with integer counts (0 for any missing reason).
 */
export async function getPlanCacheMissReasonsLifetime(): Promise<
  Record<PlanCacheMissReason, number>
> {
  const r = getRedisConnection();
  try {
    const raw = await r.hgetall(redisKeys.planCacheMissReasonsLifetime());
    return parseMissReasonHash(raw);
  } catch (err: any) {
    console.error(`[PlanCache] getPlanCacheMissReasonsLifetime failed: ${err.message}`);
    return emptyMissReasonHistogram();
  }
}

/**
 * Read the rolling 24h miss-reason histogram (today + yesterday UTC).
 */
export async function getPlanCacheMissReasonsLast24h(
  now: Date = new Date(),
): Promise<Record<PlanCacheMissReason, number>> {
  const r = getRedisConnection();
  const today = statDayKey(now);
  const yesterday = statDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  try {
    const [a, b] = await Promise.all([
      r.hgetall(redisKeys.planCacheMissReasonsDay(today)),
      r.hgetall(redisKeys.planCacheMissReasonsDay(yesterday)),
    ]);
    const merged = emptyMissReasonHistogram();
    for (const part of [a, b]) {
      const parsed = parseMissReasonHash(part);
      for (const k of MISS_REASON_LABELS) {
        merged[k] += parsed[k];
      }
    }
    return merged;
  } catch (err: any) {
    console.error(`[PlanCache] getPlanCacheMissReasonsLast24h failed: ${err.message}`);
    return emptyMissReasonHistogram();
  }
}

const MISS_REASON_LABELS: PlanCacheMissReason[] = [
  "not-found",
  "non-cacheable-type",
  "reflection-bypass",
  "reflection-changed",
  "actionability-skipped",
  "stale-tests",
  "stale-files",
  "get-error",
];

function emptyMissReasonHistogram(): Record<PlanCacheMissReason, number> {
  const out = {} as Record<PlanCacheMissReason, number>;
  for (const k of MISS_REASON_LABELS) out[k] = 0;
  return out;
}

function parseMissReasonHash(
  raw: Record<string, string> | null | undefined,
): Record<PlanCacheMissReason, number> {
  const out = emptyMissReasonHistogram();
  if (!raw) return out;
  for (const k of MISS_REASON_LABELS) {
    const v = raw[k];
    if (v) {
      const n = parseInt(v, 10);
      out[k] = Number.isFinite(n) ? n : 0;
    }
  }
  return out;
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
