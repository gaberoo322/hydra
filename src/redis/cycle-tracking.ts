/**
 * Cycle lifecycle tracking Redis ops (active, last, hash, sources, merge lock).
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

/** Set the active cycle ID. */
export async function setCycleActive(cycleId: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cycleActive(), cycleId);
}

/** Clear the active cycle. */
export async function clearCycleActive(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.cycleActive());
}

/** Set the last completed cycle ID. */
export async function setCycleLast(cycleId: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cycleLast(), cycleId);
}

/** Init cycle hash fields and set TTL. */
export async function initCycleHash(
  cycleId: string,
  fields: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.cycle(cycleId), ...Object.entries(fields).flat());
  await r.expire(redisKeys.cycle(cycleId), ttlSeconds);
}

/** Update cycle hash fields. */
export async function updateCycleHash(
  cycleId: string,
  fields: Record<string, string>,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.cycle(cycleId), ...Object.entries(fields).flat());
}

/** Refresh cycle hash TTL. */
export async function refreshCycleTTL(cycleId: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.expire(redisKeys.cycle(cycleId), ttlSeconds);
}

/** Register a cycle source (codex/claude) with TTL. */
export async function registerCycleSource(
  source: string,
  cycleId: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cycleActiveSource(source), cycleId, "EX", ttlSeconds);
}

/** Release a cycle source registration. */
export async function releaseCycleSource(source: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.cycleActiveSource(source));
}

// ---------------------------------------------------------------------------
// Merge lock
// ---------------------------------------------------------------------------

/** Try to acquire the merge lock. Returns true if acquired. */
export async function acquireMergeLock(cycleId: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(redisKeys.mergeLock(), cycleId, "EX", ttlSeconds, "NX");
  return result === "OK";
}

/** Get current merge lock holder. */
export async function getMergeLockHolder(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.mergeLock());
}

/** Release the merge lock. */
export async function releaseMergeLock(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.mergeLock());
}
