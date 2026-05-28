/**
 * Design-concept Redis seam — typed accessors for the design-concept
 * persistence layer (issue #437) and its exempt-log audit trail (issue
 * #464). ADR-0009 closure follow-up.
 *
 * Surfaces:
 *   1. Per-anchor DC hash       — `hydra:design-concept:{anchorRef}`
 *   2. DC index ZSET            — `hydra:design-concept:index` (score = createdAt epoch ms)
 *   3. Exempt-log audit list    — `hydra:dc:exempt_log` (LPUSH-ed JSON entries)
 *   4. Daily snapshot HASH      — `hydra:dc:daily-snapshot` (issue #628; field=YYYY-MM-DD UTC, value=index size at snapshot time)
 */

import { getRedisConnection } from "./connection.ts";

/**
 * Redis LIST holding `design-concept-exempt` audit entries. Newest-first
 * via LPUSH on write; LRANGE 0..limit-1 on read.
 */
const EXEMPT_LOG_KEY = "hydra:dc:exempt_log";

const DC_INDEX_KEY = "hydra:design-concept:index";

/**
 * Daily-snapshot HASH (issue #628). Fields are ISO date strings
 * (YYYY-MM-DD, UTC); values are the `ZCARD hydra:design-concept:index`
 * value at snapshot time. The 7-day green-light criterion from issue
 * #628 §Acceptance is computed by reading the last 7 fields. The HASH
 * is opportunistically pruned to MAX_SNAPSHOT_DAYS entries on every
 * write, so it stays bounded.
 */
const DC_DAILY_SNAPSHOT_KEY = "hydra:dc:daily-snapshot";

/** How many days of snapshots we keep. 14d > 7d window, gives one
 *  retry-buffer if the snapshot tick is skipped on a given day. */
const MAX_SNAPSHOT_DAYS = 14;

function dcHashKey(anchorRef: string): string {
  return `hydra:design-concept:${anchorRef}`;
}

// ---------------------------------------------------------------------------
// DC hash + index accessors
// ---------------------------------------------------------------------------

/**
 * Overwrite the design-concept hash with serialized field/value pairs,
 * stamp the TTL, and add the anchorRef to the date-scored index.
 *
 * `fields` is a flat array of alternating field/value strings (the same
 * shape `redis.hset` accepts).
 */
export async function saveDesignConceptHash(
  anchorRef: string,
  createdAt: number,
  fields: string[],
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  const key = dcHashKey(anchorRef);
  await r.hset(key, ...fields);
  await r.expire(key, ttlSeconds);
  await r.zadd(DC_INDEX_KEY, createdAt, anchorRef);
}

/** Read the full DC hash for `anchorRef`. Returns {} when absent. */
export async function getDesignConceptHash(anchorRef: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(dcHashKey(anchorRef));
}

/** Update a single field on the DC hash (used by approval). */
export async function setDesignConceptField(
  anchorRef: string,
  field: string,
  value: string,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(dcHashKey(anchorRef), field, value);
}

/** Read every anchorRef in the DC index, newest-first. */
export async function listAllDesignConceptRefs(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(DC_INDEX_KEY, 0, -1);
}

/** Read the most recent `limit` anchorRefs in the DC index, newest-first. */
export async function listRecentDesignConceptRefs(limit: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(DC_INDEX_KEY, 0, Math.max(0, limit - 1));
}

/** Drop an anchorRef from the DC index (used by stale-entry prune). */
export async function removeDesignConceptFromIndex(anchorRef: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(DC_INDEX_KEY, anchorRef);
}

/** Append an exempt-log entry (JSON-serialized) to the audit list. */
export async function appendExemptLogEntry(entryJson: string): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(EXEMPT_LOG_KEY, entryJson);
}

/** Read the most recent `limit` exempt-log entries newest-first. */
export async function readRecentExemptLogEntries(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const r = getRedisConnection();
  return r.lrange(EXEMPT_LOG_KEY, 0, limit - 1);
}

// ---------------------------------------------------------------------------
// Daily snapshot accessors (issue #628)
// ---------------------------------------------------------------------------

/**
 * Read the current size of the DC index — used by the daily-snapshot
 * writer to record how many artifacts exist at snapshot time.
 */
export async function getDesignConceptIndexSize(): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(DC_INDEX_KEY);
}

/**
 * Write today's snapshot value into the daily-snapshot HASH and prune
 * fields older than MAX_SNAPSHOT_DAYS. Idempotent on `date` — a second
 * call within the same day just overwrites the field.
 */
export async function writeDailySnapshot(date: string, count: number): Promise<void> {
  const r = getRedisConnection();
  await r.hset(DC_DAILY_SNAPSHOT_KEY, date, String(count));
  // Opportunistic prune so the HASH stays bounded. Sort fields by date
  // (lexical sort works because YYYY-MM-DD is monotonic), then drop
  // anything beyond MAX_SNAPSHOT_DAYS days from the newest entry.
  const all = await r.hkeys(DC_DAILY_SNAPSHOT_KEY);
  if (all.length <= MAX_SNAPSHOT_DAYS) return;
  const sorted = all.slice().sort(); // ascending; oldest first
  const dropCount = sorted.length - MAX_SNAPSHOT_DAYS;
  const toDrop = sorted.slice(0, dropCount);
  if (toDrop.length > 0) {
    await r.hdel(DC_DAILY_SNAPSHOT_KEY, ...toDrop);
  }
}

/**
 * Read all daily-snapshot fields. Returns an array of `{date, count}`
 * tuples newest-first. Callers compute the consecutive-non-zero day
 * count from this list (≥7 → green-light Phase C per issue #628).
 */
export async function readDailySnapshots(): Promise<Array<{ date: string; count: number }>> {
  const r = getRedisConnection();
  const raw = await r.hgetall(DC_DAILY_SNAPSHOT_KEY);
  const entries = Object.entries(raw)
    .map(([date, value]) => ({ date, count: Number(value) || 0 }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries;
}
