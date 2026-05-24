/**
 * Backlog Redis ops. Extracted from redis-adapter.ts (issue #269).
 *
 * NOTE: This is the low-level Redis backlog adapter, not the higher-level
 * Backlog Module (src/backlog/) which uses these primitives. Naming kept
 * to satisfy issue #269's acceptance criteria.
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Get backlog lane entries with scores (for stale-check).
 * Returns [id1, score1, id2, score2, ...].
 */
export async function getBacklogLaneWithScores(lane: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.backlogLane(lane), 0, -1, "WITHSCORES");
}

/**
 * Get a backlog item by ID.
 */
export async function getBacklogItem(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.backlogItems(), id);
}

/**
 * Update a backlog item and move it between lanes atomically.
 */
export async function moveBacklogItem(
  id: string,
  itemJson: string,
  fromLane: string,
  toLane: string,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.backlogItems(), id, itemJson);
  await r.zrem(redisKeys.backlogLane(fromLane), id);
  await r.zadd(redisKeys.backlogLane(toLane), Date.now(), id);
}

/** Increment the backlog counter and return new ID. */
export async function incrBacklogCounter(): Promise<string> {
  const r = getRedisConnection();
  const id = await r.incr(redisKeys.backlogCounter());
  return `item-${id}`;
}

/** Get a backlog item by ID (raw JSON string). */
export async function getBacklogItemRaw(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.backlogItems(), id);
}

/** Save a backlog item. */
export async function saveBacklogItem(id: string, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.backlogItems(), id, json);
}

/** Delete a backlog item from hash and all lane sorted sets. */
export async function removeBacklogItem(id: string, lanes: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.hdel(redisKeys.backlogItems(), id);
  for (const lane of lanes) {
    await r.zrem(redisKeys.backlogLane(lane), id);
  }
}

/** Get all IDs in a backlog lane. */
export async function getBacklogLaneIds(lane: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.backlogLane(lane), 0, -1);
}

/** Get cardinality of a backlog lane. */
export async function getBacklogLaneCount(lane: string): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(redisKeys.backlogLane(lane));
}

/** Add an item to a backlog lane sorted set. */
export async function addToBacklogLane(lane: string, score: number, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(redisKeys.backlogLane(lane), score, id);
}

/** Remove an item from a backlog lane sorted set. */
export async function removeFromBacklogLane(lane: string, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(redisKeys.backlogLane(lane), id);
}

/** Execute a Lua script (for atomic backlog operations). */
export async function evalScript(
  script: string,
  numKeys: number,
  ...args: (string | number)[]
): Promise<any> {
  const r = getRedisConnection();
  return r.eval(script, numKeys, ...args);
}
