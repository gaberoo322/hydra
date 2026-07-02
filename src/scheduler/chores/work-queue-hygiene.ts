/**
 * Work-queue hygiene chore (issue #1690).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

import { reconcileWorkQueue as reconcileWorkQueueImpl } from "../../backlog/work-queue-hygiene.ts";

/** External touchpoints of the work-queue-hygiene chore. */
export interface WorkQueueHygieneDeps {
  reconcileWorkQueue?: () => Promise<{ removed: number; scanned: number }>;
}

/**
 * Work-queue hygiene (issue #1690) — reconcile `hydra:anchors:work-queue`
 * entries against resolved state. The engine is fail-open + idempotent (a
 * second run finds nothing to remove) and its `gh` cost is bounded by an
 * internal per-run cap, so no Redis time-guard is needed.
 */
export async function runWorkQueueHygiene(deps: WorkQueueHygieneDeps = {}): Promise<void> {
  const reconcileWorkQueue = deps.reconcileWorkQueue ?? reconcileWorkQueueImpl;
  const wq = await reconcileWorkQueue();
  if (wq.removed > 0) {
    console.log(
      `[Housekeeping] Work-queue hygiene: removed ${wq.removed} resolved entr${wq.removed === 1 ? "y" : "ies"} (scanned ${wq.scanned})`,
    );
  }
}
