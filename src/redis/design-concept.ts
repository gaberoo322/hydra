/**
 * Design-concept Redis seam — typed accessors for the design-concept
 * persistence layer (issue #437) and its exempt-log audit trail (issue
 * #464). ADR-0009 closure follow-up.
 *
 * Surfaces:
 *   1. Per-anchor DC hash       — `hydra:design-concept:{anchorRef}`
 *   2. DC index ZSET            — `hydra:design-concept:index` (score = createdAt epoch ms)
 *   3. Exempt-log audit list    — `hydra:dc:exempt_log` (LPUSH-ed JSON entries)
 */

import { getRedisConnection } from "./connection.ts";

/**
 * Redis LIST holding `design-concept-exempt` audit entries. Newest-first
 * via LPUSH on write; LRANGE 0..limit-1 on read.
 */
const EXEMPT_LOG_KEY = "hydra:dc:exempt_log";

const DC_INDEX_KEY = "hydra:design-concept:index";

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
