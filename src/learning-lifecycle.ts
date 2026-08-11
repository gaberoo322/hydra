/**
 * learning-lifecycle.ts — Startup + daily-maintenance lifecycle for the learning subsystem
 *
 * Split out of src/learning.ts (issue #2035). That module mixed three
 * structurally independent concerns across three time horizons:
 *
 *   1. dispatch-time composition — getContext()/loadBlock() (per dispatch)
 *   2. daily maintenance          — consolidate()          (once per day)
 *   3. startup lifecycle          — initLearning()         (once at boot)
 *
 * Only (1) is composition. (2) and (3) are lifecycle management — startup
 * side effects and maintenance scheduling — and they live here. `learning.ts`
 * now owns ONLY the composition seam and imports NOTHING from this module
 * (one-way dependency: lifecycle may reach the cluster Modules directly, the
 * composition seam never reaches lifecycle). Reading the composition contract
 * therefore no longer pulls in the knowledge-indexer file-watcher or the OV
 * skill-registration init ping.
 *
 * Public API:
 *   consolidate()     — prune stale patterns + auto-promoted rules (daily)
 *   initLearning()    — start knowledge indexer, register OV skills
 */

import {
  consolidateAgentPatterns,
  consolidatePromotedRuleEffectiveness,
} from "./pattern-memory/index.ts";

// ===========================================================================
// Public API — consolidate
// ===========================================================================

/**
 * Run daily consolidation: prune stale agent patterns + sweep stale
 * auto-promoted feedback rules. Called by the scheduler once per day.
 */
export async function consolidate(): Promise<void> {
  // Issue #1454 — the daily reflection-buffer consolidation step was removed
  // with the dead global reflection buffer subsystem. The reap-side writer it
  // used to drain had already been severed (no live producer), so the bridge
  // had nothing to flush. Per-anchor reflections are written directly by
  // recordAnchorReflection on the live #841 path.
  await consolidateAgentPatterns();

  // Issue #2962 — the stale auto-promoted-rule sweep over
  // `config/feedback/to-*.md` was retired with `feedback-file.ts`; those files
  // were write-only (no dispatch prompt read them after ADR-0006 / #710), so
  // there is nothing left to consolidate there.

  // Issue #365 — auto-demote rules whose post-promotion firing rate proves
  // the promotion never closed the loop. Best-effort; never throws.
  try {
    await consolidatePromotedRuleEffectiveness();
  } catch (err: any) {
    console.error(`[Learning] Promoted-rule effectiveness consolidation failed: ${err.message}`);
  }
}

// ===========================================================================
// Source-index staleness detection (issue #2267)
// ===========================================================================

// `initLearning()` and `detectAndClearStaleSourceIndex()` were removed with
// OpenViking: both existed only to register OV skills, repair the OV source-index
// dedup cache, and start the OV knowledge indexer. `consolidate()` (Redis pattern
// memory) is what remains of this lifecycle.
