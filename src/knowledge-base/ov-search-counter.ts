/**
 * knowledge-base/ov-search-counter.ts — the OV search-quality metrics counter
 *
 * Extracted from ov-search.ts (issue #3344) so the observability concern — the
 * in-memory counter ring, the time-gated delta-flush to Redis, and the derived
 * read surface — lives in a focused leaf, mirroring the earlier ov-request.ts /
 * hash-dedup.ts / ov-upload.ts extractions from the same module. The search
 * path (`trackedOvSearch`) records INTO this counter via the
 * {@link defaultMetrics} singleton; this module has no search dependency
 * (dependency direction is strictly ov-search.ts → ov-search-counter.ts →
 * redis/ov-search-metrics.ts).
 *
 * Public API:
 *   getOvSearchMetrics, resetOvSearchMetrics — metrics for /api/health
 *   OvSearchMetricsCounter, defaultMetrics   — injectable counter + the
 *                                              process-wide singleton
 *   computeFlushDelta                        — pure helper, exported for tests
 *
 * Behavior preserved 1:1 from the previous ov-search.ts implementation.
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

// Issue #1440: durable, hour-bucketed persistence of search-quality counters so
// they survive restarts and can be trended on the health surface. The in-memory
// counters below stay the live source; we batch-flush the *delta since the last
// flush* into Redis on a time gate so the search path never blocks on Redis.
import {
  recordOvSearchDelta,
  type OvSearchMetricsDelta,
  OV_SEARCH_METRIC_FIELDS,
} from "../redis/ov-search-metrics.ts";

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
 * Exported (issue #3344) so `ov-search.ts` can keep it as `trackedOvSearch`'s
 * default counter param — `getOvSearchMetrics()` and the search path record
 * into the SAME instance.
 */
export const defaultMetrics = new OvSearchMetricsCounter();

export function getOvSearchMetrics(): OvSearchMetrics & OvSearchMetricsDerived {
  return defaultMetrics.snapshot();
}

/** Reset metrics -- exposed for testing only. */
export function resetOvSearchMetrics(): void {
  defaultMetrics.reset();
}
