/**
 * Backlog item lifecycle — creation (with fuzzy dedup) and field-level updates.
 */

import {
  addToBacklogLane,
  setBacklogTitleIndex, clearBacklogTitleIndex,
} from "../redis/backlog.ts";
import {
  LANES, applyLaneTransition, getItem, saveItem, nextId,
} from "./internal.ts";
import { loadBacklog } from "./reads.ts";
// `titleSimilarity` was extracted to the neutral merged-refs home (issue #2110)
// so the symmetric dedup helper sits beside the asymmetric `subjectCoveredBy`
// the reconciler uses; this dedup surface keeps the identical symmetric scoring.
import { titleSimilarity } from "./merged-refs.ts";

const FUZZY_DEDUP_THRESHOLD = 0.7; // 70% word overlap = duplicate

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
  // Maintain the by-title index (issue #2500). Exact-title dedup above guarantees
  // a 1:1 title→id mapping for items created through this path.
  await setBacklogTitleIndex(backlogItem.title, String(id));
  return { added: true, id };
}

/**
 * Update specific fields on an existing backlog item.
 */
export async function updateItem(itemId: any, updates: Record<string, any>) {
  const item = await getItem(itemId);
  if (!item) return { ok: false, error: "Item not found" };
  const ALLOWED = ["priority", "description", "labels", "estimate", "parentId", "title"];
  const oldTitle = item.title;
  for (const key of ALLOWED) {
    if (updates[key] !== undefined) item[key] = updates[key];
  }
  await saveItem(item);
  // Keep the by-title index consistent on a title change (issue #2500): retire
  // the old title's entry (compare-and-delete, so a re-used old title belonging
  // to another item survives) and point the new title at this id.
  if (typeof item.title === "string" && item.title !== oldTitle) {
    if (typeof oldTitle === "string") await clearBacklogTitleIndex(oldTitle, String(itemId));
    await setBacklogTitleIndex(item.title, String(itemId));
  }
  return { ok: true, item };
}
