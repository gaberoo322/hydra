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

/**
 * Parse the active milestone from roadmap.md and return progress.
 */
export async function getCurrentMilestoneProgress() {
  const { readFile } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");
  const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
  try {
    const roadmap = await readFile(join(CONFIG_PATH, "direction", "roadmap.md"), "utf-8");
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
  } catch (err: any) {
    // A missing roadmap.md is the legitimate "no active milestone yet" path —
    // stay quiet. Anything else (parse/permission/etc.) is a real fault that
    // must not be swallowed silently (CLAUDE.md fail-loud; issue #1122).
    if (err?.code !== "ENOENT") {
      console.error("[backlog/reads] getCurrentMilestoneProgress failed reading roadmap.md", err);
    }
    return null;
  }
}
