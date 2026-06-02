/**
 * Backlog item lifecycle — creation (with fuzzy dedup) and field-level updates.
 */

import { addToBacklogLane } from "../redis/backlog.ts";
import {
  LANES, applyLaneTransition, getItem, saveItem, nextId,
} from "./internal.ts";
import { loadBacklog } from "./reads.ts";

const FUZZY_DEDUP_THRESHOLD = 0.7; // 70% word overlap = duplicate

function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  // Need at least 4 significant words in each title for fuzzy matching to be reliable
  if (wordsA.size < 4 || wordsB.size < 4) return 0;
  const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/**
 * Add a new item to the backlog with title-based dedup (exact + fuzzy).
 * Called by the dashboard's POST /backlog endpoint and the work-queue API.
 */
export async function addToBacklog(item: any): Promise<{
  added: boolean;
  id?: string | number;
  reason?: string;
  matchedId?: any;
  similarity?: number;
}> {
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
  const backlogItem: any = {
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
    movedAt: null,
    claimedAt: null,
    claimedBy: null,
  };

  // Record the initial lane assignment as a transition so movedAt is always set.
  applyLaneTransition(backlogItem, targetLane, { claimedBy: item.claimedBy ?? null });
  await saveItem(backlogItem);
  await addToBacklogLane(targetLane, Date.now(), id);
  return { added: true, id };
}

/**
 * Update specific fields on an existing backlog item.
 */
export async function updateItem(itemId: any, updates: Record<string, any>) {
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };
  const ALLOWED = ["priority", "description", "labels", "estimate", "parentId", "title"];
  for (const key of ALLOWED) {
    if (updates[key] !== undefined) item[key] = updates[key];
  }
  await saveItem(item);
  return { ok: true, item };
}
