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

import {
  claimNextWorkQueueItem,
  removeFromProcessingQueue,
} from "../redis/anchors.ts";
import { isAnchorDriftDuplicate } from "./drift-filter.ts";

export interface WorkQueueAnchor {
  type: "user-request" | "research";
  reference: string;
  whyNow: string;
  context: any;
  description: any;
  _workQueueRaw: string;
}

/**
 * Allowlist of `source` values that may produce an anchor (issue #449).
 *
 * Pre-cutover the orchestrator's in-process Codex agents (`code-reviewer`,
 * `adversarial-validation`) enqueued findings here. Those agents were
 * deleted with PR #383 / issues #343–#344, but no migration drained their
 * residual items, so 20 of 31 work-queue entries on 2026-05-15 were
 * orphan-source items being mis-mapped to `user-request` anchors. The
 * operator manually drained the historical items on 2026-05-26; this
 * allowlist is the durable guard that stops them re-accumulating if an
 * out-of-tree producer ever enqueues with a deprecated source again.
 *
 * `undefined` is intentionally allowed: existing operator-queued items
 * (e.g. `POST /api/queue` without an explicit source field) fall through
 * to the `user-request` mapping below and must keep working.
 */
const ALLOWED_SOURCES = new Set<string>([
  "research",
  "user-request",
  "operator",
]);

function isAllowedSource(source: unknown): boolean {
  if (source === undefined || source === null) return true;
  if (typeof source !== "string") return false;
  return ALLOWED_SOURCES.has(source);
}

export async function selectWorkQueueAnchor(): Promise<WorkQueueAnchor | null> {
  const queued = await claimNextWorkQueueItem();
  if (!queued) return null;

  try {
    const item = JSON.parse(queued);

    // Source allowlist (issue #449) — reject items emitted by deleted
    // in-process agents (`code-reviewer`, `adversarial-validation`, etc.)
    // before they get mapped to a `user-request` anchor and lose their
    // provenance.
    if (!isAllowedSource(item?.source)) {
      console.error(
        `[ControlLoop] Dropping work-queue item with disallowed source=${JSON.stringify(
          item?.source,
        )} reference=${JSON.stringify(item?.reference || item?.description || "")}`,
      );
      try {
        await removeFromProcessingQueue(queued);
      } catch (err: any) {
        console.error(
          `[ControlLoop] Failed to LREM disallowed-source work-queue item: ${err.message}`,
        );
      }
      return null;
    }

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
        await removeFromProcessingQueue(queued);
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to drop drift-duplicate work-queue item: ${err.message}`);
      }
      return null;
    }
    return candidate;
  } catch (err: any) {
    console.error(`[ControlLoop] Corrupt work-queue item dropped: ${err.message} — data: ${queued.slice(0, 200)}`);
    // Remove corrupt item from processing queue — it cannot be recovered
    await removeFromProcessingQueue(queued);
    return null;
  }
}
