// ---------------------------------------------------------------------------
// reportOutcome — unified post-cycle anchor bookkeeping (issue #69)
// ---------------------------------------------------------------------------

import {
  trackAbandonment,
  clearAbandonmentCounter,
  clearProcessingItem,
} from "./abandonment.ts";
import { storePriorFailure } from "./prior-failures.ts";

export interface OutcomeResult {
  status: "merged" | "failed" | "abandoned" | "skipped";
  reason?: string;
  verification?: any;
  task?: any;
  taskId?: string;
}

/**
 * Unified post-cycle anchor bookkeeping. Dispatches to the correct combination
 * of trackAbandonment, clearAbandonmentCounter, storePriorFailure, and
 * clearProcessingItem based on outcome status.
 *
 * - **merged**: clears abandonment counter + clears processing item
 * - **failed**: stores prior failure (with escalation logic) + clears processing item
 * - **abandoned**: tracks abandonment (circuit breaker) + clears processing item
 */
export async function reportOutcome(anchor: any, result: OutcomeResult): Promise<void> {
  const { status, reason, verification, task, taskId } = result;

  switch (status) {
    case "merged":
      await clearAbandonmentCounter(anchor.reference);
      await clearProcessingItem(anchor);
      break;

    case "failed": {
      // Pass prior retryCount from the anchor context so storePriorFailure
      // can accumulate correctly even though the item was already popped (issue #93).
      const priorRetryCount = anchor?.context?.retryCount || 0;
      await storePriorFailure(
        taskId ?? "unknown",
        reason ?? "Unknown failure",
        verification ?? null,
        priorRetryCount,
      );
      await clearProcessingItem(anchor);
      break;
    }

    case "abandoned":
      await trackAbandonment(
        anchor.reference,
        task ?? { title: anchor.reference, taskId: "none" },
        reason ?? "Unknown abandonment",
      );
      await clearProcessingItem(anchor);
      break;

    case "skipped":
      // Early-exit scenarios (no-work, skipped, usage-limit) — just clear processing
      await clearProcessingItem(anchor);
      break;
  }
}
