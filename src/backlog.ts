/**
 * Backlog Manager — Redis-backed
 *
 * Lanes: Backlog → Queued → Blocked → In Progress → Done
 *
 * Research populates Backlog.
 * Scheduler moves items from Backlog → Queued (and into Redis work queue).
 * Control loop moves Queued → In Progress → Done.
 * Blocked items require operator intervention.
 * Done items are pruned after 7 days.
 *
 * Redis schema:
 *   hydra:backlog:items         → Hash: itemId → JSON item
 *   hydra:backlog:lane:{lane}   → Sorted Set: itemId scored by position timestamp
 *   hydra:backlog:counter       → Auto-increment ID counter
 */

import { redisKeys } from "./redis-keys.ts";
import {
  getBacklogItemRaw, saveBacklogItem, removeBacklogItem as removeBacklogItemAdapter,
  getBacklogLaneIds, getBacklogLaneCount, addToBacklogLane, removeFromBacklogLane,
  incrBacklogCounter, evalScript,
} from "./redis-adapter.ts";

const DONE_RETENTION_DAYS = 7;
const LANES = ["triage", "backlog", "queued", "blocked", "inProgress", "done"];

async function nextId() {
  return incrBacklogCounter();
}

async function getItem(id) {
  const raw = await getBacklogItemRaw(id);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveItem(item) {
  await saveBacklogItem(item.id, JSON.stringify(item));
}

async function removeItem(id) {
  await removeBacklogItemAdapter(id, LANES);
}

async function getLaneItems(lane) {
  const ids = await getBacklogLaneIds(lane);
  if (ids.length === 0) return [];
  const items = [];
  for (const id of ids) {
    const item = await getItem(id);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Load all lanes — same return shape as the old markdown parser.
 */
async function loadBacklog() {
  const lanes = {};
  for (const lane of LANES) {
    lanes[lane] = await getLaneItems(lane);
  }
  return lanes;
}

/**
 * Get backlog depth counts for monitoring.
 */
async function getBacklogCounts() {
  const counts: Record<string, number> = {};
  for (const lane of LANES) {
    counts[lane] = await getBacklogLaneCount(lane);
  }
  counts.total = (counts.triage || 0) + counts.backlog + counts.queued;
  return counts;
}

/**
 * Add an item to the backlog lane.
 * Called by research-loop when opportunities are identified.
 */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  // Need at least 4 significant words in each title for fuzzy matching to be reliable
  if (wordsA.size < 4 || wordsB.size < 4) return 0;
  const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

const FUZZY_DEDUP_THRESHOLD = 0.7; // 70% word overlap = duplicate

async function addToBacklog(item) {
  // Dedup: check all lanes for exact or fuzzy title match
  const lanes = await loadBacklog();
  for (const lane of LANES) {
    for (const existing of lanes[lane]) {
      if (existing.title === item.title) {
        return { added: false, reason: "duplicate", matchedId: existing.id };
      }
      const sim = titleSimilarity(existing.title, item.title);
      if (sim >= FUZZY_DEDUP_THRESHOLD) {
        console.log(`[Backlog] Fuzzy dedup: "${item.title}" is ${Math.round(sim * 100)}% similar to "${existing.title}" (${existing.id})`);
        return { added: false, reason: "fuzzy-duplicate", matchedId: existing.id, similarity: sim };
      }
    }
  }

  const id = await nextId();
  const targetLane = item.lane || "backlog";
  const backlogItem = {
    id,
    title: item.title,
    checked: false,
    tags: [item.category || "uncategorized"].filter(Boolean),
    priority: item.priority ?? 0,
    description: item.description || "",
    labels: item.labels || [],
    estimate: item.estimate ?? null,
    parentId: item.parentId ?? null,
    meta: {
      source: item.source || "research",
      score: item.adjustedScore,
      confidence: item.confidence,
      complexity: item.complexity,
      addedAt: new Date().toISOString().split("T")[0],
    },
    lane: targetLane,
  };

  await saveItem(backlogItem);
  await addToBacklogLane(targetLane, Date.now(), id);
  return { added: true, id };
}

/**
 * Move the top N backlog items to the Queued lane, sorted by priority.
 * Priority 1 (urgent) first, 0 (none/unset) last. Ties broken by score then age.
 */
async function promoteToQueued(count = 1) {
  const ids = await getBacklogLaneIds("backlog");
  if (ids.length === 0) return [];

  // Fetch all items and sort by priority
  const items = [];
  for (const id of ids) {
    const item = await getItem(id);
    if (item) items.push(item);
  }

  items.sort((a, b) => {
    const pa = a.priority || 0;
    const pb = b.priority || 0;
    // Priority 1 (urgent) first; 0 (none) last
    const orderA = pa === 0 ? 99 : pa;
    const orderB = pb === 0 ? 99 : pb;
    if (orderA !== orderB) return orderA - orderB;
    // Same priority — higher score first
    const sa = a.meta?.score ?? 0;
    const sb = b.meta?.score ?? 0;
    if (sb !== sa) return sb - sa;
    // Same score — older item first
    return (a.meta?.addedAt || "").localeCompare(b.meta?.addedAt || "");
  });

  const toPromote = items.slice(0, count);
  const moved = [];

  for (const item of toPromote) {
    await removeFromBacklogLane("backlog", item.id);
    item.lane = "queued";
    item.meta = { ...item.meta, queuedAt: new Date().toISOString().split("T")[0] };
    await saveItem(item);
    await addToBacklogLane("queued", Date.now(), item.id);
    moved.push(item);
  }

  return moved;
}

/**
 * Move a queued item to In Progress by title.
 */
async function moveToInProgress(title) {
  // Search queued first, then backlog
  for (const sourceLane of ["queued", "backlog"]) {
    const ids = await getBacklogLaneIds(sourceLane);
    for (const id of ids) {
      const item = await getItem(id);
      if (item && item.title === title) {
        await removeFromBacklogLane(sourceLane, id);
        item.lane = "inProgress";
        item.meta = { ...item.meta, startedAt: new Date().toISOString().split("T")[0] };
        await saveItem(item);
        await addToBacklogLane("inProgress", Date.now(), id);
        return true;
      }
    }
  }
  return false;
}

/**
 * Move an in-progress item to Done.
 */
async function moveToDone(title, outcome = "merged") {
  const ids = await getBacklogLaneIds("inProgress");

  for (const id of ids) {
    const item = await getItem(id);
    if (item && item.title === title) {
      await removeFromBacklogLane("inProgress", id);
      item.lane = "done";
      item.checked = outcome === "merged";
      item.meta = {
        ...item.meta,
        completedAt: new Date().toISOString().split("T")[0],
        outcome,
      };
      await saveItem(item);
      // Score with negative timestamp so newest is first in zrange
      await addToBacklogLane("done", -Date.now(), id);
      return true;
    }
  }
  return false;
}

/**
 * Move an item to the Blocked lane.
 */
async function moveToBlocked(title, reason) {
  for (const sourceLane of ["inProgress", "queued", "backlog"]) {
    const ids = await getBacklogLaneIds(sourceLane);
    for (const id of ids) {
      const item = await getItem(id);
      if (item && item.title === title) {
        await removeFromBacklogLane(sourceLane, id);
        item.lane = "blocked";
        item.meta = {
          ...item.meta,
          blockedAt: new Date().toISOString().split("T")[0],
          blockedReason: reason,
        };
        await saveItem(item);
        await addToBacklogLane("blocked", Date.now(), id);
        console.log(`[Backlog] Moved "${title}" to Blocked: ${reason}`);
        return true;
      }
    }
  }
  return false;
}

/**
 * Remove a failed/abandoned item from In Progress back to Backlog.
 */
async function returnToBacklog(title, reason) {
  const ids = await getBacklogLaneIds("inProgress");

  for (const id of ids) {
    const item = await getItem(id);
    if (item && item.title === title) {
      await removeFromBacklogLane("inProgress", id);
      item.lane = "backlog";
      item.meta = { ...item.meta, returnedAt: new Date().toISOString().split("T")[0], returnReason: reason };
      await saveItem(item);
      await addToBacklogLane("backlog", Date.now(), id);
      return true;
    }
  }
  return false;
}

/**
 * Prune done items older than DONE_RETENTION_DAYS.
 */
async function pruneOldDoneItems() {
  const ids = await getBacklogLaneIds("done");
  const cutoff = Date.now() - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const id of ids) {
    const item = await getItem(id);
    if (!item) { await removeFromBacklogLane("done", id); continue; }
    const completedAt = item.meta?.completedAt;
    if (completedAt && new Date(completedAt).getTime() < cutoff) {
      await removeItem(id);
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(`[Backlog] Pruned ${pruned} done items older than ${DONE_RETENTION_DAYS} days`);
  }
}

/**
 * Move an item to Blocked by ID, with a structured reason.
 * Used by priorities-refresh to sync [BLOCKED] items from priorities.md.
 */
async function blockItemById(itemId, reason) {
  const item = await getItem(itemId);
  if (!item) return false;
  if (item.lane === "blocked") return false; // already blocked

  // Remove from current lane
  for (const lane of LANES) {
    await removeFromBacklogLane(lane, itemId);
  }

  item.lane = "blocked";
  item.meta = {
    ...item.meta,
    blockedAt: new Date().toISOString().split("T")[0],
    blockedReason: reason,
  };
  await saveItem(item);
  await addToBacklogLane("blocked", Date.now(), itemId);
  console.log(`[Backlog] Blocked item "${item.title}" (${itemId}): ${reason}`);
  return true;
}

/**
 * Move an item between lanes by ID (for dashboard drag-and-drop).
 */
async function moveItemToLane(itemId, targetLane) {
  if (!LANES.includes(targetLane)) return { ok: false, error: `Invalid lane: ${targetLane}` };
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };

  // Remove from current lane
  for (const lane of LANES) {
    await removeFromBacklogLane(lane, itemId);
  }

  item.lane = targetLane;
  await saveItem(item);
  const score = targetLane === "done" ? -Date.now() : Date.now();
  await addToBacklogLane(targetLane, score, itemId);
  return { ok: true };
}

/**
 * Delete an item entirely.
 */
async function deleteItem(itemId) {
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };
  await removeItem(itemId);
  return { ok: true };
}

/**
 * Update specific fields on an existing backlog item.
 */
async function updateItem(itemId, updates) {
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };
  const ALLOWED = ["priority", "description", "labels", "estimate", "parentId", "title"];
  for (const key of ALLOWED) {
    if (updates[key] !== undefined) item[key] = updates[key];
  }
  await saveItem(item);
  return { ok: true, item };
}

/**
 * Get all items that have the given parentId, across all lanes.
 */
async function getItemsByParent(parentId) {
  const lanes = await loadBacklog();
  const children = [];
  for (const lane of LANES) {
    for (const item of lanes[lane]) {
      if (item.parentId === parentId) children.push(item);
    }
  }
  return children;
}

/**
 * Close the Redis connection (for tests/cleanup).
 */
async function closeBacklogRedis() {
  // No-op: Redis connection is managed by the shared redis-adapter singleton
}

/**
 * Return the highest-priority item from the queued lane without removing it.
 * Priority 1 (urgent) first; 0 (none/unset) last. Ties broken by score then age.
 */
async function peekNextQueuedItem() {
  const items = await getLaneItems("queued");
  if (items.length === 0) return null;

  items.sort((a, b) => {
    const pa = a.priority || 0;
    const pb = b.priority || 0;
    const orderA = pa === 0 ? 99 : pa;
    const orderB = pb === 0 ? 99 : pb;
    if (orderA !== orderB) return orderA - orderB;
    const sa = a.meta?.score ?? 0;
    const sb = b.meta?.score ?? 0;
    if (sb !== sa) return sb - sa;
    return (a.meta?.addedAt || "").localeCompare(b.meta?.addedAt || "");
  });

  return items[0];
}

// ---------------------------------------------------------------------------
// WIP (Work-In-Progress) limit — prevent starting new work when too many
// items are already in-progress. Forces the system to finish existing work.
// ---------------------------------------------------------------------------

const WIP_LIMIT = parseInt(process.env.HYDRA_WIP_LIMIT) || 3;
const STALE_IN_PROGRESS_DAYS = parseInt(process.env.HYDRA_STALE_IN_PROGRESS_DAYS) || 7;

/**
 * Get the current number of items in the inProgress lane.
 */
async function getInProgressCount() {
  return await getBacklogLaneCount("inProgress");
}

/**
 * Get all items currently in the inProgress lane, sorted by priority.
 */
async function getInProgressItems() {
  return await getLaneItems("inProgress");
}

/**
 * Check if the WIP limit has been reached.
 * When true, the anchor selector should prefer completing existing work
 * over starting new items from the queue.
 */
async function isWipLimitReached() {
  const count = await getInProgressCount();
  return { atLimit: count >= WIP_LIMIT, count, limit: WIP_LIMIT };
}

/**
 * Requeue in-progress items that have been stale for >STALE_IN_PROGRESS_DAYS
 * with no recent activity (based on startedAt timestamp).
 *
 * Returns the list of requeued items for logging/notification.
 */
async function requeueStaleInProgressItems() {
  const ids = await getBacklogLaneIds("inProgress");
  const now = Date.now();
  const cutoffMs = STALE_IN_PROGRESS_DAYS * 24 * 60 * 60 * 1000;
  const requeued = [];

  for (const id of ids) {
    const item = await getItem(id);
    if (!item) continue;

    const startedAt = item.meta?.startedAt;
    if (!startedAt) continue;

    const startedMs = new Date(startedAt).getTime();
    if (!Number.isFinite(startedMs)) continue;

    const ageMs = now - startedMs;
    if (ageMs > cutoffMs) {
      await removeFromBacklogLane("inProgress", id);
      item.lane = "queued";
      item.meta = {
        ...item.meta,
        requeuedAt: new Date().toISOString().split("T")[0],
        requeueReason: `Stale in-progress for ${Math.round(ageMs / (24 * 60 * 60 * 1000))} days (WIP limit enforcement)`,
      };
      await saveItem(item);
      await addToBacklogLane("queued", Date.now(), id);
      requeued.push(item);
      console.log(`[Backlog] Requeued stale inProgress item ${id} ("${item.title?.slice(0, 60)}") — ${Math.round(ageMs / (24 * 60 * 60 * 1000))} days old`);
    }
  }

  return requeued;
}

/**
 * Parse the active milestone from roadmap.md and return progress.
 */
async function getCurrentMilestoneProgress() {
  const { readFile } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");
  const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
  try {
    const roadmap = await readFile(join(CONFIG_PATH, "direction", "roadmap.md"), "utf-8");
    // Find the active milestone block
    const blocks = roadmap.split(/^## /m).filter(Boolean);
    for (const block of blocks) {
      if (!block.includes("status: active")) continue;
      const nameMatch = block.match(/^(.+)\n/);
      const name = nameMatch ? nameMatch[1].trim() : "Unknown";
      const lines = block.split("\n");
      const epics = lines.filter(l => /^- \[[ x\-]\]/.test(l));
      const done = epics.filter(l => l.startsWith("- [x]")).length;
      const blocked = epics.filter(l => l.startsWith("- [-]")).length;
      const total = epics.length;
      const remaining = epics
        .filter(l => l.startsWith("- [ ]"))
        .map(l => l.replace(/^- \[ \] /, "").trim());
      return {
        name,
        total,
        done,
        blocked,
        remaining: total - done - blocked,
        remainingTitles: remaining,
        pctComplete: total > 0 ? Math.round((done / total) * 100) : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Atomic backlog claim — Lua script that atomically checks WIP limit, removes
// the top item from queued, and adds it to inProgress. Two concurrent consumers
// calling this get different items (or one gets null). Used by both Codex
// orchestrator and Claude Code /hydra-build for safe parallel execution.
// ---------------------------------------------------------------------------

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
 * Uses a Lua script to guarantee no two concurrent consumers claim the same item.
 *
 * @param {string} claimedBy — source identifier ("codex" or "claude")
 * @returns {Promise<{claimed: boolean, item?: object, reason?: string}>}
 */
async function claimNextQueuedItem(claimedBy) {
  const result = await evalScript(
    LUA_CLAIM_NEXT_QUEUED,
    3,
    redisKeys.backlogLane("queued"),
    redisKeys.backlogItems(),
    redisKeys.backlogLane("inProgress"),
    Date.now(),
    WIP_LIMIT,
  );

  if (!result) return { claimed: false, reason: "no-result" };

  // Check if it's a block response (JSON with "blocked" key)
  try {
    const parsed = JSON.parse(result);
    if (parsed.blocked) {
      return { claimed: false, reason: parsed.blocked, count: parsed.count };
    }

    // It's the raw item JSON — update lane metadata and save
    parsed.lane = "inProgress";
    parsed.meta = {
      ...parsed.meta,
      startedAt: new Date().toISOString().split("T")[0],
      claimedBy,
    };
    await saveItem(parsed);
    return { claimed: true, item: parsed };
  } catch {
    return { claimed: false, reason: "parse-error" };
  }
}

// ---------------------------------------------------------------------------
// Facade API — claim/complete/fail/block with built-in error handling + events
//
// These wrap the existing lane transitions so callers don't need safeKanban().
// Each function catches errors, logs with context, and publishes a notification
// event on failure. Returns { ok: boolean } so callers can branch without try/catch.
// ---------------------------------------------------------------------------

interface FacadeEventBus {
  publish(stream: string, message: Record<string, any>): Promise<void>;
}

let _facadeStreams: { NOTIFICATIONS: string } | null = null;

/** Lazy-load STREAMS to avoid circular import with event-bus.ts */
async function getFacadeStreams() {
  if (!_facadeStreams) {
    const { STREAMS } = await import("./event-bus.ts");
    _facadeStreams = { NOTIFICATIONS: STREAMS.NOTIFICATIONS };
  }
  return _facadeStreams;
}

async function publishFacadeFailure(
  eventBus: FacadeEventBus | null,
  cycleId: string,
  op: string,
  reference: string,
  error: string,
) {
  if (!eventBus) return;
  try {
    const streams = await getFacadeStreams();
    await eventBus.publish(streams.NOTIFICATIONS, {
      type: "kanban:update_failed",
      source: "backlog-facade",
      correlationId: cycleId,
      payload: { op, reference, error },
    });
  } catch (publishErr: any) {
    console.error(`[Backlog] Failed to publish kanban:update_failed for ${op}: ${publishErr.message}`);
  }
}

/**
 * Claim an anchor — move it to In Progress with built-in error handling.
 * Wraps moveToInProgress() with loud failure logging and event publishing.
 */
async function claim(
  reference: string,
  opts: { eventBus?: FacadeEventBus | null; cycleId?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await moveToInProgress(reference);
    return { ok: true };
  } catch (err: any) {
    console.error(`[Backlog] claim() failed for "${reference}": ${err.message}`);
    await publishFacadeFailure(opts.eventBus || null, opts.cycleId || "", "claim", reference, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Complete an anchor — move it to Done with built-in error handling.
 * Wraps moveToDone() with loud failure logging and event publishing.
 */
async function complete(
  reference: string,
  evidence: string,
  opts: { eventBus?: FacadeEventBus | null; cycleId?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await moveToDone(reference, evidence);
    return { ok: true };
  } catch (err: any) {
    console.error(`[Backlog] complete() failed for "${reference}": ${err.message}`);
    await publishFacadeFailure(opts.eventBus || null, opts.cycleId || "", "complete", reference, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Fail an anchor — return it to Backlog with built-in error handling.
 * Wraps returnToBacklog() with loud failure logging and event publishing.
 */
async function fail(
  reference: string,
  reason: string,
  opts: { eventBus?: FacadeEventBus | null; cycleId?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await returnToBacklog(reference, reason);
    return { ok: true };
  } catch (err: any) {
    console.error(`[Backlog] fail() failed for "${reference}": ${err.message}`);
    await publishFacadeFailure(opts.eventBus || null, opts.cycleId || "", "fail", reference, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Block an anchor — move it to Blocked with built-in error handling.
 * Wraps moveToBlocked() with loud failure logging and event publishing.
 */
async function block(
  reference: string,
  reason: string,
  opts: { eventBus?: FacadeEventBus | null; cycleId?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await moveToBlocked(reference, reason);
    return { ok: true };
  } catch (err: any) {
    console.error(`[Backlog] block() failed for "${reference}": ${err.message}`);
    await publishFacadeFailure(opts.eventBus || null, opts.cycleId || "", "block", reference, err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Public facade API — narrowed interface (issue #72)
// ---------------------------------------------------------------------------

/**
 * Get backlog status: lane counts + WIP state + milestone progress.
 * Replaces getBacklogCounts for external callers.
 */
async function getStatus() {
  const counts = await getBacklogCounts();
  const wip = await isWipLimitReached();
  const milestone = await getCurrentMilestoneProgress();
  return { counts, wip, milestone };
}

/**
 * Add an item to the backlog (deduplicating by title).
 * Thin wrapper over addToBacklog for the public API.
 * Returns { added: boolean, id?: string | number, reason?: string }.
 */
async function addItem(item: Record<string, any>): Promise<{ added: boolean; id?: string | number; reason?: string; matchedId?: any; similarity?: number }> {
  return addToBacklog(item);
}

/**
 * _admin namespace — internal operations exposed ONLY for the dashboard API
 * and orchestrator internals. Not part of the stable public contract.
 */
const _admin = {
  loadBacklog,
  getBacklogCounts,
  addToBacklog,
  promoteToQueued,
  moveToInProgress,
  moveToDone,
  moveToBlocked,
  blockItemById,
  returnToBacklog,
  pruneOldDoneItems,
  moveItemToLane,
  deleteItem,
  updateItem,
  getItemsByParent,
  peekNextQueuedItem,
  getInProgressCount,
  getInProgressItems,
  isWipLimitReached,
  requeueStaleInProgressItems,
  claimNextQueuedItem,
  closeBacklogRedis,
  getCurrentMilestoneProgress,
  WIP_LIMIT,
};

export {
  // Public facade — narrow contract (issue #72)
  getStatus,
  addItem,
  claim, complete, fail, block,
  // _admin for dashboard API + orchestrator internals
  _admin,
};
