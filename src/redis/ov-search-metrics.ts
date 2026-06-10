/**
 * OpenViking search-quality metrics Redis seam (issue #1440).
 *
 * `trackedOvSearch` (src/knowledge-base/ov-search.ts) accumulates search-quality
 * counters — totalSearches, zeroResultCount, totalResults, fallbackAttempts,
 * fallbackSuccesses, errors — but before this seam they lived ONLY in process
 * memory: they reset on every orchestrator restart and were never trended. An
 * agent query that returns 5 results and one that returns 0 logged identically;
 * the operator had no way to see "search quality degraded this hour".
 *
 * This seam gives the in-memory counters a durable, hour-bucketed home so the
 * health surface can render zero-result-rate and fallback-success trends across
 * restarts. It mirrors the structure of `scope-violations.ts`: a per-UTC-hour
 * counter set with a rolling TTL, pure key/aggregation helpers exported for
 * tests, and a never-throw write contract (a metrics write must never break the
 * search path it observes).
 *
 * Storage: one Redis hash per UTC hour, fields are the cumulative counters for
 * searches that completed in that hour. The flush is additive (HINCRBY a delta),
 * so a 5-minute batched flush from `trackedOvSearch` rolls the in-memory deltas
 * into the current hour bucket without losing counts across flushes.
 *
 * Per-anchor knowledge-context availability (issue #1440 item 2) is a separate
 * per-UTC-day counter pair (cyclesWithContext / cyclesTotal) so the operator can
 * see "what fraction of planned cycles saw non-empty knowledge context".
 */

import { getRedisConnection } from "./connection.ts";

/**
 * 7 days. A rolling-window read of the last N hours never needs more, and the
 * hour buckets are tiny (one small hash each), so a week of history is cheap.
 */
export const OV_SEARCH_METRICS_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 30 days for the per-day context-availability counters (coarser, longer-lived). */
export const OV_CONTEXT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The metric fields persisted per hour bucket. Stable string keys (Redis hash fields). */
export const OV_SEARCH_METRIC_FIELDS = [
  "totalSearches",
  "zeroResultCount",
  "totalResults",
  "totalLatencyMs",
  "fallbackAttempts",
  "fallbackSuccesses",
  "errors",
] as const;

export type OvSearchMetricField = (typeof OV_SEARCH_METRIC_FIELDS)[number];

/** The delta shape `trackedOvSearch` flushes — a subset/superset of the fields above. */
export type OvSearchMetricsDelta = Partial<Record<OvSearchMetricField, number>>;

/** Per-hour bucket counters plus the derived rates the health surface renders. */
export interface OvSearchWindowBucket {
  hour: string;
  totalSearches: number;
  zeroResultCount: number;
  totalResults: number;
  totalLatencyMs: number;
  fallbackAttempts: number;
  fallbackSuccesses: number;
  errors: number;
}

/** Aggregate rollup over a rolling window of hour buckets. */
export interface OvSearchWindowRollup {
  windowHours: number;
  totalSearches: number;
  zeroResultCount: number;
  totalResults: number;
  fallbackAttempts: number;
  fallbackSuccesses: number;
  errors: number;
  zeroResultRate: number;
  fallbackSuccessRate: number;
  avgResultsPerQuery: number;
  avgLatencyMs: number;
  buckets: OvSearchWindowBucket[];
}

/** Per-day knowledge-context availability for planned cycles. */
export interface OvContextAvailability {
  windowDays: number;
  cyclesTotal: number;
  cyclesWithContext: number;
  contextAvailabilityRate: number;
  days: Array<{ date: string; cyclesTotal: number; cyclesWithContext: number }>;
}

// ===========================================================================
// Pure key + time helpers (exported for tests — no Redis access)
// ===========================================================================

/** UTC YYYY-MM-DDTHH for a Date — the hour-bucket key suffix. */
export function utcHourKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}`;
}

/** UTC YYYY-MM-DD for a Date — the per-day context-availability key suffix. */
export function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function windowHashKey(hour: string): string {
  return `hydra:metrics:ov-search:window-1h:${hour}`;
}

function contextDayKey(date: string): string {
  return `hydra:metrics:ov-search:context:daily:${date}`;
}

/**
 * Fold a list of hour buckets into a single rolling-window rollup with derived
 * rates. Pure — no Redis. Rates are 0 (never NaN) when their denominator is 0.
 */
export function rollupWindow(
  buckets: OvSearchWindowBucket[],
  windowHours: number,
): OvSearchWindowRollup {
  const sum = buckets.reduce(
    (acc, b) => {
      acc.totalSearches += b.totalSearches;
      acc.zeroResultCount += b.zeroResultCount;
      acc.totalResults += b.totalResults;
      acc.totalLatencyMs += b.totalLatencyMs;
      acc.fallbackAttempts += b.fallbackAttempts;
      acc.fallbackSuccesses += b.fallbackSuccesses;
      acc.errors += b.errors;
      return acc;
    },
    {
      totalSearches: 0,
      zeroResultCount: 0,
      totalResults: 0,
      totalLatencyMs: 0,
      fallbackAttempts: 0,
      fallbackSuccesses: 0,
      errors: 0,
    },
  );

  const zeroResultRate = sum.totalSearches > 0 ? sum.zeroResultCount / sum.totalSearches : 0;
  const fallbackSuccessRate = sum.fallbackAttempts > 0 ? sum.fallbackSuccesses / sum.fallbackAttempts : 0;
  const avgResultsPerQuery = sum.totalSearches > 0 ? sum.totalResults / sum.totalSearches : 0;
  const avgLatencyMs = sum.totalSearches > 0 ? sum.totalLatencyMs / sum.totalSearches : 0;

  return {
    windowHours,
    totalSearches: sum.totalSearches,
    zeroResultCount: sum.zeroResultCount,
    totalResults: sum.totalResults,
    fallbackAttempts: sum.fallbackAttempts,
    fallbackSuccesses: sum.fallbackSuccesses,
    errors: sum.errors,
    zeroResultRate: Math.round(zeroResultRate * 1000) / 1000,
    fallbackSuccessRate: Math.round(fallbackSuccessRate * 1000) / 1000,
    avgResultsPerQuery: Math.round(avgResultsPerQuery * 100) / 100,
    avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
    buckets,
  };
}

// ===========================================================================
// Redis I/O (never-throw at the call sites; see ov-search.ts flush wrapper)
// ===========================================================================

/**
 * Roll a delta of search counters into the current UTC-hour bucket (HINCRBY per
 * field) and stamp the rolling TTL. Zero/absent deltas are skipped so an empty
 * flush is a cheap no-op. Returns the hour key written (for logging/tests).
 *
 * Callers wrap this best-effort: a Redis error must never break the search path.
 */
export async function recordOvSearchDelta(
  delta: OvSearchMetricsDelta,
  now: Date = new Date(),
): Promise<string> {
  const hour = utcHourKey(now);
  const key = windowHashKey(hour);
  const r = getRedisConnection();
  const pipe = r.pipeline();
  let wrote = false;
  for (const field of OV_SEARCH_METRIC_FIELDS) {
    const v = delta[field];
    if (typeof v === "number" && v !== 0) {
      pipe.hincrby(key, field, Math.trunc(v));
      wrote = true;
    }
  }
  if (wrote) {
    pipe.expire(key, OV_SEARCH_METRICS_TTL_SECONDS);
    await pipe.exec();
  }
  return hour;
}

/**
 * Read the last `hours` UTC-hour buckets ending at `now`, newest-first, folded
 * into a rolling-window rollup. Missing hours read as all-zero buckets.
 * Pipelined into a single round-trip.
 */
export async function getOvSearchWindow(
  hours = 24,
  now: Date = new Date(),
): Promise<OvSearchWindowRollup> {
  const n = Math.max(1, Math.floor(hours));
  const hourKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    hourKeys.push(utcHourKey(d));
  }
  const r = getRedisConnection();
  const pipe = r.pipeline();
  for (const hour of hourKeys) pipe.hgetall(windowHashKey(hour));
  const results = await pipe.exec();

  const buckets: OvSearchWindowBucket[] = [];
  for (let i = 0; i < hourKeys.length; i++) {
    const res = Array.isArray(results) ? results[i] : null;
    const raw = Array.isArray(res) && res[0] == null ? res[1] : null;
    const h: Record<string, string> = raw && typeof raw === "object" ? raw : {};
    buckets.push({
      hour: hourKeys[i],
      totalSearches: num(h.totalSearches),
      zeroResultCount: num(h.zeroResultCount),
      totalResults: num(h.totalResults),
      totalLatencyMs: num(h.totalLatencyMs),
      fallbackAttempts: num(h.fallbackAttempts),
      fallbackSuccesses: num(h.fallbackSuccesses),
      errors: num(h.errors),
    });
  }
  return rollupWindow(buckets, n);
}

/**
 * Record one planned-cycle observation: whether the planner saw non-empty
 * knowledge context. Increments the per-UTC-day `cyclesTotal` and, when
 * `hadContext`, `cyclesWithContext`, then stamps the TTL.
 *
 * Best-effort: callers wrap this so a Redis error never breaks planning.
 */
export async function recordKnowledgeContextAvailability(
  hadContext: boolean,
  now: Date = new Date(),
): Promise<void> {
  const key = contextDayKey(utcDayKey(now));
  const r = getRedisConnection();
  const pipe = r.pipeline();
  pipe.hincrby(key, "cyclesTotal", 1);
  if (hadContext) pipe.hincrby(key, "cyclesWithContext", 1);
  pipe.expire(key, OV_CONTEXT_TTL_SECONDS);
  await pipe.exec();
}

/**
 * Read the per-day context-availability counters for the last `days` UTC days
 * ending at `now`, newest-first, with the rolled-up availability rate.
 */
export async function getKnowledgeContextAvailability(
  days = 7,
  now: Date = new Date(),
): Promise<OvContextAvailability> {
  const n = Math.max(1, Math.floor(days));
  const dayKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dayKeys.push(utcDayKey(d));
  }
  const r = getRedisConnection();
  const pipe = r.pipeline();
  for (const date of dayKeys) pipe.hgetall(contextDayKey(date));
  const results = await pipe.exec();

  let cyclesTotal = 0;
  let cyclesWithContext = 0;
  const out: Array<{ date: string; cyclesTotal: number; cyclesWithContext: number }> = [];
  for (let i = 0; i < dayKeys.length; i++) {
    const res = Array.isArray(results) ? results[i] : null;
    const raw = Array.isArray(res) && res[0] == null ? res[1] : null;
    const h: Record<string, string> = raw && typeof raw === "object" ? raw : {};
    const t = num(h.cyclesTotal);
    const w = num(h.cyclesWithContext);
    cyclesTotal += t;
    cyclesWithContext += w;
    out.push({ date: dayKeys[i], cyclesTotal: t, cyclesWithContext: w });
  }
  return {
    windowDays: n,
    cyclesTotal,
    cyclesWithContext,
    contextAvailabilityRate:
      cyclesTotal > 0 ? Math.round((cyclesWithContext / cyclesTotal) * 1000) / 1000 : 0,
    days: out,
  };
}

/** Coerce a Redis hash field string to a finite number, defaulting to 0. */
function num(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0;
}
