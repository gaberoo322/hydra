/**
 * Generic Redis utility ops: scan, ttl, type, batch delete, hash field get.
 * Extracted from redis-adapter.ts (issue #269).
 */

import { getRedisConnection } from "./connection.ts";

/** Read a Redis INFO section (e.g. "memory", "stats"). Diagnostic helper. */
export async function redisInfo(section: string): Promise<string> {
  const r = getRedisConnection();
  return r.info(section);
}

/**
 * Liveness probe: PING the shared connection and report whether Redis answered
 * PONG. Owns the raw `getRedisConnection().ping()` call inside the seam so
 * liveness consumers (the service-strip health aggregator) reach a typed
 * accessor here instead of a dynamic `await import` of the raw connection or a
 * static `from .../redis/connection` import — both of which the seam-check
 * forbids outside the family (issue #1121). Lives in `utility.ts`, not
 * `connection.ts`, so the consumer's import does not itself trip the
 * raw-connection rule. Never throws — a connection error resolves `false`
 * (logged with context), matching the aggregator's degrade-to-down contract.
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const reply = await getRedisConnection().ping();
    return reply === "PONG" || reply === "PONG\n" || reply === "PONG\r\n";
  } catch (err: any) {
    console.error(`[redis/utility] ping failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Scan for keys matching a pattern with cursor-based iteration.
 * Returns all matching keys.
 */
export async function scanKeys(pattern: string): Promise<string[]> {
  const r = getRedisConnection();
  const allKeys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== "0");
  return allKeys;
}

/**
 * Get the TTL of a key. Returns -1 if no TTL, -2 if key does not exist.
 */
export async function getKeyTTL(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.ttl(key);
}

/**
 * Get the Redis type of a key.
 */
export async function getKeyType(key: string): Promise<string> {
  const r = getRedisConnection();
  return r.type(key);
}

/**
 * Delete multiple keys at once.
 */
export async function deleteKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const r = getRedisConnection();
  await r.del(...keys);
}

/**
 * Delete keys in batches.
 */
export async function deleteKeysBatch(keys: string[], batchSize = 500): Promise<void> {
  const r = getRedisConnection();
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await r.del(...batch);
  }
}

/**
 * Get a hash field value.
 */
export async function hashGet(key: string, field: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(key, field);
}
