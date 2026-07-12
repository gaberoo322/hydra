/**
 * Reflection Redis ops (per-anchor + by-file index).
 * Extracted from redis-adapter.ts (issue #269).
 *
 * Note: low-level Redis primitives. Higher-level reflection logic lives in
 * src/learning/reflections.ts.
 *
 * Issue #1454: the global reflection buffer (a Redis list) and its accessors
 * were deleted as a dead subsystem. Issue #1655: the reflection-outcomes zset
 * reader followed (its writer died in earlier retirements). The per-anchor
 * list and the by-file index survive — they back the live #841 injection path.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/** Shared prefix all per-anchor reflection keys live under. */
export const REFLECTION_PREFIX = redisKeys.reflectionPrefix();

// ===========================================================================
// Retired reflection-outcomes ledger — liveness PROBE only (issue #3251)
// ===========================================================================
//
// The `hydra:learning:reflection:outcomes` ZSET was a per-anchor outcome ledger
// whose WRITER died at commit 5b6683e (the ZADD accessor deleted in #1006) and
// whose READER + key-builder were then swept in #1655 (PR #1686) as an ADR-0023
// "producers cut, consumers kept" corpse. It is DELIBERATELY RETIRED — there is
// no live producer to resume.
//
// A frozen tail of that ledger can still linger in Redis (the ZSET has no TTL),
// and its last entry's timestamp (2026-05-13) is exactly what a 2026-07-02
// architecture review flagged as "reflection outcomes stale — producer
// disconnected", re-filing the phantom as issue #3251. The gap was never a
// broken producer; it was that the RETIRED state was INVISIBLE — nothing on the
// health surface distinguished "dead ledger, expected" from "live-but-broken
// producer", so the discover/arch-review loop kept re-filing it.
//
// `probeReflectionOutcomesLedger` is a READ-ONLY liveness probe (NOT a revived
// reader/writer) that reports the ledger's residual state so the deep-health
// reflection-outcomes rule can surface it as a self-documenting INFO diagnostic.
// It NEVER writes and NEVER reintroduces the retired key-builder into
// `redis/keys.ts` — the retired key is a local literal here, scoped to this one
// diagnostic read.
const RETIRED_REFLECTION_OUTCOMES_KEY = "hydra:learning:reflection:outcomes";

/**
 * The residual state of the retired reflection-outcomes ledger.
 *
 * - `present` — the ZSET key still exists in Redis (a frozen tail lingers).
 * - `count` — number of members remaining (0 when absent).
 * - `latestEntryMs` — the max score (the retired writer used `Date.now()+i` as
 *   the score, so the max score is the newest entry's epoch-ms). `null` when the
 *   ledger is absent/empty or the score is non-finite.
 */
export interface ReflectionOutcomesLedgerState {
  present: boolean;
  count: number;
  latestEntryMs: number | null;
}

/**
 * Read-only liveness probe of the RETIRED reflection-outcomes ledger.
 *
 * Never throws (health-probe convention): a Redis error folds to the
 * absent/empty state `{ present: false, count: 0, latestEntryMs: null }` and is
 * logged, so a Redis blip can never abort the deep-health fan-out. Reads the
 * ZSET's cardinality (`ZCARD`) and, when non-empty, the newest member's score
 * via `ZREVRANGE … WITHSCORES` (the retired writer scored entries with
 * `Date.now()+i`, so the top score is the latest entry's epoch-ms). Purely
 * observational — it does NOT resurrect the retired reader/writer.
 */
export async function probeReflectionOutcomesLedger(): Promise<ReflectionOutcomesLedgerState> {
  const absent: ReflectionOutcomesLedgerState = {
    present: false,
    count: 0,
    latestEntryMs: null,
  };
  try {
    const r = getRedisConnection();
    const count = await r.zcard(RETIRED_REFLECTION_OUTCOMES_KEY);
    if (!Number.isFinite(count) || count <= 0) return absent;
    // Newest member = highest score (retired writer scored with Date.now()+i).
    const top = await r.zrevrange(RETIRED_REFLECTION_OUTCOMES_KEY, 0, 0, "WITHSCORES");
    const score = Array.isArray(top) && top.length >= 2 ? Number(top[1]) : NaN;
    return {
      present: true,
      count,
      latestEntryMs: Number.isFinite(score) ? score : null,
    };
  } catch (err: any) {
    console.error(
      `[redis/reflections] probeReflectionOutcomesLedger failed (folding to absent): ${err?.message || err}`,
    );
    return absent;
  }
}

/**
 * Count the per-anchor reflection keys via SCAN. Used by the health probe
 * to expose `reflectionKeys` without unbounded KEYS calls.
 */
export async function countReflectionKeys(): Promise<number> {
  const r = getRedisConnection();
  const pattern = redisKeys.reflection("*");
  let cursor = "0";
  let count = 0;
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    count += batch.length;
  } while (cursor !== "0");
  return count;
}

/**
 * Push a reflection entry for a specific anchor and set TTL.
 * Trims to maxEntries.
 */
export async function pushAnchorReflection(
  key: string,
  json: string,
  ttlSeconds: number,
  maxEntries: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(key, json);
  await r.expire(key, ttlSeconds);
  const len = await r.llen(key);
  if (len > maxEntries) {
    await r.ltrim(key, len - maxEntries, -1);
  }
}

/**
 * Fetch all entries from a reflection list.
 */
export async function getAnchorReflections(key: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(key, 0, -1);
}

// ===========================================================================
// By-file secondary index (issue #326)
// ===========================================================================
//
// Reflections are primarily keyed by `hydra:reflections:<normalized-anchor-ref>`,
// which is too narrow: 103/127 stored reflection keys are unique within the
// first 40 chars, so retries with a different anchor string but the same
// underlying file never re-use the reflection.
//
// This secondary index maps `file -> { anchorKey, anchorKey, ... }` via a
// Redis Set per file, so a new anchor touching `foo.ts` can fan out to
// every reflection key whose source anchor also touched `foo.ts`.

const BY_FILE_PREFIX = "hydra:reflections:by-file:";

/** Returns the Redis key holding the anchor-key set for `file`. */
function reflectionByFileKey(file: string): string {
  return BY_FILE_PREFIX + file;
}

/**
 * Add `anchorKey` to the by-file index for `file` and set TTL.
 * Idempotent — SADD is a no-op on duplicates.
 */
export async function addReflectionToFileIndex(
  file: string,
  anchorKey: string,
  ttlSeconds: number,
): Promise<void> {
  if (!file || !anchorKey) return;
  const r = getRedisConnection();
  const key = reflectionByFileKey(file);
  await r.sadd(key, anchorKey);
  await r.expire(key, ttlSeconds);
}

/**
 * Return all anchor keys associated with `file`. Empty array if none.
 */
export async function getReflectionKeysByFile(file: string): Promise<string[]> {
  if (!file) return [];
  const r = getRedisConnection();
  return r.smembers(reflectionByFileKey(file));
}
