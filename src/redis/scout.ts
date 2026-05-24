/**
 * Scout (tool-scout / hydra-tool-scout) Redis seam — ADR-0009 slice 4.
 *
 * Encapsulates every `hydra:scout:*` key family the scout subsystem uses:
 *
 *   - Daily stats hash         (`hydra:scout:stats:<DATE>`)
 *   - Calendar walk cooldowns  (`hydra:scout:last-calendar-walk`,
 *                               `hydra:scout:category-last-walked:<slug>`)
 *   - Spend mirror             (`hydra:scout:spend:<DATE>`)
 *   - Per-tool seen-list       (`hydra:scout:tools-considered:<slug>`)
 *   - Alert listener state     (`hydra:scout:alert-cursor`,
 *                               `hydra:scout:pattern-last-fired:<pattern>`)
 *   - Dispatch audit stream    (`hydra:scout:dispatches`)
 *
 * Callers (src/scout/*.ts, src/api/scout.ts) import these accessors instead
 * of `redis-keys.ts` + raw kv primitives. Key shapes live ONLY in
 * `src/redis-keys.ts` (until slice 6 moves it to `src/redis/keys.ts`).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";
import {
  expireKey,
  getString,
  hashGetAll,
  hashIncrBy,
  hashSet,
  keyExists,
  setString,
} from "./kv.ts";

// ---------------------------------------------------------------------------
// Stats — per-day per-category counters
// ---------------------------------------------------------------------------

/** Increment one field on the daily stats hash, refreshing TTL. */
export async function incrScoutStatsField(
  isoDate: string,
  field: string,
  delta: number,
  ttlSeconds: number,
): Promise<number> {
  const key = redisKeys.scoutStatsDaily(isoDate);
  const next = await hashIncrBy(key, field, delta);
  await expireKey(key, ttlSeconds);
  return next;
}

/** Read all fields on the daily stats hash. Returns {} when absent. */
export async function getScoutStatsHash(isoDate: string): Promise<Record<string, string>> {
  return hashGetAll(redisKeys.scoutStatsDaily(isoDate));
}

// ---------------------------------------------------------------------------
// Calendar-walk cooldowns
// ---------------------------------------------------------------------------

export async function getScoutLastCalendarWalk(): Promise<string | null> {
  return getString(redisKeys.scoutLastCalendarWalk());
}

export async function setScoutLastCalendarWalk(iso: string): Promise<void> {
  await setString(redisKeys.scoutLastCalendarWalk(), iso);
}

export async function getScoutCategoryLastWalked(category: string): Promise<string | null> {
  return getString(redisKeys.scoutCategoryLastWalked(category));
}

export async function setScoutCategoryLastWalked(category: string, iso: string): Promise<void> {
  await setString(redisKeys.scoutCategoryLastWalked(category), iso);
}

// ---------------------------------------------------------------------------
// Daily spend mirror
// ---------------------------------------------------------------------------

export async function getScoutSpendDaily(isoDate: string): Promise<string | null> {
  return getString(redisKeys.scoutSpendDaily(isoDate));
}

export async function setScoutSpendDaily(
  isoDate: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  await setString(redisKeys.scoutSpendDaily(isoDate), value, ttlSeconds);
}

// ---------------------------------------------------------------------------
// Per-tool seen-list
// ---------------------------------------------------------------------------

export async function scoutToolsConsideredExists(slug: string): Promise<boolean> {
  return keyExists(redisKeys.scoutToolsConsidered(slug));
}

export async function getScoutToolsConsidered(slug: string): Promise<Record<string, string>> {
  return hashGetAll(redisKeys.scoutToolsConsidered(slug));
}

export async function setScoutToolsConsidered(slug: string, ...flat: string[]): Promise<void> {
  await hashSet(redisKeys.scoutToolsConsidered(slug), ...flat);
}

// ---------------------------------------------------------------------------
// Alert listener state
// ---------------------------------------------------------------------------

export async function getScoutAlertCursor(): Promise<string | null> {
  return getString(redisKeys.scoutAlertCursor());
}

export async function setScoutAlertCursor(iso: string): Promise<void> {
  await setString(redisKeys.scoutAlertCursor(), iso);
}

export async function getScoutPatternLastFired(pattern: string): Promise<string | null> {
  return getString(redisKeys.scoutPatternLastFired(pattern));
}

export async function setScoutPatternLastFired(
  pattern: string,
  iso: string,
  ttlSeconds: number,
): Promise<void> {
  await setString(redisKeys.scoutPatternLastFired(pattern), iso, ttlSeconds);
}

// ---------------------------------------------------------------------------
// Dispatch audit stream
// ---------------------------------------------------------------------------

/** Append a dispatch audit entry (capped by MAXLEN ~N for cheap trim). */
export async function xaddScoutDispatch(maxLen: number, fields: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.xadd(
    redisKeys.scoutDispatches(),
    "MAXLEN",
    "~",
    String(maxLen),
    "*",
    ...fields,
  );
}

/** Read the most recent `limit` dispatch audit entries (newest-first). */
export async function xrevrangeScoutDispatches(
  limit: number,
): Promise<Array<[string, string[]]>> {
  const r = getRedisConnection();
  return r.xrevrange(redisKeys.scoutDispatches(), "+", "-", "COUNT", limit);
}
