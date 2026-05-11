// ---------------------------------------------------------------------------
// Prior-failures tier — scan queue, return next retryable item or null
// ---------------------------------------------------------------------------
//
// First escalates stale items (age-limit + retry-cap) so the queue can't
// accumulate unbounded, then scans for the first retryable entry. Orphan
// entries whose task hash has expired are silently pruned (issue #188).

import { listRange, listRPush, listRem, keyExists } from "../redis-adapter.ts";
import {
  REFRAME_QUEUE,
  PRIOR_FAILURES_KEY,
  MAX_PRIOR_FAILURE_RETRIES,
  taskKey,
} from "./constants.ts";
import { escalateStalePriorFailures } from "./prior-failures.ts";

export interface PriorFailureAnchor {
  type: "prior-failure";
  reference: string;
  whyNow: string;
  context: any;
}

/**
 * Return the next retryable prior-failure anchor, or null if none remain.
 * Side-effects: escalates stale/over-cap items to the reframe queue, prunes
 * orphan entries.
 */
export async function selectPriorFailureAnchor(): Promise<PriorFailureAnchor | null> {
  // First, escalate any stale items so the queue doesn't accumulate unbounded.
  try {
    const escalatedCount = await escalateStalePriorFailures();
    if (escalatedCount > 0) {
      console.log(`[ControlLoop] Escalated ${escalatedCount} stale prior-failure(s) to reframe queue`);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Prior-failure age escalation failed: ${err.message}`);
  }

  // Scan prior-failure queue, skipping items that have exceeded the retry cap (issue #93).
  // Items with retryCount >= MAX_PRIOR_FAILURE_RETRIES are escalated to reframe immediately
  // instead of burning another cycle.
  // Items whose task hash has expired are pruned silently (issue #188).
  const allPriorFailures = await listRange(PRIOR_FAILURES_KEY, 0, -1);
  for (const raw of allPriorFailures) {
    try {
      const failure = JSON.parse(raw);

      // Prune orphan entries whose task hash has expired from Redis (issue #188).
      // Prior-failure entries have no TTL but task hashes expire after 7 days.
      // Without title/description context the planner can't act on these, so
      // check the self-contained fields first, then fall back to the task hash.
      const hasContext = !!(failure.title && failure.description);
      if (!hasContext) {
        const taskExists = await keyExists(taskKey(failure.taskId));
        if (!taskExists) {
          await listRem(PRIOR_FAILURES_KEY, 1, raw);
          console.log(`[ControlLoop] Pruned orphan prior-failure "${failure.taskId}" — task hash expired, no embedded context`);
          continue;
        }
      }

      if ((failure.retryCount || 0) >= MAX_PRIOR_FAILURE_RETRIES) {
        // Exceeded retry cap — escalate to reframe, don't retry
        await listRem(PRIOR_FAILURES_KEY, 1, raw);
        await listRPush(REFRAME_QUEUE, JSON.stringify({
          originalTaskId: failure.taskId,
          originalTitle: failure.title || failure.taskId,
          originalDescription: failure.description || "",
          anchorType: "prior-failure",
          anchorReference: failure.taskId,
          scopeBoundary: null,
          totalAttempts: failure.retryCount || 1,
          lastReason: failure.reason,
          failedSteps: failure.failedSteps || [],
          failureHistory: [],
          verificationStderr: "",
          escalatedAt: new Date().toISOString(),
          escalationSource: "prior-failure-retry-cap",
          escalationReason: `Auto-escalated: retryCount ${failure.retryCount} >= cap ${MAX_PRIOR_FAILURE_RETRIES}`,
        }));
        console.log(`[ControlLoop] Prior-failure "${failure.taskId}" escalated to reframe (retryCount ${failure.retryCount} >= cap ${MAX_PRIOR_FAILURE_RETRIES})`);
        continue;
      }
      // Found a retryable item — pop it and return as anchor
      await listRem(PRIOR_FAILURES_KEY, 1, raw);
      return {
        type: "prior-failure",
        reference: failure.taskId,
        whyNow: `Prior task ${failure.taskId} failed: ${failure.reason || "unknown"} (retry ${(failure.retryCount || 0) + 1}/${MAX_PRIOR_FAILURE_RETRIES})`,
        context: failure,
      };
    } catch (err: any) {
      console.error(`[ControlLoop] Corrupt prior-failure in queue: ${err.message}. Removing.`);
      await listRem(PRIOR_FAILURES_KEY, 1, raw);
    }
  }

  return null;
}
