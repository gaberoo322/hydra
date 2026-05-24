/**
 * Plan Cache — Skip expensive planner LLM calls for recurring task patterns.
 *
 * Caches plan output keyed on anchor (type + reference). Before reusing,
 * validates freshness: TTL, test count stability, and scope-file modification.
 *
 * Non-cacheable anchor types (prior-failure, reframe) are skipped entirely.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getPlanCacheEntry,
  setPlanCacheEntry,
  deletePlanCacheEntry,
  findPlanCacheKeys,
  PLAN_CACHE_PREFIX,
} from "./redis/plan-cache.ts";
import { deleteKeys } from "./redis/utility.ts";
import {
  incrPlanCacheStat,
  incrPlanCacheMissReason,
  getPlanCacheStatsLifetime,
  getPlanCacheStatsLast24h,
  getPlanCacheMissReasonsLifetime,
  getPlanCacheMissReasonsLast24h,
  type PlanCacheStatMetric,
  type PlanCacheMissReason,
} from "./redis/plan-cache.ts";
import { getTargetWorkspace } from "./target-config.ts";
import { normalizeReference } from "./anchor-selection/normalize-reference.ts";

const execFileAsync = promisify(execFile);

const PROJECT_WORKSPACE = getTargetWorkspace();

// TTL by anchor type (seconds)
const TTL_STANDARD = 12 * 60 * 60; // 12 hours
const TTL_QUICK_FIX = 6 * 60 * 60; // 6 hours

const CACHEABLE_TYPES = new Set(["user-request", "codebase-health", "failing-test", "research"]);

type CacheEntry = {
  task: Record<string, any>;
  cachedAt: string;
  testCount: number;
  anchorType: string;
  anchorReference: string;
  scopeFiles: string[];
  /**
   * SHA-256 digest of the per-anchor reflection records at plan time
   * (issue #375). Used to distinguish "reflections are unchanged since this
   * plan was produced" (cache hit) from "reflections have changed, the
   * cached plan was made under stale failure context" (miss with
   * `reflection-changed`). `null` means the plan was cached when no
   * reflections existed for the anchor — a fresh reflection appearing
   * later flips the digest from null to a hex string and counts as
   * `reflection-changed`. Older entries without this field are treated as
   * `null` (legacy compatibility).
   */
  reflectionDigest?: string | null;
};

/**
 * Compute a deterministic digest over the per-anchor reflections used to
 * decide whether a cached plan is still valid (issue #375).
 *
 * The digest is `sha256(JSON.stringify(sorted.map(r => r.cycleId + "|" + r.reason)))`,
 * where `sorted` is the input list sorted by `cycleId` ascending. We hash
 * only the stable identifying fields (cycleId + failure-mode/reason) rather
 * than the full reflection record so that benign text reshuffles (e.g. a
 * cosmetic edit to `whatShouldChange`) do not invalidate the cache. New
 * reflections — which always carry a fresh `cycleId` — always change the
 * digest.
 *
 * Returns `null` when there are no reflections so callers can store/compare
 * a sentinel without special-casing the empty list.
 *
 * Exported for testing.
 */
export function computeReflectionDigest(
  reflections: Array<{ cycleId?: string; reason?: string }> | null | undefined,
): string | null {
  if (!reflections || reflections.length === 0) return null;
  const sorted = reflections
    .map((r) => `${r.cycleId ?? ""}|${r.reason ?? ""}`)
    .sort();
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

// -------------------------------------------------------------------------
// Stats
//
// Two views (issue #325):
//   1. `thisProcess` — in-memory counters, reset on restart. Cheap, sync, and
//      useful for "what has *this* process done since boot".
//   2. `lifetime` + `last24h` — persisted to Redis via incrPlanCacheStat so
//      operators can measure whether the #192 normalization fix is producing
//      hits over a multi-day window across restarts/deploys.
//
// Each cache event bumps both views. Redis failures are logged but never
// propagate — instrumentation must not break the cache hot path.
// -------------------------------------------------------------------------

const stats = { hits: 0, misses: 0, stored: 0, invalidated: 0, stale: 0 };

/**
 * Synchronous this-process counters. Kept for backward compatibility with
 * existing call sites that need a cheap snapshot without a Redis round-trip.
 *
 * For lifetime / 24h views (the operator-visible numbers), use
 * `getPlanCacheStatsFull()`.
 */
export function getPlanCacheStats() {
  return { ...stats };
}

/**
 * Bump both in-memory and persisted counters for a metric. Persisted increment
 * is fire-and-forget — we don't block the cache path on Redis.
 *
 * When `metric === "misses"` and a `reason` is supplied, we also bump the
 * miss-reason histogram (issue #363). Callers that record a "logical" miss
 * (e.g. cache was intentionally bypassed before query) should call
 * `recordMiss(reason)` instead, which records a miss + reason without needing
 * the cache-entry code path.
 */
function bumpStat(
  metric: PlanCacheStatMetric,
  delta: number = 1,
  reason?: PlanCacheMissReason,
): void {
  if (delta <= 0) return;
  stats[metric] += delta;
  // Fire-and-forget; incrPlanCacheStat swallows its own errors.
  void incrPlanCacheStat(metric, delta);
  if (metric === "misses" && reason) {
    trackInProcessMissReason(reason);
    void incrPlanCacheMissReason(reason);
  }
}

/**
 * Record a miss with an explicit reason. Used by callers (e.g.
 * planner-prompt.ts) that bypass `getCachedPlan` entirely — without this hook,
 * the bypass would be invisible in the miss-reason histogram.
 *
 * The bookkeeping reasons `reflection-bypass`, `non-cacheable-type`, and
 * `actionability-skipped` are the primary external callers.
 */
export function recordPlanCacheMiss(reason: PlanCacheMissReason): void {
  bumpStat("misses", 1, reason);
}

/** Compute hitRate as hits/(hits+misses), 0 when denominator is 0, 1-dp. */
export function computeHitRate(hits: number, misses: number): number {
  const total = hits + misses;
  if (total <= 0) return 0;
  return Math.round((hits / total) * 1000) / 1000;
}

export type PlanCacheStatsView = Record<PlanCacheStatMetric, number> & {
  hitRate: number;
  /**
   * Miss-reason histogram for this view (issue #363). Keys are
   * PlanCacheMissReason labels; values are integer counts. The sum of all
   * values approximates the view's `misses` total (small skew is possible
   * when a miss is recorded right around the day boundary).
   */
  missReasons: Record<PlanCacheMissReason, number>;
};

export type PlanCacheStatsFull = {
  lifetime: PlanCacheStatsView;
  last24h: PlanCacheStatsView;
  thisProcess: PlanCacheStatsView;
};

function withHitRate(
  s: Record<PlanCacheStatMetric, number>,
  missReasons: Record<PlanCacheMissReason, number>,
): PlanCacheStatsView {
  return { ...s, hitRate: computeHitRate(s.hits, s.misses), missReasons };
}

/**
 * In-memory miss-reason counters (thisProcess view). Mirrors `stats` above:
 * cheap synchronous counters reset on restart, useful for "what has this
 * process seen since boot".
 */
const inProcessMissReasons: Record<PlanCacheMissReason, number> = {
  "not-found": 0,
  "non-cacheable-type": 0,
  "reflection-bypass": 0,
  "reflection-changed": 0,
  "actionability-skipped": 0,
  "stale-tests": 0,
  "stale-files": 0,
  "get-error": 0,
};

// Patch bumpStat path: track in-memory miss reasons alongside the persisted
// histogram. Kept as a separate hook so the existing bumpStat call sites
// don't need to change shape.
function trackInProcessMissReason(reason: PlanCacheMissReason): void {
  inProcessMissReasons[reason] += 1;
}

/**
 * Operator-visible plan-cache stats — surfaced on /api/plan-cache/stats.
 *
 * Returns three views:
 *   - `lifetime`   : Redis-persisted counters across restarts (issue #325)
 *   - `last24h`    : sum of today + yesterday UTC per-day keys
 *   - `thisProcess`: in-memory counters since this Node process booted
 *
 * Each view includes a `hitRate` derived from its own hits/misses, and a
 * `missReasons` histogram explaining why the misses occurred (issue #363).
 */
export async function getPlanCacheStatsFull(): Promise<PlanCacheStatsFull> {
  const [lifetime, last24h, lifetimeMR, last24hMR] = await Promise.all([
    getPlanCacheStatsLifetime(),
    getPlanCacheStatsLast24h(),
    getPlanCacheMissReasonsLifetime(),
    getPlanCacheMissReasonsLast24h(),
  ]);
  return {
    lifetime: withHitRate(lifetime, lifetimeMR),
    last24h: withHitRate(last24h, last24hMR),
    thisProcess: withHitRate(stats, { ...inProcessMissReasons }),
  };
}

// Cache key (issue #192): hash a normalized reference so semantically-equivalent
// anchors collide on the same key. Normalization shape lives in
// src/anchor-selection/normalize-reference.ts (shared with anchor-actionability).

function cacheKey(anchor: { type: string; reference: string }): string {
  const normalized = `${anchor.type}:${normalizeReference(anchor.type, anchor.reference)}`;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${PLAN_CACHE_PREFIX}${hash}`;
}

// -------------------------------------------------------------------------
// Freshness validation
// -------------------------------------------------------------------------

async function areScopeFilesUnmodified(scopeFiles: string[], cachedAt: string): Promise<boolean> {
  if (scopeFiles.length === 0) return true;
  try {
    // Check if any scope file was modified after the cache time
    const { stdout } = await execFileAsync(
      "git", ["log", "--oneline", "--since", cachedAt, "--", ...scopeFiles],
      { cwd: PROJECT_WORKSPACE, timeout: 5000 },
    );
    // If git log returns any commits, files were modified
    return stdout.trim().length === 0;
  } catch {
    // If git check fails, treat as stale (safe default)
    return false;
  }
}

function isStale(entry: CacheEntry, grounding: { testReport: { passed: number } }): string | null {
  // Test count dropped → regression, plan may be invalid
  if (grounding.testReport.passed < entry.testCount) {
    return `test count dropped (${entry.testCount} → ${grounding.testReport.passed})`;
  }
  return null;
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

export async function getCachedPlan(
  anchor: { type: string; reference: string },
  grounding: { testReport: { passed: number } },
  /**
   * Optional digest of the current per-anchor reflections (issue #375). When
   * supplied, the cache entry is only returned if its stored digest matches
   * — otherwise the entry is evicted and a `reflection-changed` miss is
   * recorded. `null` means "no reflections exist right now" and matches an
   * entry that was cached under the same condition. Omitting the parameter
   * (legacy callers + tests) skips the digest comparison entirely.
   */
  reflectionDigest?: string | null,
): Promise<Record<string, any> | null> {
  if (!CACHEABLE_TYPES.has(anchor.type)) {
    // Record the bookkeeping miss so the histogram reflects every planner
    // call that *could* have hit cache but didn't (issue #363).
    bumpStat("misses", 1, "non-cacheable-type");
    return null;
  }

  const key = cacheKey(anchor);
  try {
    const raw = await getPlanCacheEntry(key);
    if (!raw) {
      bumpStat("misses", 1, "not-found");
      return null;
    }

    const entry: CacheEntry = JSON.parse(raw);

    // Freshness check 1: test count
    const staleReason = isStale(entry, grounding);
    if (staleReason) {
      console.log(`[PlanCache] STALE: ${staleReason} — key ${key.slice(-12)}`);
      bumpStat("stale");
      bumpStat("misses", 1, "stale-tests");
      await deletePlanCacheEntry(key);
      return null;
    }

    // Freshness check 2: scope files unmodified
    const filesOk = await areScopeFilesUnmodified(entry.scopeFiles, entry.cachedAt);
    if (!filesOk) {
      console.log(`[PlanCache] STALE: scope files modified since cache — key ${key.slice(-12)}`);
      bumpStat("stale");
      bumpStat("misses", 1, "stale-files");
      await deletePlanCacheEntry(key);
      return null;
    }

    // Freshness check 3: reflection digest (issue #375). Skip when the caller
    // didn't supply one (undefined preserves legacy "ignore reflections"
    // semantics for tests / callers that don't track per-anchor reflections).
    if (reflectionDigest !== undefined) {
      const stored = entry.reflectionDigest ?? null;
      if (stored !== reflectionDigest) {
        console.log(
          `[PlanCache] STALE: reflection digest changed (stored=${stored ?? "none"} now=${reflectionDigest ?? "none"}) — key ${key.slice(-12)}`,
        );
        bumpStat("stale");
        bumpStat("misses", 1, "reflection-changed");
        await deletePlanCacheEntry(key);
        return null;
      }
    }

    bumpStat("hits");
    console.log(`[PlanCache] HIT: "${entry.task.title?.slice(0, 60)}" (cached ${entry.cachedAt.slice(0, 16)})`);
    return entry.task;
  } catch (err: any) {
    console.error(`[PlanCache] GET failed: ${err.message}`);
    bumpStat("misses", 1, "get-error");
    return null;
  }
}

export async function cachePlan(
  anchor: { type: string; reference: string },
  task: Record<string, any>,
  grounding: { testReport: { passed: number } },
  /**
   * Optional reflection digest to persist alongside the plan (issue #375).
   * Pass the same value that was passed (or would have been passed) to
   * `getCachedPlan` so that subsequent lookups can detect whether the
   * reflection set has changed since the plan was produced. `null` means
   * "no reflections existed at plan time". Omitting the argument stores
   * `null` (legacy behaviour).
   */
  reflectionDigest?: string | null,
): Promise<void> {
  if (!CACHEABLE_TYPES.has(anchor.type)) return;
  if (!task || task.noWork || task.__noWork) return;

  const key = cacheKey(anchor);
  const ttl = (anchor.type === "failing-test") ? TTL_QUICK_FIX : TTL_STANDARD;

  const entry: CacheEntry = {
    task,
    cachedAt: new Date().toISOString(),
    testCount: grounding.testReport.passed,
    anchorType: anchor.type,
    anchorReference: anchor.reference,
    scopeFiles: task.scopeBoundary?.in || [],
    reflectionDigest: reflectionDigest === undefined ? null : reflectionDigest,
  };

  try {
    await setPlanCacheEntry(key, JSON.stringify(entry), ttl);
    bumpStat("stored");
    console.log(`[PlanCache] STORED: "${task.title?.slice(0, 60)}" (TTL ${ttl / 3600}h)`);
  } catch (err: any) {
    console.error(`[PlanCache] SET failed: ${err.message}`);
  }
}

/**
 * Invalidate the cached plan for a specific anchor.
 * Called when a task fails and is stored as a prior failure — a plan that
 * produced a failure should never be served again for retries.
 */
export async function invalidatePlanCacheForAnchor(
  anchor: { type: string; reference: string },
): Promise<boolean> {
  const key = cacheKey(anchor);
  try {
    const existed = await getPlanCacheEntry(key);
    if (existed) {
      await deletePlanCacheEntry(key);
      bumpStat("invalidated");
      console.log(`[PlanCache] INVALIDATED for anchor: "${anchor.reference.slice(0, 60)}" (type=${anchor.type})`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error(`[PlanCache] Anchor invalidation failed: ${err.message}`);
    return false;
  }
}

export async function invalidatePlanCache(): Promise<number> {
  try {
    const allKeys = await findPlanCacheKeys(PLAN_CACHE_PREFIX);
    // Exclude persisted stats keys (hydra:plans:cache:stats:*) — issue #325.
    // Otherwise bulk invalidation would wipe the lifetime counters that exist
    // to outlive cache flushes/restarts.
    const STATS_PREFIX = `${PLAN_CACHE_PREFIX}stats:`;
    const keys = allKeys.filter((k) => !k.startsWith(STATS_PREFIX));
    if (keys.length > 0) {
      await deleteKeys(keys);
      bumpStat("invalidated", keys.length);
      console.log(`[PlanCache] INVALIDATED: ${keys.length} cached plans`);
    }
    return keys.length;
  } catch (err: any) {
    console.error(`[PlanCache] Invalidation failed: ${err.message}`);
    return 0;
  }
}
