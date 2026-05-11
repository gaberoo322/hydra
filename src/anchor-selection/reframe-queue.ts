// ---------------------------------------------------------------------------
// Reframe queue maintenance — prevent unbounded accumulation (issue #57)
// ---------------------------------------------------------------------------

import {
  listRange,
  listRPush,
  listLen,
  delKey,
} from "../redis-adapter.ts";
import {
  REFRAME_QUEUE,
  REFRAME_QUEUE_CAP,
  REFRAME_QUEUE_MAX_AGE_MS,
} from "./constants.ts";

/**
 * Prune stale items (older than 7 days) from the reframe queue and enforce
 * a hard cap of REFRAME_QUEUE_CAP. Oldest items beyond the cap are dropped
 * with a log entry. Called from selectAnchor() before consuming a reframe item.
 *
 * Returns { pruned: number, dropped: number }.
 */
export async function pruneReframeQueue(): Promise<{ pruned: number; dropped: number }> {
  let pruned = 0;
  let dropped = 0;

  try {
    const all = await listRange(REFRAME_QUEUE, 0, -1);
    if (all.length === 0) return { pruned, dropped };

    const now = Date.now();
    const kept: string[] = [];

    // Pass 1: filter out items older than 7 days
    for (const raw of all) {
      try {
        const item = JSON.parse(raw);
        const escalatedAt = item.escalatedAt ? new Date(item.escalatedAt).getTime() : 0;
        if (escalatedAt > 0 && now - escalatedAt > REFRAME_QUEUE_MAX_AGE_MS) {
          pruned++;
          console.log(`[ControlLoop] Reframe queue: pruned stale item "${item.originalTitle || item.originalTaskId}" (age: ${Math.round((now - escalatedAt) / 86400000)}d)`);
          continue;
        }
      } catch (err: any) {
        // Corrupt item — drop it
        pruned++;
        console.error(`[ControlLoop] Reframe queue: dropped corrupt item: ${err.message}`);
        continue;
      }
      kept.push(raw);
    }

    // Pass 2: enforce hard cap — drop oldest items beyond cap
    if (kept.length > REFRAME_QUEUE_CAP) {
      const overflow = kept.length - REFRAME_QUEUE_CAP;
      for (let i = 0; i < overflow; i++) {
        try {
          const item = JSON.parse(kept[i]);
          console.log(`[ControlLoop] Reframe queue: dropped overflow item "${item.originalTitle || item.originalTaskId}" (queue: ${kept.length}/${REFRAME_QUEUE_CAP})`);
        } catch {
          console.log(`[ControlLoop] Reframe queue: dropped overflow item (unparseable)`);
        }
        dropped++;
      }
      kept.splice(0, overflow);
    }

    // Only rewrite the list if something changed
    if (pruned > 0 || dropped > 0) {
      await delKey(REFRAME_QUEUE);
      if (kept.length > 0) {
        await listRPush(REFRAME_QUEUE, ...kept);
      }
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Reframe queue pruning failed: ${err.message}`);
  }

  return { pruned, dropped };
}

/**
 * Get the current length of the reframe queue.
 * Used by the scheduler for interleaving logic (issue #57).
 */
export async function getReframeQueueLen(): Promise<number> {
  return listLen(REFRAME_QUEUE);
}
