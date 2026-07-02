/**
 * Daily memory-consolidation chore.
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

import { setMemoryLastConsolidation } from "../../redis/housekeeping.ts";
import { consolidate as consolidateImpl } from "../../learning-lifecycle.ts";

/** External touchpoints of the memory-consolidation chore. */
export interface MemoryConsolidationDeps {
  consolidate?: () => Promise<unknown>;
  setLastConsolidation?: typeof setMemoryLastConsolidation;
}

/**
 * Daily memory consolidation — prune stale patterns, then stamp the daily
 * guard key. The daily cadence guard is applied by `runHousekeeping`.
 */
export async function runMemoryConsolidation(deps: MemoryConsolidationDeps = {}): Promise<void> {
  const consolidate = deps.consolidate ?? consolidateImpl;
  const setLastConsolidation = deps.setLastConsolidation ?? setMemoryLastConsolidation;
  await consolidate();
  await setLastConsolidation(Date.now().toString());
}
