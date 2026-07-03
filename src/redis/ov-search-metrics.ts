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
import { boundedJsonList } from "./bounded-list.ts";

/**
 * 7 days. A rolling-window read of the last N hours never needs more, and the
 * hour buckets are tiny (one small hash each), so a week of history is cheap.
 */
const OV_SEARCH_METRICS_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 30 days for the per-day context-availability counters (coarser, longer-lived). */
const OV_CONTEXT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Cap for the per-fetch knowledge-retrieval ledger (issue #2717). One row is
 * appended per served `/api/learning/knowledge` fetch; the shared
 * `boundedJsonList` primitive (ADR-0017 Category C) keeps the newest N rows
 * (lpush + ltrim) and drops the tail, so the ledger never grows unbounded. 5000
 * rows is a few hundred KB and comfortably covers the volume needed before the
 * deferred correlation slice (join against cycle outcomes) becomes worthwhile.
 * Env-overridable via `HYDRA_KNOWLEDGE_FETCH_LEDGER_MAX` for a larger dwell.
 */
const KNOWLEDGE_FETCH_LEDGER_MAX = (() => {
  const raw = Number(process.env.HYDRA_KNOWLEDGE_FETCH_LEDGER_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
})();

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

type OvSearchMetricField = (typeof OV_SEARCH_METRIC_FIELDS)[number];

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

/**
 * One raw observation row for the per-fetch knowledge-retrieval ledger
 * (issue #2717). Written once per served `/api/learning/knowledge` fetch. It
 * carries enough to JOIN a retrieval against a cycle outcome LATER (the deferred
 * correlation slice) — the dark-tolerant-ledger philosophy of the #2628
 * attribution spine: record the raw rows now, estimate later.
 *
 * - `ts`      — epoch millis the fetch was served.
 * - `agent`   — the fetching agent/skill (`hydra-dev`, `hydra-target-build`, …).
 * - `anchor`  — the anchor/cycle identifier the fetch was for (e.g. `issue-2717`),
 *               when the dispatch sent one; `null` if the fetch was anchor-less.
 *               This is the join key against the dispatch outcome.
 * - `itemCount` — how many knowledge items were served (0 on a miss).
 * - `itemIds` — stable per-item identifiers (content-hash of each served item),
 *               so a later analysis can tell WHICH items appeared in a
 *               successful dispatch, not merely how many.
 */
export interface KnowledgeLedgerRow {
  ts: number;
  agent: string;
  anchor: string | null;
  itemCount: number;
  itemIds: string[];
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

/** The single capped-list key holding the per-fetch knowledge-retrieval ledger (#2717). */
function knowledgeFetchLedgerKey(): string {
  return `hydra:metrics:ov-search:knowledge-fetch:ledger`;
}

/** The shared bounded-JSON-list handle for the knowledge-fetch ledger (ADR-0017 Category C). */
function knowledgeFetchLedger() {
  return boundedJsonList<KnowledgeLedgerRow>(
    knowledgeFetchLedgerKey(),
    KNOWLEDGE_FETCH_LEDGER_MAX,
  );
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

/**
 * Append one row to the per-fetch knowledge-retrieval ledger (issue #2717).
 * Each served `/api/learning/knowledge` fetch writes exactly one row through the
 * shared `boundedJsonList` primitive (ADR-0017 Category C): lpush newest-first +
 * ltrim to `KNOWLEDGE_FETCH_LEDGER_MAX`, so it never grows unbounded. Rows go to
 * a dedicated key (`hydra:metrics:ov-search:knowledge-fetch:ledger`) — NEVER
 * into `hydra:attribution:*`, whose LedgerRow union is the #2630 estimator's raw
 * input and stays free of foreign row shapes.
 *
 * Best-effort: callers wrap this so a Redis error never breaks the plan-time
 * fetch it observes — the same never-throw contract as the availability record.
 */
export async function appendKnowledgeFetch(row: KnowledgeLedgerRow): Promise<void> {
  await knowledgeFetchLedger().push(row);
}

/**
 * Read back the most recent `limit` knowledge-retrieval ledger rows, newest
 * first, through the shared `boundedJsonList` primitive (whose read is tolerant
 * of JSON-corrupt entries — one bad row can't break the whole read).
 */
export async function getKnowledgeFetchLedger(limit = 100): Promise<KnowledgeLedgerRow[]> {
  const n = Math.max(1, Math.min(KNOWLEDGE_FETCH_LEDGER_MAX, Math.floor(limit)));
  return knowledgeFetchLedger().read(n);
}

/** Coerce a Redis hash field string to a finite number, defaulting to 0. */
function num(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0;
}
