/**
 * learning/ov-search.ts — OpenViking search + session lifecycle
 *
 * Extracted from learning.ts (issue #219) so the OV search wrapper, in-memory
 * metrics, fallback-query helper, and session factory live independently of
 * agent memory and reflection storage.
 *
 * Public API:
 *   getOvSearchMetrics, resetOvSearchMetrics — metrics for /api/health
 *   buildFallbackQuery                       — pure helper, exported for tests
 *   trackedOvSearch                          — used by codex-runner + this module
 *
 * Behavior preserved 1:1 from the previous learning.ts implementation.
 */

// OpenViking connection config — single source of truth in ov-config.ts (issue #231).
// Re-exported under the historical OV_URL / OV_KEY / OV_HEADERS names so existing
// importers keep compiling without churn.
import { OPENVIKING_URL, OPENVIKING_API_KEY, OPENVIKING_HEADERS } from "./ov-config.ts";
// Issue #954: the OpenViking Request Adapter — all OV HTTP request mechanics
// (URL join, auth headers, timeout, error classification, JSON unwrap) live
// behind this seam now. This module keeps its domain behaviour (metrics +
// fallback) and routes the raw fetch through `ovPostJson`.
import { ovPostJson, isOvFailure } from "./ov-request.ts";
// Issue #1440: durable, hour-bucketed persistence of search-quality counters so
// they survive restarts and can be trended on the health surface. The in-memory
// counters below stay the live source; we batch-flush the *delta since the last
// flush* into Redis on a time gate so the search path never blocks on Redis.
import {
  recordOvSearchDelta,
  type OvSearchMetricsDelta,
  OV_SEARCH_METRIC_FIELDS,
} from "../redis/ov-search-metrics.ts";

export const OV_URL = OPENVIKING_URL;
export const OV_KEY = OPENVIKING_API_KEY;
export const OV_HEADERS = OPENVIKING_HEADERS;

// ===========================================================================
// Metrics (in-memory, resets on restart)
// ===========================================================================

export interface OvSearchMetrics {
  totalSearches: number;
  zeroResultCount: number;
  totalResults: number;
  totalLatencyMs: number;
  fallbackAttempts: number;
  fallbackSuccesses: number;
  errors: number;
}

const ovSearchMetrics: OvSearchMetrics = {
  totalSearches: 0,
  zeroResultCount: 0,
  totalResults: 0,
  totalLatencyMs: 0,
  fallbackAttempts: 0,
  fallbackSuccesses: 0,
  errors: 0,
};

export function getOvSearchMetrics(): OvSearchMetrics & { avgResultsPerQuery: number; avgLatencyMs: number; zeroResultRate: number } {
  const avg = ovSearchMetrics.totalSearches > 0
    ? ovSearchMetrics.totalResults / ovSearchMetrics.totalSearches
    : 0;
  const avgLatency = ovSearchMetrics.totalSearches > 0
    ? ovSearchMetrics.totalLatencyMs / ovSearchMetrics.totalSearches
    : 0;
  const zeroRate = ovSearchMetrics.totalSearches > 0
    ? ovSearchMetrics.zeroResultCount / ovSearchMetrics.totalSearches
    : 0;
  return {
    ...ovSearchMetrics,
    avgResultsPerQuery: Math.round(avg * 100) / 100,
    avgLatencyMs: Math.round(avgLatency * 100) / 100,
    zeroResultRate: Math.round(zeroRate * 1000) / 1000,
  };
}

/** Reset metrics -- exposed for testing only. */
export function resetOvSearchMetrics(): void {
  ovSearchMetrics.totalSearches = 0;
  ovSearchMetrics.zeroResultCount = 0;
  ovSearchMetrics.totalResults = 0;
  ovSearchMetrics.totalLatencyMs = 0;
  ovSearchMetrics.fallbackAttempts = 0;
  ovSearchMetrics.fallbackSuccesses = 0;
  ovSearchMetrics.errors = 0;
  flushedSnapshot = { ...ovSearchMetrics };
  lastFlushMs = 0;
}

// ===========================================================================
// Durable flush to Redis (issue #1440)
// ===========================================================================

/**
 * The last set of counter values we persisted to Redis. The delta between the
 * live `ovSearchMetrics` and this snapshot is what each flush rolls into the
 * current hour bucket — so flushes are additive and lose no counts, and a flush
 * with no new searches is a cheap no-op.
 */
let flushedSnapshot: OvSearchMetrics = { ...ovSearchMetrics };
let lastFlushMs = 0;

/** Batch window: persist at most this often from the hot search path. */
export const OV_SEARCH_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Compute the per-field delta between the live counters and the last-flushed
 * snapshot. Pure — exported for tests. Only positive deltas are emitted (the
 * counters are monotonic until `resetOvSearchMetrics`, which re-baselines the
 * snapshot so the next delta starts from zero rather than going negative).
 */
export function computeFlushDelta(
  live: OvSearchMetrics,
  snapshot: OvSearchMetrics,
): OvSearchMetricsDelta {
  const delta: OvSearchMetricsDelta = {};
  for (const field of OV_SEARCH_METRIC_FIELDS) {
    const d = (live[field] ?? 0) - (snapshot[field] ?? 0);
    if (d > 0) delta[field] = d;
  }
  return delta;
}

/**
 * Persist the counter delta since the last flush into the current UTC-hour
 * Redis bucket. Best-effort and never-throws: a Redis outage logs once and
 * leaves the in-memory counters intact (the next flush retries the same delta,
 * since the snapshot only advances on a successful write).
 *
 * `force` bypasses the 5-min time gate (used by an explicit flush, e.g. on
 * shutdown or from a test). The hot search path calls this opportunistically
 * with `force=false`, so a burst of searches triggers at most one write per
 * flush window.
 */
export async function flushOvSearchMetrics(
  force = false,
  now: number = Date.now(),
): Promise<void> {
  if (!force && now - lastFlushMs < OV_SEARCH_FLUSH_INTERVAL_MS) return;
  const delta = computeFlushDelta(ovSearchMetrics, flushedSnapshot);
  // Advance the time gate even on an empty delta so we don't recompute every
  // call within the window; only advance the snapshot after a real write.
  lastFlushMs = now;
  if (Object.keys(delta).length === 0) return;
  try {
    await recordOvSearchDelta(delta);
    flushedSnapshot = { ...ovSearchMetrics };
  } catch (err: any) {
    // Fail-loud-but-non-fatal: observability must never break the search path.
    console.error(`[OV Search] metrics flush failed (will retry next window): ${err?.message ?? err}`);
  }
}

// ===========================================================================
// Fallback query
// ===========================================================================

/**
 * Build a simplified fallback query from the original query.
 * Strips anchor-specific detail, keeps only agent name + generic terms.
 */
export function buildFallbackQuery(originalQuery: string): string {
  // Extract agent name if present (e.g., "planner agent context for: ...")
  const agentMatch = originalQuery.match(/^(\w+)\s+agent/i);
  const agentName = agentMatch ? agentMatch[1] : "";

  // Remove common filler phrases
  let simplified = originalQuery
    .replace(/\bagent\s+context\s+for:?\s*/gi, "")
    .replace(/\bagent\s+lessons?\s*/gi, "")
    .replace(/\bfailures?\s+prevention\b/gi, "patterns")
    .replace(/[^\w\s]/g, " ")  // strip punctuation
    .replace(/\s+/g, " ")
    .trim();

  // Take only the first 4 meaningful words (skip very short words)
  const words = simplified.split(" ").filter(w => w.length > 2);
  const kept = words.slice(0, 4).join(" ");

  // Prepend agent name if we found one and it's not already included
  if (agentName && !kept.toLowerCase().startsWith(agentName.toLowerCase())) {
    return `${agentName} patterns ${kept}`.trim();
  }

  return kept || "patterns context";
}

// ===========================================================================
// Tracked OV search
// ===========================================================================

/**
 * Tracked OV search -- wraps a fetch to /api/v1/search/find with metrics + logging + fallback.
 * Returns { resources, memories } arrays.
 */
export async function trackedOvSearch(
  query: string,
  limit = 5,
  sessionId?: string | null,
): Promise<{ resources: any[]; memories: any[] }> {
  const startMs = Date.now();
  let resources: any[] = [];
  let memories: any[] = [];

  try {
    const body: Record<string, any> = { query, limit };
    if (sessionId) body.session_id = sessionId;

    const result = await ovPostJson<any>("/api/v1/search/find", body, { timeout: 5000 });

    const latencyMs = Date.now() - startMs;

    if (isOvFailure(result)) {
      ovSearchMetrics.totalSearches++;
      ovSearchMetrics.errors++;
      ovSearchMetrics.totalLatencyMs += latencyMs;
      console.log(`[OV Search] query="${query.slice(0, 80)}" status=${result.code} latency=${latencyMs}ms ERROR`);
      return { resources: [], memories: [] };
    }

    const data = result.data;
    resources = data?.result?.resources || [];
    memories = data?.result?.memories || [];
    const resultCount = resources.length + memories.length;

    ovSearchMetrics.totalSearches++;
    ovSearchMetrics.totalResults += resultCount;
    ovSearchMetrics.totalLatencyMs += latencyMs;

    if (resultCount === 0) {
      ovSearchMetrics.zeroResultCount++;
      console.log(`[OV Search] query="${query.slice(0, 80)}" results=0 latency=${latencyMs}ms -- attempting fallback`);

      // Fallback: simplified query
      const fallbackQuery = buildFallbackQuery(query);
      ovSearchMetrics.fallbackAttempts++;

      const fbStartMs = Date.now();
      try {
        const fbBody: Record<string, any> = { query: fallbackQuery, limit };
        if (sessionId) fbBody.session_id = sessionId;

        const fbResult = await ovPostJson<any>("/api/v1/search/find", fbBody, { timeout: 5000 });

        const fbLatencyMs = Date.now() - fbStartMs;

        if (!isOvFailure(fbResult)) {
          const fbData = fbResult.data;
          const fbResources = fbData?.result?.resources || [];
          const fbMemories = fbData?.result?.memories || [];
          const fbCount = fbResources.length + fbMemories.length;

          if (fbCount > 0) {
            ovSearchMetrics.fallbackSuccesses++;
            resources = fbResources;
            memories = fbMemories;
            console.log(`[OV Search] fallback query="${fallbackQuery.slice(0, 80)}" results=${fbCount} latency=${fbLatencyMs}ms SUCCESS`);
          } else {
            console.log(`[OV Search] fallback query="${fallbackQuery.slice(0, 80)}" results=0 latency=${fbLatencyMs}ms -- no results`);
          }
        }
      } catch (err: any) {
        console.error(`[OV Search] fallback error: ${err.message}`);
      }
    } else {
      console.log(`[OV Search] query="${query.slice(0, 80)}" results=${resultCount} latency=${latencyMs}ms`);
    }
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    ovSearchMetrics.totalSearches++;
    ovSearchMetrics.errors++;
    ovSearchMetrics.totalLatencyMs += latencyMs;
    console.error(`[OV Search] query="${query.slice(0, 80)}" error="${err.message}" latency=${latencyMs}ms`);
  }

  // Issue #1440: opportunistic, time-gated, never-throw flush of the counter
  // delta into the hour-bucketed Redis window. At most one write per flush
  // window regardless of search volume; awaited but self-contained so a Redis
  // hiccup degrades to a logged warning, not a failed search.
  await flushOvSearchMetrics(false);

  return { resources, memories };
}
