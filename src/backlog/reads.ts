/**
 * Backlog reads — non-mutating queries the dashboard and scheduler consume.
 */

import { getBacklogLaneCount } from "../redis/backlog.ts";
import { LANES, getLaneItems, sortByQueuePriority } from "./internal.ts";

/**
 * Load all lanes — same return shape as the historical markdown parser.
 */
export async function loadBacklog(): Promise<Record<string, any[]>> {
  const lanes: Record<string, any[]> = {};
  for (const lane of LANES) {
    lanes[lane] = await getLaneItems(lane);
  }
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
