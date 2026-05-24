// ---------------------------------------------------------------------------
// Circuit breaker — track consecutive abandonments per anchor reference.
// ---------------------------------------------------------------------------
//
// After MAX_CONSECUTIVE_ABANDONMENTS, escalate to reframe queue so the
// planner gets a fresh diagnostic prompt instead of looping forever.
// Also handles clearing the per-cycle processing-queue marker.

import {
  listRem,
  listRPush,
  delKey,
  incrKey,
  expireKey,
} from "../redis-adapter.ts";
import { blockByTitle } from "../backlog/lanes.ts";
import {
  REFRAME_QUEUE,
  PROCESSING_QUEUE,
  ABANDONMENT_COUNTER_TTL,
  MAX_CONSECUTIVE_ABANDONMENTS,
  anchorKey,
} from "./constants.ts";

export async function trackAbandonment(
  anchorRef: string,
  task: any,
  reason: string,
): Promise<boolean> {
  const key = anchorKey(anchorRef);
  const count = await incrKey(key);
  await expireKey(key, ABANDONMENT_COUNTER_TTL);

  if (count >= MAX_CONSECUTIVE_ABANDONMENTS) {
    console.log(`[ControlLoop] Circuit breaker: anchor "${anchorRef}" abandoned ${count}x — escalating to reframe queue`);
    await listRPush(REFRAME_QUEUE, JSON.stringify({
      originalTaskId: task.taskId || "unknown",
      originalTitle: task.title || anchorRef,
      originalDescription: task.description || "",
      anchorType: task.anchorType || "unknown",
      anchorReference: task.anchorReference || anchorRef,
      scopeBoundary: task.scopeBoundary || null,
      totalAttempts: count,
      lastReason: reason,
      failedSteps: [],
      failureHistory: [],
      verificationStderr: "",
      escalatedAt: new Date().toISOString(),
      escalationSource: "abandonment-circuit-breaker",
    }));
    // Block the Kanban item so selectAnchor stops picking it.
    // Without this, peekNextQueuedItem() returns the same item every cycle
    // because it's a pure peek — the item stays in the queued lane.
    // Blocking it lets the reframe queue item (lower priority in selectAnchor)
    // get processed instead.
    //
    // blockByTitle returns false silently when no matching Kanban item exists
    // (e.g. work queue items, failing-test anchors). Inspect the return value
    // rather than wrapping in try/catch — the function does not throw for the
    // not-found case (see src/backlog/lanes.ts:blockByTitle).
    const blocked = await blockByTitle(
      anchorRef,
      `Circuit breaker: abandoned ${count}x — escalated to reframe queue`,
    );
    if (blocked) {
      console.log(`[ControlLoop] Blocked Kanban item "${anchorRef}" to unblock reframe processing`);
    } else {
      console.log(`[ControlLoop] No Kanban item to block for "${anchorRef}" (no match in inProgress/queued/backlog)`);
    }
    // Reset counter so the reframe gets one clean shot
    await delKey(key);
    return true; // escalated
  }
  return false; // not yet escalated
}

export async function clearAbandonmentCounter(anchorRef: string): Promise<void> {
  await delKey(anchorKey(anchorRef));
}

/**
 * Remove a work-queue item from the processing list after a cycle completes
 * (success, failure, or abandon). No-op if the anchor didn't come from the
 * work queue. Idempotent — safe to call multiple times.
 */
export async function clearProcessingItem(anchor: any): Promise<void> {
  if (anchor?._workQueueRaw) {
    try {
      await listRem(PROCESSING_QUEUE, 1, anchor._workQueueRaw);
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to clear processing queue item: ${err.message}`);
    }
  }
}
