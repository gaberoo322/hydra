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
  setBacklogTitleIndex, clearBacklogTitleIndex, getBacklogItemIdByTitle,
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
  // Clear the by-title index FIRST (issue #2500) so a concurrent title lookup
  // can't resolve to an id that is about to vanish from the items hash. Read the
  // item to learn its title; if it's already gone the compare-and-delete is a
  // no-op. The clear is title-scoped + compare-and-delete (only removes the
  // entry if it still points at THIS id), so it can't orphan another live
  // item that has since taken the same title.
  const raw = await getBacklogItemRaw(id);
  if (raw) {
    try {
      const title = JSON.parse(raw)?.title;
      if (typeof title === "string") await clearBacklogTitleIndex(title, String(id));
    } catch (err: any) {
      // A malformed hash entry has no usable title — the reconciler will reap any
      // stale index entry FROM the hash on its next sweep. Log, don't abort the delete.
      console.error(`[Backlog] removeItem: could not parse ${id} to clear title-index: ${err.message}`);
    }
  }
  await removeBacklogItemAdapter(id, LANES);
}

/**
 * Resolve an itemId from a title (issue #2500). Tries the O(1) by-title index
 * first; on a miss, falls back to a bounded scan of `searchLanes` so items that
 * predate the index (or were written by a path that skipped index maintenance)
 * are still found — and back-fills the index for next time. Returns the id, or
 * null if no item with that exact title exists in any searched lane.
 *
 * The fallback verifies `item.title === title` exactly (case-sensitive), matching
 * the equality the scan loops used, and also re-verifies an index HIT before
 * trusting it — a stale index entry (title since changed, item since deleted)
 * degrades to the scan rather than mutating the wrong item.
 */
export async function resolveItemIdByTitle(
  title: string,
  searchLanes: string[],
): Promise<string | null> {
  const indexed = await getBacklogItemIdByTitle(title);
  if (indexed) {
    const item = await getItem(indexed);
    if (item && item.title === title) return String(indexed);
    // Stale hit — fall through to the authoritative scan below.
  }

  for (const lane of searchLanes) {
    const ids = await getBacklogLaneIds(lane);
    for (const id of ids) {
      const item = await getItem(id);
      if (item && item.title === title) {
        // Back-fill the index so the next lookup is O(1).
        try {
          await setBacklogTitleIndex(title, String(id));
        } catch (err: any) {
          console.error(`[Backlog] resolveItemIdByTitle: index back-fill failed for "${title}": ${err.message}`);
        }
        return String(id);
      }
    }
  }
  return null;
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
