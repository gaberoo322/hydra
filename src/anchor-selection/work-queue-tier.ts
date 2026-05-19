// ---------------------------------------------------------------------------
// Work-queue tier — items from POST /queue or research auto-queue
// ---------------------------------------------------------------------------
//
// Uses LMOVE to atomically move the item to a processing list so it can be
// recovered if the cycle crashes before completing. Drift-duplicate items
// are removed from the processing list and the tier falls through.
//
// NOT gated by WIP: research items should be consumed before falling to
// priorities doc. The Kanban queued tier is still WIP-gated since it
// represents heavier new-work intake.

import { listMove, listRem } from "../redis-adapter.ts";
import { WORK_QUEUE, PROCESSING_QUEUE } from "./constants.ts";
import { isAnchorDriftDuplicate } from "./drift-filter.ts";

export interface WorkQueueAnchor {
  type: "user-request" | "research";
  reference: string;
  whyNow: string;
  context: any;
  description: any;
  _workQueueRaw: string;
}

export async function selectWorkQueueAnchor(): Promise<WorkQueueAnchor | null> {
  const queued = await listMove(WORK_QUEUE, PROCESSING_QUEUE, "LEFT", "RIGHT");
  if (!queued) return null;

  try {
    const item = JSON.parse(queued);
    // Parse research context if present
    let parsedContext = item.context;
    if (typeof parsedContext === "string") {
      try { parsedContext = JSON.parse(parsedContext); } catch { /* intentional: context stays as string */ }
    }
    // Include description from backlog item context if available
    const description = typeof parsedContext === "object" ? parsedContext?.description : null;
    const contextWithDescription = description
      ? (typeof parsedContext === "object"
        ? { ...parsedContext, _description: description }
        : parsedContext)
      : parsedContext;

    const candidate: WorkQueueAnchor = {
      type: item.source === "research" ? "research" : "user-request",
      reference: item.reference || item.description,
      whyNow: `Queued by ${item.source === "research" ? "research system" : "operator"}: ${item.reason || "from work queue"}`,
      context: contextWithDescription,
      description,
      _workQueueRaw: queued,
    };
    // Drift pre-filter (issue #233) — drop near-duplicate work-queue items
    // before the planner runs. Item already moved to processing; remove it
    // there so it isn't recovered on next cycle.
    const driftResult = await isAnchorDriftDuplicate(candidate);
    if (driftResult.drift) {
      try {
        await listRem(PROCESSING_QUEUE, 1, queued);
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to drop drift-duplicate work-queue item: ${err.message}`);
      }
      return null;
    }
    return candidate;
  } catch (err: any) {
    console.error(`[ControlLoop] Corrupt work-queue item dropped: ${err.message} — data: ${queued.slice(0, 200)}`);
    // Remove corrupt item from processing queue — it cannot be recovered
    await listRem(PROCESSING_QUEUE, 1, queued);
    return null;
  }
}
