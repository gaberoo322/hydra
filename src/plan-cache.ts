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
import { redisKeys } from "./redis-keys.ts";
import {
  getPlanCacheEntry,
  setPlanCacheEntry,
  deletePlanCacheEntry,
  findPlanCacheKeys,
  deleteKeys,
} from "./redis-adapter.ts";

const execFileAsync = promisify(execFile);

const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";

const CACHE_PREFIX = redisKeys.planCachePrefix();

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
};

// -------------------------------------------------------------------------
// Stats (in-memory, reset on restart — lightweight)
// -------------------------------------------------------------------------

const stats = { hits: 0, misses: 0, stored: 0, invalidated: 0, stale: 0 };

export function getPlanCacheStats() {
  return { ...stats };
}

// -------------------------------------------------------------------------
// Cache key — issue #192
//
// The legacy implementation hashed `${type}:${reference.toLowerCase().trim()}`,
// which produced ~0% hit rate (84 stored / 0 hits as of 2026-05-09) because
// planner-generated references vary slightly between cycles (different
// parenthetical metrics, word ordering, surrounding wording).
//
// The fix normalizes references before hashing so semantically-equivalent
// anchors collide on the same cache key:
//
// 1. codebase-health anchors: parse the deterministic
//    "codebase-health: <category> in <file>" format and key on category+file.
//    Drops parentheticals (metrics) which fluctuate cycle-to-cycle.
// 2. Other anchor types: normalize the reference text — lowercase, strip
//    parenthetical clauses, remove stopwords, sort tokens. Reference variants
//    like "Add tests for foo (DB-backed, 0 tests)" and "tests for foo" hash
//    to the same key.
// -------------------------------------------------------------------------

// Common English stopwords + Hydra anchor noise words that don't affect intent.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "with", "from", "to", "of",
  "in", "on", "at", "by", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "this", "that", "these", "those",
  "it", "its", "as", "if", "then", "than", "so", "into", "via", "using", "use",
]);

function tokenize(text: string): string[] {
  // Lowercase, strip parenthetical/bracket clauses, drop punctuation while
  // keeping path-like chars (so src/foo.ts and quick-fix survive intact).
  const cleaned = text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")           // strip "(...)" clauses
    .replace(/\[[^\]]*\]/g, " ")          // strip "[...]" clauses
    .replace(/[^a-z0-9_./\- ]+/g, " ");   // keep word/path chars
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Normalize codebase-health references that follow the deterministic
 * "codebase-health: <category> in <file>" pattern emitted by anchor-selection.ts.
 * Returns null if the reference doesn't match the expected shape — caller
 * falls back to generic normalization.
 */
function normalizeHealthReference(reference: string): string | null {
  // Match: "codebase-health: <category> in <file>" with optional trailing
  // parenthetical metric. Category is a single token; file may include path
  // separators and a dot extension.
  const match = reference.match(
    /^codebase-health:\s*(\S+)\s+in\s+(\S+?)\s*(?:\([^)]*\))?\s*$/i,
  );
  if (!match) return null;
  const [, category, file] = match;
  return `health|${category.toLowerCase()}|${file.toLowerCase()}`;
}

/**
 * Normalize an anchor reference into a stable string used as the cache key
 * input. Exported for tests; callers should use `cacheKey()`.
 */
export function normalizeReference(type: string, reference: string): string {
  if (type === "codebase-health") {
    const health = normalizeHealthReference(reference);
    if (health) return health;
  }
  // Generic: tokenize + sort so small wording differences collide.
  const tokens = tokenize(reference);
  tokens.sort();
  return tokens.join(" ");
}

function cacheKey(anchor: { type: string; reference: string }): string {
  const normalized = `${anchor.type}:${normalizeReference(anchor.type, anchor.reference)}`;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${CACHE_PREFIX}${hash}`;
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
): Promise<Record<string, any> | null> {
  if (!CACHEABLE_TYPES.has(anchor.type)) return null;

  const key = cacheKey(anchor);
  try {
    const raw = await getPlanCacheEntry(key);
    if (!raw) {
      stats.misses++;
      return null;
    }

    const entry: CacheEntry = JSON.parse(raw);

    // Freshness check 1: test count
    const staleReason = isStale(entry, grounding);
    if (staleReason) {
      console.log(`[PlanCache] STALE: ${staleReason} — key ${key.slice(-12)}`);
      stats.stale++;
      stats.misses++;
      await deletePlanCacheEntry(key);
      return null;
    }

    // Freshness check 2: scope files unmodified
    const filesOk = await areScopeFilesUnmodified(entry.scopeFiles, entry.cachedAt);
    if (!filesOk) {
      console.log(`[PlanCache] STALE: scope files modified since cache — key ${key.slice(-12)}`);
      stats.stale++;
      stats.misses++;
      await deletePlanCacheEntry(key);
      return null;
    }

    stats.hits++;
    console.log(`[PlanCache] HIT: "${entry.task.title?.slice(0, 60)}" (cached ${entry.cachedAt.slice(0, 16)})`);
    return entry.task;
  } catch (err: any) {
    console.error(`[PlanCache] GET failed: ${err.message}`);
    stats.misses++;
    return null;
  }
}

export async function cachePlan(
  anchor: { type: string; reference: string },
  task: Record<string, any>,
  grounding: { testReport: { passed: number } },
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
  };

  try {
    await setPlanCacheEntry(key, JSON.stringify(entry), ttl);
    stats.stored++;
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
      stats.invalidated++;
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
    const keys = await findPlanCacheKeys(CACHE_PREFIX);
    if (keys.length > 0) {
      await deleteKeys(keys);
      stats.invalidated += keys.length;
      console.log(`[PlanCache] INVALIDATED: ${keys.length} cached plans`);
    }
    return keys.length;
  } catch (err: any) {
    console.error(`[PlanCache] Invalidation failed: ${err.message}`);
    return 0;
  }
}
