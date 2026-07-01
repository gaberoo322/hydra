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
 *   loadKnowledgeBaseForPrompt               — {content,itemCount} read for the
 *                                              learning context seam (#1455)
 *
 * Behavior preserved 1:1 from the previous learning.ts implementation.
 *
 * # Injectable counter seam (issue #1926)
 *
 * The in-process search-quality counters were three module-level mutable
 * variables (`ovSearchMetrics`, `flushedSnapshot`, `lastFlushMs`) — a process
 * singleton that any two callers of `trackedOvSearch` shared, and that tests
 * had to scrub with `resetOvSearchMetrics()` before every assertion. That
 * state is now encapsulated in {@link OvSearchMetricsCounter}: the live
 * counters, the last-flushed snapshot, and the flush time-gate are private
 * instance fields, mutated only through the class's own methods. A
 * {@link defaultMetrics} singleton preserves production behavior 1:1 (mirroring
 * `defaultAccumulator` in `digest.ts`, issue #1487), so the exported
 * `getOvSearchMetrics` / `resetOvSearchMetrics` functions and `trackedOvSearch`
 * stay thin delegators — zero call-site churn at `api/openviking.ts`. Tests can
 * now construct a fresh `new OvSearchMetricsCounter()` per case instead of
 * scrubbing a global. `computeFlushDelta` stays a pure exported function.
 */

// OpenViking connection config — single source of truth in ov-config.ts (issue #231).
// Re-exported under the historical OV_URL / OV_KEY names so existing
// importers keep compiling without churn.
import { OPENVIKING_URL, OPENVIKING_API_KEY } from "./ov-config.ts";
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

/** The derived (computed) fields the read surface appends to the raw counters. */
export interface OvSearchMetricsDerived {
  avgResultsPerQuery: number;
  avgLatencyMs: number;
  zeroResultRate: number;
}

/** A zeroed counter literal — the initial state of every fresh counter. */
function zeroOvSearchMetrics(): OvSearchMetrics {
  return {
    totalSearches: 0,
    zeroResultCount: 0,
    totalResults: 0,
    totalLatencyMs: 0,
    fallbackAttempts: 0,
    fallbackSuccesses: 0,
    errors: 0,
  };
}

/** Batch window: persist at most this often from the hot search path. */
const OV_SEARCH_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Compute the per-field delta between the live counters and the last-flushed
 * snapshot. Pure — exported for tests. Only positive deltas are emitted (the
 * counters are monotonic until a counter is reset, which re-baselines the
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

// ===========================================================================
// Injectable counter (issue #1926)
// ===========================================================================

/**
 * Injectable dependencies for {@link OvSearchMetricsCounter}. Both optional —
 * each defaults to the real implementation, so production constructs the
 * counter with `new OvSearchMetricsCounter()` and tests can inject a
 * deterministic clock + a capturing persist sink.
 */
export interface OvSearchMetricsCounterDeps {
  /** Wall-clock source for the flush time-gate. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Durable-persist sink for a flush delta. Defaults to `recordOvSearchDelta`.
   * The return value is awaited but ignored, so any `Promise` resolution is
   * accepted (`recordOvSearchDelta` resolves the bucket key string).
   */
  persist?: (delta: OvSearchMetricsDelta) => Promise<unknown>;
}

/**
 * Owns the in-process search-quality counters and the durable-flush machinery
 * that used to live as three module-level variables (`ovSearchMetrics`,
 * `flushedSnapshot`, `lastFlushMs`). The live counters, the last-flushed
 * snapshot, and the flush time-gate are private instance fields — there is no
 * shared global, so a test constructs a fresh instance per case instead of
 * scrubbing a singleton with {@link OvSearchMetricsCounter.reset}. Production
 * uses the {@link defaultMetrics} singleton; behavior is preserved 1:1.
 */
export class OvSearchMetricsCounter {
  /** Live counters (mutated by the search path). */
  private readonly metrics: OvSearchMetrics = zeroOvSearchMetrics();
  /**
   * The last set of counter values we persisted to Redis. The delta between
   * the live `metrics` and this snapshot is what each flush rolls into the
   * current hour bucket — so flushes are additive and lose no counts, and a
   * flush with no new searches is a cheap no-op.
   */
  private flushedSnapshot: OvSearchMetrics = zeroOvSearchMetrics();
  private lastFlushMs = 0;

  private readonly now: () => number;
  private readonly persist: (delta: OvSearchMetricsDelta) => Promise<unknown>;

  constructor(deps: OvSearchMetricsCounterDeps = {}) {
    this.now = deps.now ?? Date.now;
    // recordOvSearchDelta accepts an optional `now` arg we don't pass here;
    // the call site supplies only the delta, so the wider signature is safe.
    this.persist = deps.persist ?? recordOvSearchDelta;
  }

  /** Record one search result outcome (latency + result count). */
  recordSearch(latencyMs: number, resultCount: number): void {
    this.metrics.totalSearches++;
    this.metrics.totalResults += resultCount;
    this.metrics.totalLatencyMs += latencyMs;
    if (resultCount === 0) this.metrics.zeroResultCount++;
  }

  /** Record a search that failed (OV failure or thrown error). */
  recordError(latencyMs: number): void {
    this.metrics.totalSearches++;
    this.metrics.errors++;
    this.metrics.totalLatencyMs += latencyMs;
  }

  /** Record that a zero-result fallback query was attempted. */
  recordFallbackAttempt(): void {
    this.metrics.fallbackAttempts++;
  }

  /** Record that a fallback query returned results. */
  recordFallbackSuccess(): void {
    this.metrics.fallbackSuccesses++;
  }

  /** Read the live counters plus the derived (avg/rate) fields. */
  snapshot(): OvSearchMetrics & OvSearchMetricsDerived {
    const avg = this.metrics.totalSearches > 0
      ? this.metrics.totalResults / this.metrics.totalSearches
      : 0;
    const avgLatency = this.metrics.totalSearches > 0
      ? this.metrics.totalLatencyMs / this.metrics.totalSearches
      : 0;
    const zeroRate = this.metrics.totalSearches > 0
      ? this.metrics.zeroResultCount / this.metrics.totalSearches
      : 0;
    return {
      ...this.metrics,
      avgResultsPerQuery: Math.round(avg * 100) / 100,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
      zeroResultRate: Math.round(zeroRate * 1000) / 1000,
    };
  }

  /** Reset all counters to zero and re-baseline the flush snapshot. */
  reset(): void {
    for (const field of OV_SEARCH_METRIC_FIELDS) this.metrics[field] = 0;
    this.flushedSnapshot = { ...this.metrics };
    this.lastFlushMs = 0;
  }

  /**
   * Persist the counter delta since the last flush into the current UTC-hour
   * Redis bucket. Best-effort and never-throws: a persist outage logs once and
   * leaves the in-memory counters intact (the next flush retries the same
   * delta, since the snapshot only advances on a successful write).
   *
   * `force` bypasses the 5-min time gate (used by an explicit flush, e.g. on
   * shutdown or from a test). The hot search path calls this opportunistically
   * with `force=false`, so a burst of searches triggers at most one write per
   * flush window.
   */
  async flush(force = false, now: number = this.now()): Promise<void> {
    if (!force && now - this.lastFlushMs < OV_SEARCH_FLUSH_INTERVAL_MS) return;
    const delta = computeFlushDelta(this.metrics, this.flushedSnapshot);
    // Advance the time gate even on an empty delta so we don't recompute every
    // call within the window; only advance the snapshot after a real write.
    this.lastFlushMs = now;
    if (Object.keys(delta).length === 0) return;
    try {
      await this.persist(delta);
      this.flushedSnapshot = { ...this.metrics };
    } catch (err: any) {
      // Fail-loud-but-non-fatal: observability must never break the search path.
      console.error(`[OV Search] metrics flush failed (will retry next window): ${err?.message ?? err}`);
    }
  }
}

/**
 * The process-wide default counter. Preserves the pre-#1926 singleton behavior
 * 1:1 so `api/openviking.ts` and the search path need no call-site change.
 */
const defaultMetrics = new OvSearchMetricsCounter();

export function getOvSearchMetrics(): OvSearchMetrics & OvSearchMetricsDerived {
  return defaultMetrics.snapshot();
}

/** Reset metrics -- exposed for testing only. */
export function resetOvSearchMetrics(): void {
  defaultMetrics.reset();
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
 *
 * `counter` is the injectable metrics sink (issue #1926); it defaults to the
 * process-wide {@link defaultMetrics} singleton so production callers and
 * `api/openviking.ts` are unchanged. A test passes a fresh
 * `new OvSearchMetricsCounter()` to isolate counts per case.
 */
export async function trackedOvSearch(
  query: string,
  limit = 5,
  sessionId?: string | null,
  counter: OvSearchMetricsCounter = defaultMetrics,
): Promise<{ resources: any[]; memories: any[] }> {
  const startMs = Date.now();
  let resources: any[] = [];
  let memories: any[] = [];

  try {
    const body: Record<string, any> = { query, limit };
    if (sessionId) body.session_id = sessionId;

    // LOAD-BEARING PATH — do NOT drop the `/api/v1` prefix. The live OpenViking
    // container serves `POST /api/v1/search/find` 200 with real hits; the
    // prefix-less `/search/find` 404s. Issue #2586 misdiagnosed a bare-path curl
    // 404 as a code bug and proposed rewriting this to `/search/find` — that
    // would break the knowledge plane. `test/ov-search-path.test.mts` pins this.
    const result = await ovPostJson<any>("/api/v1/search/find", body, { timeout: 5000 });

    const latencyMs = Date.now() - startMs;

    if (isOvFailure(result)) {
      counter.recordError(latencyMs);
      console.log(`[OV Search] query="${query.slice(0, 80)}" status=${result.code} latency=${latencyMs}ms ERROR`);
      return { resources: [], memories: [] };
    }

    const data = result.data;
    resources = data?.result?.resources || [];
    memories = data?.result?.memories || [];
    const resultCount = resources.length + memories.length;

    counter.recordSearch(latencyMs, resultCount);

    if (resultCount === 0) {
      console.log(`[OV Search] query="${query.slice(0, 80)}" results=0 latency=${latencyMs}ms -- attempting fallback`);

      // Fallback: simplified query
      const fallbackQuery = buildFallbackQuery(query);
      counter.recordFallbackAttempt();

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
            counter.recordFallbackSuccess();
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
    counter.recordError(latencyMs);
    console.error(`[OV Search] query="${query.slice(0, 80)}" error="${err.message}" latency=${latencyMs}ms`);
  }

  // Issue #1440: opportunistic, time-gated, never-throw flush of the counter
  // delta into the hour-bucketed Redis window. At most one write per flush
  // window regardless of search volume; awaited but self-contained so a Redis
  // hiccup degrades to a logged warning, not a failed search.
  await counter.flush(false);

  return { resources, memories };
}

// ===========================================================================
// Prompt-block read (issue #1455)
// ===========================================================================

/**
 * Knowledge Base read for the dispatch-time learning context (issue #1455).
 *
 * Searches OpenViking for the agent's learned patterns and renders them into a
 * prompt block, returning `{content,itemCount}` — the `{content,itemCount}`
 * surface every learning source exposes so the composition seam (learning.ts)
 * can drive a single generic loader rather than a bespoke per-source one.
 *
 * `itemCount` is the count of OV memories that actually contributed to the
 * block (non-empty abstracts), sourced from the search data here — never
 * regex-scanned out of the rendered markdown at the seam (#804 count-from-data
 * contract). `content` is "" / `itemCount` 0 when the search returned nothing.
 *
 * Per CONTEXT.md the Knowledge Base is queried by subagents directly at their
 * own seam; this read only *enriches* the planner prompt, so the cluster stays
 * composed-not-owned at learning.ts. The render lives here (cluster-local
 * work), the envelope mapping (hit/miss/error) stays at the seam.
 */
export async function loadKnowledgeBaseForPrompt(
  agent: string,
): Promise<{ content: string; itemCount: number }> {
  const { memories } = await trackedOvSearch(
    `${agent} agent lessons failures prevention`,
    5,
  );
  const top = memories.slice(0, 5);
  const parts: string[] = [];
  for (const mem of top) {
    const abstract = mem.abstract || mem.content || "";
    if (abstract.trim()) parts.push(`- ${abstract.slice(0, 300)}`);
  }
  if (parts.length === 0) return { content: "", itemCount: 0 };
  return {
    content: `# ${agent} — Learned Patterns (from OpenViking)\n\n${parts.join("\n")}`,
    itemCount: parts.length,
  };
}
