/**
 * Generic Redis key/value, list, sorted set, and hash primitives.
 * Extracted from redis-adapter.ts (issue #269).
 *
 * These are thin pass-throughs around ioredis methods used by many modules.
 * Prefer the domain-specific adapters when one exists.
 */

import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// String + key ops
// ---------------------------------------------------------------------------

/** Get a string value by key. */
export async function getString(key: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(key);
}

/** Set a string value by key (optional EX ttl). */
export async function setString(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const r = getRedisConnection();
  if (ttlSeconds != null) {
    await r.set(key, value, "EX", ttlSeconds);
  } else {
    await r.set(key, value);
  }
}

/** Delete one or more keys. */
export async function delKey(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const r = getRedisConnection();
  await r.del(...keys);
}

/** Set a key only if it does not exist (NX), with TTL. Returns true if set. */
export async function setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(key, value, "EX", ttlSeconds, "NX");
  return result === "OK";
}

/** Increment a key and return the new value. */
export async function incrKey(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.incr(key);
}

/** Set TTL on a key. */
export async function expireKey(key: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.expire(key, ttlSeconds);
}

/** Check if a key exists. Returns true if the key exists. */
export async function keyExists(key: string): Promise<boolean> {
  const r = getRedisConnection();
  const val = await r.exists(key);
  return val === 1;
}

/** Find all keys matching a pattern. Use sparingly — prefer SCAN. */
export async function findKeys(pattern: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.keys(pattern);
}

/** Get Redis INFO for a section. */
export async function redisInfo(section: string): Promise<string> {
  const r = getRedisConnection();
  return r.info(section);
}

// ---------------------------------------------------------------------------
// Hash ops
// ---------------------------------------------------------------------------

/** Get all fields of a hash. */
export async function hashGetAll(key: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(key);
}

/** Set multiple fields on a hash. */
export async function hashSet(key: string, ...fieldsAndValues: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.hset(key, ...fieldsAndValues);
}

/** Set a single field on a hash. */
export async function hashSetField(key: string, field: string, value: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(key, field, value);
}

/** Delete a field from a hash. */
export async function hashDel(key: string, field: string): Promise<void> {
  const r = getRedisConnection();
  await r.hdel(key, field);
}

/** Increment a hash field by an integer amount. */
export async function hashIncrBy(key: string, field: string, increment: number): Promise<number> {
  const r = getRedisConnection();
  return r.hincrby(key, field, increment);
}

// ---------------------------------------------------------------------------
// List ops
// ---------------------------------------------------------------------------

/** Get the length of a list. */
export async function listLen(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.llen(key);
}

/** Get a range of list elements. */
export async function listRange(key: string, start: number, stop: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(key, start, stop);
}

/** Push to the right end of a list. */
export async function listRPush(key: string, ...values: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(key, ...values);
}

/** Push to the left end of a list. */
export async function listLPush(key: string, ...values: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(key, ...values);
}

/** Pop from the left end of a list. */
export async function listLPop(key: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.lpop(key);
}

/** Remove count occurrences of value from list. */
export async function listRem(key: string, count: number, value: string): Promise<number> {
  const r = getRedisConnection();
  return r.lrem(key, count, value);
}

/** Atomically move an element from source list to dest list. */
export async function listMove(
  source: string,
  dest: string,
  srcDir: "LEFT" | "RIGHT",
  destDir: "LEFT" | "RIGHT",
): Promise<string | null> {
  const r = getRedisConnection();
  return r.lmove(source, dest, srcDir, destDir);
}

/** Set a list element at a given index. */
export async function listSet(key: string, index: number, value: string): Promise<void> {
  const r = getRedisConnection();
  await r.lset(key, index, value);
}

/** Trim a list to the specified range. */
export async function listTrim(key: string, start: number, stop: number): Promise<void> {
  const r = getRedisConnection();
  await r.ltrim(key, start, stop);
}

// ---------------------------------------------------------------------------
// Sorted set ops
// ---------------------------------------------------------------------------

/** Get range of sorted set members. */
export async function zRange(key: string, start: number, stop: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(key, start, stop);
}

/** Get reverse range of sorted set members. */
export async function zRevRange(key: string, start: number, stop: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(key, start, stop);
}

/** Add a member to a sorted set. */
export async function zAdd(key: string, score: number, member: string): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(key, score, member);
}

/** Remove a member from a sorted set. */
export async function zRem(key: string, member: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(key, member);
}

/** Get sorted set cardinality. */
export async function zCard(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(key);
}

// ---------------------------------------------------------------------------
// Set ops
// ---------------------------------------------------------------------------

/** Get all members of a set. */
export async function setMembers(key: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.smembers(key);
}

/** Add member(s) to a set. */
export async function setAdd(key: string, ...members: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.sadd(key, ...members);
}

/** Remove member(s) from a set. */
export async function setRem(key: string, ...members: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.srem(key, ...members);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Create a Redis pipeline for batched commands.
 * Caller must call `.exec()` on the returned pipeline.
 */
export function createPipeline(): any {
  const r = getRedisConnection();
  return r.pipeline();
}
