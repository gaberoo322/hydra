/**
 * Backlog Module — private helpers shared across the role files.
 *
 * Lanes: triage → backlog → queued → blocked → inProgress → done
 *
 * Nothing in this file is exported outside src/backlog/. Callers reach the
 * Module through the role-keyed surface files (reads/items/lanes/claims/wip/
 * reaper).
 *
 * Redis schema (informational — actual access goes through src/redis/backlog.ts):
 *   hydra:backlog:items         → Hash: itemId → JSON item
 *   hydra:backlog:lane:{lane}   → Sorted Set: itemId scored by position timestamp
 *   hydra:backlog:counter       → Auto-increment ID counter
 */

import {
  getBacklogItemRaw, saveBacklogItem, removeBacklogItem as removeBacklogItemAdapter,
  getBacklogLaneIds,
  incrBacklogCounter,
} from "../redis/backlog.ts";

export const LANES = ["triage", "backlog", "queued", "blocked", "inProgress", "done"];
export const DONE_RETENTION_DAYS = 7;
export const WIP_LIMIT = parseInt(process.env.HYDRA_WIP_LIMIT) || 3;

/**
 * Apply a lane transition to an item in-place, recording timing metadata.
 *
 * Every transition writes `movedAt` (ISO timestamp). Transitions into the
 * `inProgress` lane additionally write `claimedAt` + `claimedBy` so stalled
 * items can be detected by both API consumers and the WIP enforcement code.
 * Transitions OUT of `inProgress` clear the claim fields so a stale
 * `claimedBy` from an earlier cycle doesn't confuse downstream code.
 *
 * Mutates `item` and returns the timestamp written. Callers persist via
 * saveItem().
 *
 * `now` is an optional trailing clock seam (ms since epoch, default
 * `Date.now()`) mirroring the backlog-module idiom in stale-escalation.ts
 * (`itemAgeMs(item, now)`) and candidate-eligibility.ts (`isInFlightPR(item,
 * now)`): tests pin a fixed instant to assert exact movedAt/claimedAt without
 * clock tolerance. Callers that omit it get `new Date().toISOString()` exactly
 * as before — purely extending, never breaking.
 */
export function applyLaneTransition(
  item: any,
  targetLane: string,
  opts: { claimedBy?: string | null } = {},
  now: number = Date.now(),
): { movedAt: string } {
  const movedAt = new Date(now).toISOString();
  item.lane = targetLane;
  item.movedAt = movedAt;
  if (targetLane === "inProgress") {
    item.claimedAt = movedAt;
    item.claimedBy = opts.claimedBy ?? item.claimedBy ?? null;
  } else {
    item.claimedAt = null;
    item.claimedBy = null;
  }
  return { movedAt };
}

export async function nextId() {
  return incrBacklogCounter();
}

export async function getItem(id: any) {
  const raw = await getBacklogItemRaw(id);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function saveItem(item: any) {
  await saveBacklogItem(item.id, JSON.stringify(item));
}

export async function removeItem(id: any) {
  await removeBacklogItemAdapter(id, LANES);
}

export async function getLaneItems(lane: string) {
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
 * Sort queued-lane items by the canonical priority order: priority 1 (urgent)
 * first, 0 (none/unset) last, ties broken by score then age. Shared by
 * promoteToQueued() and peekNextQueuedItem() so the two stay in lock-step.
 */
export function sortByQueuePriority<T extends { priority?: number; meta?: any }>(items: T[]): T[] {
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
  return items;
}
