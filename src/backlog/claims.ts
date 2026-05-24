/**
 * Atomic queued-lane claim — Lua script ensures two concurrent consumers
 * either claim different items or one gets a `wip-limit` / `empty` signal.
 */

import { claimNextQueuedBacklogItem } from "../redis/backlog.ts";
import { WIP_LIMIT, applyLaneTransition, saveItem } from "./internal.ts";

const LUA_CLAIM_NEXT_QUEUED = `
-- KEYS[1] = hydra:backlog:lane:queued
-- KEYS[2] = hydra:backlog:items
-- KEYS[3] = hydra:backlog:lane:inProgress
-- ARGV[1] = timestamp score for inProgress
-- ARGV[2] = WIP limit

-- Check WIP count
local wipCount = redis.call('ZCARD', KEYS[3])
if wipCount >= tonumber(ARGV[2]) then
  return cjson.encode({blocked = "wip-limit", count = wipCount})
end

-- Peek first queued item (sorted set is ordered by score = priority/timestamp)
local ids = redis.call('ZRANGE', KEYS[1], 0, 0)
if #ids == 0 then
  return cjson.encode({blocked = "empty"})
end

-- Atomic remove from queued — if another consumer beat us, ZREM returns 0
local removed = redis.call('ZREM', KEYS[1], ids[1])
if removed == 0 then
  return cjson.encode({blocked = "race"})
end

-- Add to inProgress
redis.call('ZADD', KEYS[3], ARGV[1], ids[1])

-- Return item data
local raw = redis.call('HGET', KEYS[2], ids[1])
if not raw then
  return cjson.encode({blocked = "missing-data", id = ids[1]})
end
return raw
`;

/**
 * Atomically claim the highest-priority queued item and move it to inProgress.
 * Uses a Lua script so no two concurrent consumers claim the same item.
 */
export async function claimNextQueuedItem(claimedBy: string): Promise<{
  claimed: boolean;
  item?: any;
  reason?: string;
  count?: number;
}> {
  const result = await claimNextQueuedBacklogItem(LUA_CLAIM_NEXT_QUEUED, Date.now(), WIP_LIMIT);

  if (!result) return { claimed: false, reason: "no-result" };

  try {
    const parsed = JSON.parse(result);
    if (parsed.blocked) {
      return { claimed: false, reason: parsed.blocked, count: parsed.count };
    }

    // Raw item JSON — stamp lane metadata and persist.
    parsed.meta = {
      ...parsed.meta,
      startedAt: new Date().toISOString().split("T")[0],
      claimedBy,
    };
    applyLaneTransition(parsed, "inProgress", { claimedBy });
    await saveItem(parsed);
    return { claimed: true, item: parsed };
  } catch {
    return { claimed: false, reason: "parse-error" };
  }
}
