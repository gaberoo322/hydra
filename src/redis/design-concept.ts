/**
 * Design-concept Redis seam — typed accessors for the design-concept
 * persistence layer (issue #437) and its exempt-log audit trail (issue
 * #464). ADR-0009 closure follow-up.
 *
 * Currently scoped to the exempt-log surface (the only Redis surface a
 * caller imports directly with kv primitives today). The DC hash + index
 * still live in src/design-concept.ts; when that file migrates, its
 * accessors will join this module.
 */

import { getRedisConnection } from "./connection.ts";

/**
 * Redis LIST holding `design-concept-exempt` audit entries. Newest-first
 * via LPUSH on write; LRANGE 0..limit-1 on read.
 */
const EXEMPT_LOG_KEY = "hydra:dc:exempt_log";

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
