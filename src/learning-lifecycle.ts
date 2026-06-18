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
 *   initLearning()    — start knowledge indexer, register OV skills, migrate rules
 */

import {
  consolidateAgentPatterns,
  consolidateStalePromotedRules,
  migrateRulesToPatterns,
  backfillPromotionMetadata,
} from "./pattern-memory/agent-memory.ts";
import { consolidatePromotedRuleEffectiveness } from "./pattern-memory/rule-effectiveness.ts";
import { registerSkills } from "./knowledge-base/skill-registration.ts";
import { startKnowledgeIndexer } from "./knowledge-base/knowledge-indexer.ts";

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

  // Detect and process stale auto-promoted rules in feedback files
  try {
    await consolidateStalePromotedRules();
  } catch (err: any) {
    console.error(`[Learning] Stale rule consolidation failed: ${err.message}`);
  }

  // Issue #365 — auto-demote rules whose post-promotion firing rate proves
  // the promotion never closed the loop. Best-effort; never throws.
  try {
    await consolidatePromotedRuleEffectiveness();
  } catch (err: any) {
    console.error(`[Learning] Promoted-rule effectiveness consolidation failed: ${err.message}`);
  }
}

// ===========================================================================
// Public API — initLearning
// ===========================================================================

/**
 * Initialize the learning system on startup:
 *   1. Migrate old rules to patterns (one-time)
 *   2. Register OV skills (non-blocking)
 *   3. Start knowledge indexer background process
 */
export async function initLearning(): Promise<void> {
  // 1. Migrate old rules → patterns
  try {
    await migrateRulesToPatterns();
  } catch (err: any) {
    console.error(`[Learning] Memory migration failed: ${err.message}`);
  }

  // 1b. Backfill promotion metadata for patterns promoted before issue #289
  //     instrumentation (idempotent, guarded by Redis flag — issue #302).
  try {
    await backfillPromotionMetadata();
  } catch (err: any) {
    console.error(`[Learning] Promotion-metadata backfill failed: ${err.message}`);
  }

  // 2. Register OV skills (non-blocking). registerSkills() records the outcome
  //    in a queryable in-process skill-catalog state (issue #1968) — query it
  //    via getSkillCatalogState() / GET /api/health/skills to detect the silent
  //    empty-catalog failure (all skills lost to OpenViking timeouts under load)
  //    that this fire-and-forget call used to hide behind a lone console.error.
  registerSkills().catch((err: any) => console.error(`[Learning] Skill registration failed: ${err.message}`));

  // 3. Start knowledge indexer
  startKnowledgeIndexer();
}
