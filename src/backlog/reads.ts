/**
 * Backlog reads — non-mutating queries the dashboard and scheduler consume.
 */

import { getBacklogLaneCount } from "../redis/backlog.ts";
import { LANES, getLaneItems, sortByQueuePriority } from "./internal.ts";

/**
 * The full set of Kanban lanes loadBacklog() returns, keyed by lane name.
 *
 * The shape is fully determined by the `LANES` const in ./internal.ts; naming
 * each lane explicitly lets callers (e.g. api/queue.ts) reach `backlog.triage`
 * without an `as any` cast, and turns a renamed lane into a compile error
 * instead of a silent `undefined`. The trailing `[lane: string]: Item[]` index
 * signature preserves the historical string-indexed access pattern
 * (`lanes[lane]` while iterating `LANES`) used by addToBacklog/getItemsByParent.
 *
 * Items themselves stay `Item` (an alias for the module's untyped item shape) —
 * narrowing the item record is out of scope here; this issue only tightens the
 * lane-key layer that forced the casts.
 */
export type Item = any;

export type Backlog = {
  triage: Item[];
  backlog: Item[];
  queued: Item[];
  blocked: Item[];
  inProgress: Item[];
  done: Item[];
  [lane: string]: Item[];
};

/**
 * Load all lanes — same return shape as the historical markdown parser.
 */
export async function loadBacklog(): Promise<Backlog> {
  const lanes: Backlog = {
    triage: await getLaneItems("triage"),
    backlog: await getLaneItems("backlog"),
    queued: await getLaneItems("queued"),
    blocked: await getLaneItems("blocked"),
    inProgress: await getLaneItems("inProgress"),
    done: await getLaneItems("done"),
  };
  return lanes;
}

/**
 * Lane-depth counts for monitoring.
 */
export async function getBacklogCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const lane of LANES) {
    counts[lane] = await getBacklogLaneCount(lane);
  }
  counts.total = (counts.triage || 0) + counts.backlog + counts.queued;
  return counts;
}

/**
 * Return all items with the given parentId across all lanes.
 */
export async function getItemsByParent(parentId: any) {
  const lanes = await loadBacklog();
  const children: any[] = [];
  for (const lane of LANES) {
    for (const item of lanes[lane]) {
      if (item.parentId === parentId) children.push(item);
    }
  }
  return children;
}

/**
 * Return the highest-priority item from the queued lane without removing it.
 */
export async function peekNextQueuedItem() {
  const items = await getLaneItems("queued");
  if (items.length === 0) return null;
  sortByQueuePriority(items);
  return items[0];
}
