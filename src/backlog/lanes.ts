/**
 * Backlog lane transitions — the state machine.
 *
 * Every public function in this file mutates lane membership through
 * applyLaneTransition() from ./internal.ts so the timing + claim metadata
 * invariants stay in one place.
 */

import {
  addToBacklogLane, removeFromBacklogLane, getBacklogLaneIds, getBacklogLaneCount,
} from "../redis/backlog.ts";
import {
  LANES, DONE_RETENTION_DAYS, WIP_LIMIT,
  applyLaneTransition, getItem, saveItem, removeItem, sortByQueuePriority,
} from "./internal.ts";

/**
 * Move the top N backlog items to the Queued lane, sorted by priority.
 * Priority 1 (urgent) first, 0 (none/unset) last. Ties broken by score then age.
 */
export async function promoteToQueued(count = 1) {
  const ids = await getBacklogLaneIds("backlog");
  if (ids.length === 0) return [];

  const items: any[] = [];
  for (const id of ids) {
    const item = await getItem(id);
    if (item) items.push(item);
  }
  sortByQueuePriority(items);

  const toPromote = items.slice(0, count);
  const moved = [];

  for (const item of toPromote) {
    await removeFromBacklogLane("backlog", item.id);
    item.meta = { ...item.meta, queuedAt: new Date().toISOString().split("T")[0] };
    applyLaneTransition(item, "queued");
    await saveItem(item);
    await addToBacklogLane("queued", Date.now(), item.id);
    moved.push(item);
  }

  return moved;
}

/**
 * Move a queued item to In Progress by title.
 *
 * Enforces the WIP cap: if the inProgress lane already holds WIP_LIMIT items,
 * this returns `{ blocked: "wip-limit", count }` instead of moving the item.
 * For backward compatibility, callers that pass no opts still receive a plain
 * boolean (true = moved, false = not found). When opts.claimedBy is provided
 * the result is the structured object so callers can distinguish "not found"
 * from "blocked by WIP cap".
 */
export async function moveToInProgress(
  title: string,
  opts: { claimedBy?: string | null } | string | null = null,
): Promise<any> {
  const structured = opts !== null && opts !== undefined;
  const claimedBy = typeof opts === "string"
    ? opts
    : (opts && typeof opts === "object" ? (opts.claimedBy ?? null) : null);

  const wipCount = await getBacklogLaneCount("inProgress");
  if (wipCount >= WIP_LIMIT) {
    console.warn(`[Backlog] moveToInProgress refused for "${title}": WIP cap ${WIP_LIMIT} reached (count=${wipCount})`);
    if (structured) return { blocked: "wip-limit", count: wipCount, limit: WIP_LIMIT };
    return false;
  }

  for (const sourceLane of ["queued", "backlog"]) {
    const ids = await getBacklogLaneIds(sourceLane);
    for (const id of ids) {
      const item = await getItem(id);
      if (item && item.title === title) {
        await removeFromBacklogLane(sourceLane, id);
        item.meta = { ...item.meta, startedAt: new Date().toISOString().split("T")[0] };
        applyLaneTransition(item, "inProgress", { claimedBy });
        await saveItem(item);
        await addToBacklogLane("inProgress", Date.now(), id);
        if (structured) return { ok: true, item };
        return true;
      }
    }
  }
  if (structured) return { ok: false, reason: "not-found" };
  return false;
}

/**
 * Move an item to Done. Searches all non-done lanes so items in blocked
 * or queued can also be completed (e.g. merged while blocked).
 */
export async function moveToDone(title: string, outcome = "merged") {
  for (const sourceLane of ["inProgress", "blocked", "queued", "backlog"]) {
    const ids = await getBacklogLaneIds(sourceLane);
    for (const id of ids) {
      const item = await getItem(id);
      if (item && item.title === title) {
        await removeFromBacklogLane(sourceLane, id);
        item.checked = outcome === "merged";
        item.meta = {
          ...item.meta,
          completedAt: new Date().toISOString().split("T")[0],
          outcome,
        };
        applyLaneTransition(item, "done");
        await saveItem(item);
        await addToBacklogLane("done", -Date.now(), id);
        return true;
      }
    }
  }
  console.warn(`[Backlog] moveToDone: item "${title}" not found in any lane`);
  return false;
}

/**
 * Block an item by exact title match. Searches [inProgress, queued, backlog].
 *
 * Returns `false` silently when no matching item exists in those lanes —
 * callers that want to distinguish "not found" from "moved" should inspect
 * the return value rather than wrapping the call in a try/catch (the function
 * does not throw for not-found).
 */
export async function blockByTitle(title: string, reason: string) {
  for (const sourceLane of ["inProgress", "queued", "backlog"]) {
    const ids = await getBacklogLaneIds(sourceLane);
    for (const id of ids) {
      const item = await getItem(id);
      if (item && item.title === title) {
        await removeFromBacklogLane(sourceLane, id);
        item.meta = {
          ...item.meta,
          blockedAt: new Date().toISOString().split("T")[0],
          blockedReason: reason,
        };
        applyLaneTransition(item, "blocked");
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
export async function returnToBacklog(title: string, reason: string) {
  const ids = await getBacklogLaneIds("inProgress");

  for (const id of ids) {
    const item = await getItem(id);
    if (item && item.title === title) {
      await removeFromBacklogLane("inProgress", id);
      item.meta = {
        ...item.meta,
        returnedAt: new Date().toISOString().split("T")[0],
        returnReason: reason,
      };
      applyLaneTransition(item, "backlog");
      await saveItem(item);
      await addToBacklogLane("backlog", Date.now(), id);
      return true;
    }
  }
  return false;
}

/**
 * Move an item between lanes by ID (for dashboard drag-and-drop).
 */
export async function moveItemToLane(
  itemId: any,
  targetLane: string,
  opts: { claimedBy?: string | null } = {},
) {
  if (!LANES.includes(targetLane)) return { ok: false, error: `Invalid lane: ${targetLane}` };
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };

  if (targetLane === "inProgress" && item.lane !== "inProgress") {
    const wipCount = await getBacklogLaneCount("inProgress");
    if (wipCount >= WIP_LIMIT) {
      return { ok: false, error: "wip-limit", count: wipCount, limit: WIP_LIMIT };
    }
  }

  for (const lane of LANES) {
    await removeFromBacklogLane(lane, itemId);
  }

  applyLaneTransition(item, targetLane, { claimedBy: opts.claimedBy ?? null });
  await saveItem(item);
  const score = targetLane === "done" ? -Date.now() : Date.now();
  await addToBacklogLane(targetLane, score, itemId);
  return { ok: true };
}

/**
 * Delete an item entirely.
 */
export async function deleteItem(itemId: any) {
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };
  await removeItem(itemId);
  return { ok: true };
}

/**
 * Prune done items older than DONE_RETENTION_DAYS.
 */
export async function pruneOldDoneItems() {
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
