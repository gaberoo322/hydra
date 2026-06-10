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
-- ARGV[3] = targeted item id, or '' for pop-head (issue #1682)

-- Check WIP count. Runs BEFORE the branch: targeting selects WHICH queued
-- item is claimed — it never bypasses claim policy.
local wipCount = redis.call('ZCARD', KEYS[3])
if wipCount >= tonumber(ARGV[2]) then
  return cjson.encode({blocked = "wip-limit", count = wipCount})
end

local id
if ARGV[3] ~= '' then
  -- Targeted claim: ZREM doubles as the lane-membership check AND the atomic
  -- removal — 0 means the item is not in the queued lane right now. HEXISTS
  -- distinguishes "exists but in another lane" (not-queued) from "no such
  -- item" (not-found).
  local removed = redis.call('ZREM', KEYS[1], ARGV[3])
  if removed == 0 then
    if redis.call('HEXISTS', KEYS[2], ARGV[3]) == 1 then
      return cjson.encode({blocked = "not-queued", id = ARGV[3]})
    end
    return cjson.encode({blocked = "not-found", id = ARGV[3]})
  end
  id = ARGV[3]
else
  -- Pop-head: peek first queued item (sorted set is ordered by score =
  -- priority/timestamp).
  local ids = redis.call('ZRANGE', KEYS[1], 0, 0)
  if #ids == 0 then
    return cjson.encode({blocked = "empty"})
  end

  -- Atomic remove from queued — if another consumer beat us, ZREM returns 0
  local removed = redis.call('ZREM', KEYS[1], ids[1])
  if removed == 0 then
    return cjson.encode({blocked = "race"})
  end
  id = ids[1]
end

-- Add to inProgress
redis.call('ZADD', KEYS[3], ARGV[1], id)

-- Return item data
local raw = redis.call('HGET', KEYS[2], id)
if not raw then
  return cjson.encode({blocked = "missing-data", id = id})
end
return raw
`;

/**
 * Atomically claim a queued item and move it to inProgress. Uses a Lua script
 * so no two concurrent consumers claim the same item.
 *
 * - `itemId` absent → claim the highest-priority queued item (pop-head, the
 *   pre-#1682 behavior, byte-compatible for existing callers).
 * - `itemId` present → claim exactly that item if it is in the queued lane;
 *   otherwise `{claimed:false, reason:"not-queued"|"not-found"}` (issue
 *   #1682 — the route maps these to 409/404).
 *
 * Both variants share the WIP check, race semantics, and the metadata-stamp +
 * persist tail below — no drift between targeted and pop-head claims.
 */
export async function claimNextQueuedItem(
  claimedBy: string,
  itemId?: string,
): Promise<{
  claimed: boolean;
  item?: any;
  reason?: string;
  count?: number;
}> {
  const result = await claimNextQueuedBacklogItem(LUA_CLAIM_NEXT_QUEUED, Date.now(), WIP_LIMIT, itemId);

  if (!result) return { claimed: false, reason: "no-result" };

  // Parse the Lua return value first. A failure here is a corrupt Redis write
  // (poisoned `hydra:backlog:items` entry) — distinct from the legitimate
  // `blocked` paths below — and MUST surface loudly rather than stall the queue
  // invisibly (CLAUDE.md fail-loud; issue #1122). The result-object contract is
  // preserved (we never throw from the claim path).
  let parsed: any;
  try {
    parsed = JSON.parse(result);
  } catch (err) {
    console.error(
      `[backlog/claim] corrupt queue item — JSON.parse failed (claimedBy=${claimedBy}). ` +
        `The item was already removed from the queued lane by the Lua claim and is now orphaned. ` +
        `Raw value: ${truncate(result)}`,
      err,
    );
    return { claimed: false, reason: "parse-error" };
  }

  if (parsed.blocked) {
    return { claimed: false, reason: parsed.blocked, count: parsed.count };
  }

  // Raw item JSON — stamp lane metadata and persist. A failure persisting the
  // claimed item is distinct from a parse failure: the item parsed fine but the
  // write-back (e.g. a Redis seam error) failed. Log it and return a result
  // object — the claim path never throws (issue #1122 implementation note).
  try {
    parsed.meta = {
      ...parsed.meta,
      startedAt: new Date().toISOString().split("T")[0],
      claimedBy,
    };
    applyLaneTransition(parsed, "inProgress", { claimedBy });
    await saveItem(parsed);
    return { claimed: true, item: parsed };
  } catch (err) {
    console.error(
      `[backlog/claim] failed to persist claimed item (claimedBy=${claimedBy}, id=${parsed?.id}). ` +
        `The Lua claim already moved it into the inProgress lane, so it is now in inProgress without ` +
        `refreshed claim metadata.`,
      err,
    );
    return { claimed: false, reason: "save-error" };
  }
}

/** Bound the raw-value context so an oversized corrupt blob can't flood the log. */
function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars total)` : s;
}
