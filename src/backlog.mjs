/**
 * Backlog Manager
 *
 * Maintains a Kanban-formatted markdown file in the Obsidian vault.
 * Compatible with the Obsidian Kanban plugin.
 *
 * Lanes: Backlog → Queued → In Progress → Done
 *
 * Research populates Backlog.
 * Scheduler moves items from Backlog → Queued (and into Redis work queue).
 * Control loop moves Queued → In Progress → Done.
 * Done items are pruned after 7 days.
 *
 * File: {HYDRA_PATH}/backlog.md
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const BACKLOG_FILE = join(HYDRA_PATH, "backlog.md");
const DONE_RETENTION_DAYS = 7;

/**
 * Parse the backlog file into structured lanes.
 */
async function loadBacklog() {
  let raw;
  try {
    raw = await readFile(BACKLOG_FILE, "utf-8");
  } catch {
    return { backlog: [], queued: [], inProgress: [], done: [] };
  }

  const lanes = { backlog: [], queued: [], inProgress: [], done: [] };
  let currentLane = null;

  for (const line of raw.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      const h = heading[1].toLowerCase();
      if (h.startsWith("backlog")) currentLane = "backlog";
      else if (h.startsWith("queued")) currentLane = "queued";
      else if (h.startsWith("in progress")) currentLane = "inProgress";
      else if (h.startsWith("done")) currentLane = "done";
      else currentLane = null;
      continue;
    }

    if (!currentLane) continue;

    // Parse kanban items: "- [ ] Title #tag @date" or "- [x] Title #tag @date"
    const itemMatch = line.match(/^- \[([ x])\]\s+(.+)/);
    if (itemMatch) {
      const checked = itemMatch[1] === "x";
      const content = itemMatch[2];

      // Extract tags (#reliability, #architecture, etc.)
      const tags = [];
      const tagMatches = content.matchAll(/#(\w+)/g);
      for (const m of tagMatches) tags.push(m[1]);

      // Extract metadata from trailing <!-- JSON -->
      let meta = {};
      const metaMatch = content.match(/<!--\s*({.*?})\s*-->/);
      if (metaMatch) {
        try { meta = JSON.parse(metaMatch[1]); } catch {}
      }

      // Clean title (remove tags and metadata comment)
      const title = content
        .replace(/<!--.*?-->/g, "")
        .replace(/#\w+/g, "")
        .trim();

      lanes[currentLane].push({ title, checked, tags, meta, raw: content });
    }
  }

  return lanes;
}

/**
 * Write the backlog back to the vault as a Kanban-compatible markdown file.
 */
async function saveBacklog(lanes) {
  await mkdir(HYDRA_PATH, { recursive: true });

  const lines = [
    "---",
    "kanban-plugin: basic",
    "---",
    "",
  ];

  function writeItem(item) {
    const check = item.checked ? "x" : " ";
    const tags = item.tags?.length > 0 ? " " + item.tags.map(t => `#${t}`).join(" ") : "";
    const meta = item.meta && Object.keys(item.meta).length > 0
      ? ` <!-- ${JSON.stringify(item.meta)} -->`
      : "";
    return `- [${check}] ${item.title}${tags}${meta}`;
  }

  lines.push("## Backlog");
  if (lanes.backlog.length === 0) lines.push("*No items — run research or update priorities*");
  for (const item of lanes.backlog) lines.push(writeItem(item));
  lines.push("");

  lines.push("## Queued (next up)");
  if (lanes.queued.length === 0) lines.push("*Empty — backlog items will be queued automatically*");
  for (const item of lanes.queued) lines.push(writeItem(item));
  lines.push("");

  lines.push("## In Progress");
  if (lanes.inProgress.length === 0) lines.push("*No active cycle*");
  for (const item of lanes.inProgress) lines.push(writeItem(item));
  lines.push("");

  lines.push("## Done (last 7 days)");
  for (const item of lanes.done) lines.push(writeItem(item));
  if (lanes.done.length === 0) lines.push("*Nothing completed yet*");
  lines.push("");

  await writeFile(BACKLOG_FILE, lines.join("\n"));
}

/**
 * Add an item to the backlog lane.
 * Called by research-loop when opportunities are identified.
 */
export async function addToBacklog(item) {
  const lanes = await loadBacklog();

  // Dedup: don't add if title already exists in any lane
  const allTitles = new Set([
    ...lanes.backlog.map(i => i.title),
    ...lanes.queued.map(i => i.title),
    ...lanes.inProgress.map(i => i.title),
    ...lanes.done.map(i => i.title),
  ]);
  if (allTitles.has(item.title)) return { added: false, reason: "duplicate" };

  lanes.backlog.push({
    title: item.title,
    checked: false,
    tags: [item.category || "uncategorized"].filter(Boolean),
    meta: {
      source: item.source || "research",
      score: item.adjustedScore,
      confidence: item.confidence,
      complexity: item.complexity,
      addedAt: new Date().toISOString().split("T")[0],
    },
  });

  await saveBacklog(lanes);
  return { added: true };
}

/**
 * Move the top N backlog items to the Queued lane.
 * Returns the items that were moved.
 */
export async function promoteToQueued(count = 1) {
  const lanes = await loadBacklog();
  const moved = [];

  for (let i = 0; i < count && lanes.backlog.length > 0; i++) {
    const item = lanes.backlog.shift();
    item.meta = { ...item.meta, queuedAt: new Date().toISOString().split("T")[0] };
    lanes.queued.push(item);
    moved.push(item);
  }

  if (moved.length > 0) await saveBacklog(lanes);
  return moved;
}

/**
 * Move a queued item to In Progress.
 * Called by control-loop when a cycle starts working on a queued item.
 */
export async function moveToInProgress(title) {
  const lanes = await loadBacklog();
  const idx = lanes.queued.findIndex(i => i.title === title);

  if (idx === -1) {
    // Try finding in backlog (direct queue bypass)
    const bIdx = lanes.backlog.findIndex(i => i.title === title);
    if (bIdx !== -1) {
      const item = lanes.backlog.splice(bIdx, 1)[0];
      item.meta = { ...item.meta, startedAt: new Date().toISOString().split("T")[0] };
      lanes.inProgress.push(item);
      await saveBacklog(lanes);
      return true;
    }
    return false;
  }

  const item = lanes.queued.splice(idx, 1)[0];
  item.meta = { ...item.meta, startedAt: new Date().toISOString().split("T")[0] };
  lanes.inProgress.push(item);
  await saveBacklog(lanes);
  return true;
}

/**
 * Move an in-progress item to Done.
 * Called by control-loop when a cycle completes.
 */
export async function moveToDone(title, outcome = "merged") {
  const lanes = await loadBacklog();
  const idx = lanes.inProgress.findIndex(i => i.title === title);

  if (idx === -1) return false;

  const item = lanes.inProgress.splice(idx, 1)[0];
  item.checked = outcome === "merged";
  item.meta = {
    ...item.meta,
    completedAt: new Date().toISOString().split("T")[0],
    outcome,
  };
  lanes.done.unshift(item); // Most recent first

  await saveBacklog(lanes);
  return true;
}

/**
 * Remove a failed/abandoned item from In Progress back to Backlog.
 */
export async function returnToBacklog(title, reason) {
  const lanes = await loadBacklog();
  const idx = lanes.inProgress.findIndex(i => i.title === title);

  if (idx === -1) return false;

  const item = lanes.inProgress.splice(idx, 1)[0];
  item.meta = { ...item.meta, returnedAt: new Date().toISOString().split("T")[0], returnReason: reason };
  lanes.backlog.push(item);

  await saveBacklog(lanes);
  return true;
}

/**
 * Get backlog depth counts for monitoring.
 */
export async function getBacklogCounts() {
  const lanes = await loadBacklog();
  return {
    backlog: lanes.backlog.length,
    queued: lanes.queued.length,
    inProgress: lanes.inProgress.length,
    done: lanes.done.length,
    total: lanes.backlog.length + lanes.queued.length,
  };
}

/**
 * Prune done items older than DONE_RETENTION_DAYS.
 */
export async function pruneOldDoneItems() {
  const lanes = await loadBacklog();
  const cutoff = Date.now() - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const before = lanes.done.length;

  lanes.done = lanes.done.filter(item => {
    const completedAt = item.meta?.completedAt;
    if (!completedAt) return true;
    return new Date(completedAt).getTime() > cutoff;
  });

  if (lanes.done.length < before) {
    await saveBacklog(lanes);
    console.log(`[Backlog] Pruned ${before - lanes.done.length} done items older than ${DONE_RETENTION_DAYS} days`);
  }
}

export { loadBacklog, saveBacklog, BACKLOG_FILE };
