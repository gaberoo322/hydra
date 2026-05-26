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
 * Allowlist of `source` values that selectWorkQueueAnchor() will surface
 * as anchors (issue #449). Anything outside this set is treated as an
 * orphan emitted by a producer that no longer exists (e.g. the deleted
 * in-process `code-reviewer` and `adversarial-validation` agents retired
 * in PR-3 / issue #383) and is LREM'd in place so it can't reappear.
 *
 * `undefined` is intentionally allowed because the no-source-field shape
 * is what operator-queued items look like today — dropping those would
 * be a behaviour change far beyond the issue's scope.
 */
export const WORK_QUEUE_SOURCE_ALLOWLIST: ReadonlySet<string> = new Set([
  "research",
  "user-request",
  "operator",
]);

/**
 * True when an item's `source` value should be surfaced as an anchor.
 * Items with no source field (undefined / null / missing key) are
 * preserved — that's how operator-queued items look on the wire today.
 */
export function isAllowedWorkQueueSource(source: unknown): boolean {
  if (source === undefined || source === null) return true;
  if (typeof source !== "string") return false;
  return WORK_QUEUE_SOURCE_ALLOWLIST.has(source);
}

export async function selectWorkQueueAnchor(): Promise<WorkQueueAnchor | null> {
  const queued = await claimNextWorkQueueItem();
  if (!queued) return null;

  try {
    const item = JSON.parse(queued);

    // Source allowlist (issue #449). Items emitted by retired in-process
    // agents (code-reviewer, adversarial-validation) have no live producer
    // and must not be surfaced as anchors; drop them in place so they
    // can't be recovered on next cycle. Logged loudly per CLAUDE.md
    // "Fail loud" rule so the drop is visible in journalctl.
    if (!isAllowedWorkQueueSource(item.source)) {
      console.error(
        `[WorkQueueTier] Dropping orphan-source work-queue item: source=${JSON.stringify(item.source)} reference=${JSON.stringify(item.reference || item.description || "")}`,
      );
      try {
        await removeFromProcessingQueue(queued);
      } catch (err: any) {
        console.error(`[WorkQueueTier] Failed to LREM orphan-source item: ${err.message}`);
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
