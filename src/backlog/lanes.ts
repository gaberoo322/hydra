/**
 * Backlog lane transitions — the state machine.
 *
 * Every public function in this file mutates lane membership through
 * applyLaneTransition() from ./internal.ts so the timing + claim metadata
 * invariants stay in one place.
 *
 * The write-commit step of a transition — {ZREM old-lane(s), HSET item, ZADD
 * new-lane} — goes through applyAtomicLaneTransition (issue #1990) so the three
 * ops run as a single atomic Lua step. A crash / Redis restart can no longer
 * observe a half-write where item.lane (hash, canonical) disagrees with zset
 * membership (the 166 "phantom done" items). The decision logic (find-by-title,
 * WIP cap, blocked-reason guard) stays in JS; only the commit is atomic. The
 * done lane keeps its NEGATED score (-now) so an ascending ZRANGE lists
 * most-recently-done first.
 */

import {
  removeFromBacklogLane, getBacklogLaneIds, getBacklogLaneCount,
  applyAtomicLaneTransition,
} from "../redis/backlog.ts";
import {
  LANES, DONE_RETENTION_DAYS, WIP_LIMIT,
  applyLaneTransition, getItem, removeItem, sortByQueuePriority,
  resolveItemIdByTitle,
} from "./internal.ts";
import { time } from "../metrics/instrumentation.ts";
import type { BacklogItem } from "./types.ts";

/** Score for a to-lane ZADD: done is negated (-now) so ascending ZRANGE lists most-recently-done first. */
function laneScore(lane: string, now: number): number {
  return lane === "done" ? -now : now;
}

/**
 * Move the top N backlog items to the Queued lane, sorted by priority.
 * Priority 1 (urgent) first, 0 (none/unset) last. Ties broken by score then age.
 */
export async function promoteToQueued(count = 1, now: number = Date.now()) {
  const ids = await getBacklogLaneIds("backlog");
  if (ids.length === 0) return [];

  const items: BacklogItem[] = [];
  for (const id of ids) {
    const item = await getItem(id);
    if (item) items.push(item);
  }
  sortByQueuePriority(items);

  const toPromote = items.slice(0, count);
  const moved = [];
  const dateOnly = new Date(now).toISOString().split("T")[0];

  for (const item of toPromote) {
    item.meta = { ...item.meta, queuedAt: dateOnly };
    applyLaneTransition(item, "queued", {}, now);
    await applyAtomicLaneTransition(String(item.id), JSON.stringify(item), ["backlog"], "queued", laneScore("queued", now));
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
  now: number = Date.now(),
): Promise<
  | boolean
  | { blocked: "wip-limit"; count: number; limit: number }
  | { ok: true; item: BacklogItem }
  | { ok: false; reason: "not-found" }
> {
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

  // Resolve the id via the by-title index (issue #2500), constrained to the same
  // source lanes the scan used so an item already in another lane is not pulled.
  const sourceLanes = ["queued", "backlog"];
  const id = await resolveItemIdByTitle(title, sourceLanes);
  if (id) {
    const item = await getItem(id);
    if (item && item.title === title && sourceLanes.includes(item.lane)) {
      const sourceLane = item.lane;
      item.meta = { ...item.meta, startedAt: new Date(now).toISOString().split("T")[0] };
      applyLaneTransition(item, "inProgress", { claimedBy }, now);
      await applyAtomicLaneTransition(id, JSON.stringify(item), [sourceLane], "inProgress", laneScore("inProgress", now));
      if (structured) return { ok: true, item };
      return true;
    }
  }
  if (structured) return { ok: false, reason: "not-found" };
  return false;
}

/**
 * Move an item to Done. Searches all non-done lanes so items in blocked
 * or queued can also be completed (e.g. merged while blocked).
 */
export async function moveToDone(title: string, outcome = "merged", now: number = Date.now()) {
  const sourceLanes = ["inProgress", "blocked", "queued", "backlog"];
  const id = await resolveItemIdByTitle(title, sourceLanes);
  if (id) {
    const item = await getItem(id);
    if (item && item.title === title && sourceLanes.includes(item.lane)) {
      const sourceLane = item.lane;
      item.checked = outcome === "merged";
      item.meta = {
        ...item.meta,
        completedAt: new Date(now).toISOString().split("T")[0],
        outcome,
      };
      applyLaneTransition(item, "done", {}, now);
      await applyAtomicLaneTransition(id, JSON.stringify(item), [sourceLane], "done", laneScore("done", now));
      return true;
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
export async function blockByTitle(title: string, reason: string, now: number = Date.now()) {
  const sourceLanes = ["inProgress", "queued", "backlog"];
  const id = await resolveItemIdByTitle(title, sourceLanes);
  if (id) {
    const item = await getItem(id);
    if (item && item.title === title && sourceLanes.includes(item.lane)) {
      const sourceLane = item.lane;
      item.meta = {
        ...item.meta,
        blockedAt: new Date(now).toISOString().split("T")[0],
        blockedReason: reason,
      };
      applyLaneTransition(item, "blocked", {}, now);
      await applyAtomicLaneTransition(id, JSON.stringify(item), [sourceLane], "blocked", laneScore("blocked", now));
      console.log(`[Backlog] Moved "${title}" to Blocked: ${reason}`);
      return true;
    }
  }
  return false;
}

/**
 * Remove a failed/abandoned item from In Progress back to Backlog.
 */
export async function returnToBacklog(title: string, reason: string, now: number = Date.now()) {
  const sourceLanes = ["inProgress"];
  const id = await resolveItemIdByTitle(title, sourceLanes);
  if (id) {
    const item = await getItem(id);
    if (item && item.title === title && sourceLanes.includes(item.lane)) {
      item.meta = {
        ...item.meta,
        returnedAt: new Date(now).toISOString().split("T")[0],
        returnReason: reason,
      };
      applyLaneTransition(item, "backlog", {}, now);
      await applyAtomicLaneTransition(id, JSON.stringify(item), ["inProgress"], "backlog", laneScore("backlog", now));
      return true;
    }
  }
  return false;
}

/**
 * Move an item between lanes by ID (for dashboard drag-and-drop).
 *
 * Schedulability invariant (issue #1920): a kanban item may only enter the
 * `blocked` lane if it carries a non-empty `meta.blockedReason` — either
 * pre-existing on the item or supplied via `opts.reason` on this move. An
 * unexplained blocked item is unschedulable and unactionable: the
 * housekeeping unblock-command generator, the queue/notification surfaces,
 * and the recently-unblocked anchor detector all key off `meta.blockedReason`
 * and degrade to "unknown" / "no reason" without it. Guarding here keeps the
 * invariant on the single id-based lane-mutation boundary; per the
 * CLAUDE.md backlog-lane-mutations rule the guard returns a
 * `{ ok: false, error: "missing-blocked-reason" }` result object and never
 * throws. Non-blocked transitions are entirely unaffected.
 */
export async function moveItemToLane(
  itemId: string | number,
  targetLane: string,
  opts: { claimedBy?: string | null; reason?: string | null } = {},
  now: number = Date.now(),
) {
  // Issue #2353: time the lane-transition hot path. `time()` is a transparent
  // no-op unless HYDRA_PERF_INSTRUMENT is set, so this never alters behaviour
  // or the returned result object.
  return time("backlog.moveItemToLane", () =>
    moveItemToLaneImpl(itemId, targetLane, opts, now),
  );
}

async function moveItemToLaneImpl(
  itemId: string | number,
  targetLane: string,
  opts: { claimedBy?: string | null; reason?: string | null } = {},
  now: number = Date.now(),
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

  // wire-or-retire lane guard (issue #2721): a triage-origin wire-or-retire
  // judgment item may NOT be laundered into the `backlog` lane (where no sweep
  // looks). It must leave triage only as a WIRE task, a RETIRE task
  // (triage->queued after the verdict rewrite), or ready-for-human
  // (triage->blocked). The prompt-shaped protocol in the emitter item body was
  // not a gate — item-685/687 slipped into backlog anyway — so enforce it here
  // at the id-based lane-mutation boundary. Scoped to the exact triple
  // (label 'wire-or-retire' AND source lane 'triage' AND target lane 'backlog')
  // so a wire-or-retire item legitimately in any other lane is never trapped,
  // and the backlog->triage migration direction stays open. The 'wire-or-retire'
  // label is stamped by scripts/ci/hydra-target-wire-or-retire-emit.ts
  // (WIRE_OR_RETIRE_LABEL); identify by label, never by title (Kanban pitfall).
  // Returns a result object and never throws (CLAUDE.md lane-mutation convention).
  if (
    targetLane === "backlog" &&
    item.lane === "triage" &&
    item.labels?.includes("wire-or-retire")
  ) {
    return {
      ok: false,
      error: "wire-or-retire items leave triage only as a WIRE task, a RETIRE task, or ready-for-human",
    };
  }

  // Schedulability guard: a blocked item must be explained (issue #1920).
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  if (targetLane === "blocked") {
    const existingReason = typeof item.meta?.blockedReason === "string"
      ? item.meta.blockedReason.trim()
      : "";
    if (!reason && !existingReason) {
      return { ok: false, error: "missing-blocked-reason" };
    }
  }

  // Stamp the blocked reason so the item is operator-actionable downstream.
  if (targetLane === "blocked" && reason) {
    item.meta = {
      ...item.meta,
      blockedAt: new Date(now).toISOString().split("T")[0],
      blockedReason: reason,
    };
  }

  applyLaneTransition(item, targetLane, { claimedBy: opts.claimedBy ?? null }, now);
  // Defensively ZREM every lane (the dashboard drag-and-drop boundary doesn't
  // track the source lane) before HSET + ZADD into the target — all atomic.
  await applyAtomicLaneTransition(String(itemId), JSON.stringify(item), LANES, targetLane, laneScore(targetLane, now));
  return { ok: true };
}

/**
 * Delete an item entirely.
 */
export async function deleteItem(itemId: string | number) {
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };
  await removeItem(itemId);
  return { ok: true };
}

/**
 * Prune done items older than DONE_RETENTION_DAYS.
 */
export async function pruneOldDoneItems(now: number = Date.now()) {
  const ids = await getBacklogLaneIds("done");
  const cutoff = now - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
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
