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
import Redis from "ioredis";
import { redisKeys } from "./redis-keys.ts";

const execFileAsync = promisify(execFile);

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";

const CACHE_PREFIX = redisKeys.planCachePrefix();

// TTL by anchor type (seconds)
const TTL_STANDARD = 12 * 60 * 60; // 12 hours
const TTL_QUICK_FIX = 6 * 60 * 60; // 6 hours

const CACHEABLE_TYPES = new Set(["user-request", "codebase-health", "failing-test", "research"]);

let redis: InstanceType<typeof Redis> | null = null;

function getRedis() {
  if (!redis) redis = new Redis(REDIS_URL);
  return redis;
}

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
// Cache key
// -------------------------------------------------------------------------

function cacheKey(anchor: { type: string; reference: string }): string {
  const normalized = `${anchor.type}:${anchor.reference.toLowerCase().trim()}`;
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
    const raw = await getRedis().get(key);
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
      await getRedis().del(key);
      return null;
    }

    // Freshness check 2: scope files unmodified
    const filesOk = await areScopeFilesUnmodified(entry.scopeFiles, entry.cachedAt);
    if (!filesOk) {
      console.log(`[PlanCache] STALE: scope files modified since cache — key ${key.slice(-12)}`);
      stats.stale++;
      stats.misses++;
      await getRedis().del(key);
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
  if (!task || task.noWork) return;

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
    await getRedis().set(key, JSON.stringify(entry), "EX", ttl);
    stats.stored++;
    console.log(`[PlanCache] STORED: "${task.title?.slice(0, 60)}" (TTL ${ttl / 3600}h)`);
  } catch (err: any) {
    console.error(`[PlanCache] SET failed: ${err.message}`);
  }
}

export async function invalidatePlanCache(): Promise<number> {
  try {
    const keys = await getRedis().keys(`${CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await getRedis().del(...keys);
      stats.invalidated += keys.length;
      console.log(`[PlanCache] INVALIDATED: ${keys.length} cached plans`);
    }
    return keys.length;
  } catch (err: any) {
    console.error(`[PlanCache] Invalidation failed: ${err.message}`);
    return 0;
  }
}
