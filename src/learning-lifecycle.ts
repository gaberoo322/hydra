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

import { consolidateAgentPatterns } from "./pattern-memory/agent-memory.ts";
import { consolidateStalePromotedRules } from "./pattern-memory/feedback-file.ts";
import { consolidatePromotedRuleEffectiveness } from "./pattern-memory/rule-effectiveness.ts";
import { registerSkills } from "./knowledge-base/skill-registration.ts";
import { startKnowledgeIndexer } from "./knowledge-base/knowledge-indexer.ts";
import {
  countSourceHashes,
  clearSourceHashes,
} from "./redis/source-index.ts";
import { probeOvSourceResourcesPresent } from "./knowledge-base/source-freshness.ts";

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
// Source-index staleness detection (issue #2267)
// ===========================================================================

/**
 * Detect and repair a stale source-index cache (issue #2267).
 *
 * The durable source-hash cache (`hydra:knowledge:source-hashes`, issue #1123)
 * lets the indexer skip re-embedding unchanged files across restarts. But if
 * OpenViking is reset out from under that cache (container reset, deployment,
 * volume wipe), the cache still claims full coverage so the indexer skips every
 * file — leaving the knowledge base empty while the cache says otherwise (the
 * exact failure this issue reports: 2599 cached hashes, 0 OV resources).
 *
 * The repair: if the cache is NON-EMPTY but a targeted OpenViking probe finds NO
 * indexed source resource (no `viking://resources/` hit), OV was reset — so
 * clear the cache. The next `runSourceInitialPass` (started immediately after by
 * `startKnowledgeIndexer`) then sees an empty cache and re-uploads the
 * modified-window tree, repopulating OV.
 *
 * INVARIANT — never re-index a healthy restart. The probe uses OV-truth (a
 * `viking://resources/` search hit), NOT `coverageStats.resourceCount` (which is
 * 0 on every healthy cache-hit restart and would re-embed the whole tree every
 * bounce, undoing #1123). On a healthy OV the probe returns present and this is
 * a no-op. An empty cache (cold start) is also a no-op — there is nothing stale
 * to clear; the indexer simply populates it.
 *
 * Best-effort: every step degrades to "do not clear" on error (count failure ->
 * 0, probe failure -> present), so a Redis or OV hiccup never wrongly wipes the
 * cache and never blocks startup. Runs once in `initLearning`, BEFORE
 * `startKnowledgeIndexer`, so the cleared cache is honoured by the same boot's
 * initial pass.
 */
export async function detectAndClearStaleSourceIndex(
  // Injectable OV probe (issue #2267) so tests drive the present/absent branches
  // deterministically without a live OpenViking; production passes nothing and
  // gets the real `trackedOvSearch`-backed probe.
  probe: () => Promise<boolean> = probeOvSourceResourcesPresent,
): Promise<void> {
  try {
    const cached = await countSourceHashes();
    if (cached <= 0) {
      // Cold/empty cache — nothing stale; the indexer will populate it normally.
      return;
    }
    const present = await probe();
    if (present) {
      // Healthy: cache claims coverage AND OV holds indexed source resources.
      return;
    }
    // Stale: cache is populated but OV holds no indexed source resources — OV was
    // reset out from under the cache. Clear so the upcoming initial pass
    // re-uploads the tree.
    const cleared = await clearSourceHashes();
    if (cleared) {
      console.warn(
        `[Learning] Stale source-index detected (issue #2267): ${cached} cached hashes but OpenViking holds no indexed source resources — cleared cache to force re-index on this boot.`,
      );
    } else {
      console.error(
        `[Learning] Stale source-index detected (${cached} cached hashes, OV empty) but cache clear failed — will retry on next restart.`,
      );
    }
  } catch (err: any) {
    /* intentional: staleness repair is best-effort. Any failure degrades to a
       logged no-op (the indexer keeps the old cache and re-uploads only on a
       genuine content change) — never a crash, never a blocked startup. */
    console.error(
      `[Learning] Source-index staleness detection failed: ${err?.message || String(err)}`,
    );
  }
}

// ===========================================================================
// Public API — initLearning
// ===========================================================================

/**
 * Initialize the learning system on startup:
 *   1. Register OV skills (non-blocking)
 *   2. Start knowledge indexer background process
 */
export async function initLearning(): Promise<void> {
  // 1. Register OV skills (non-blocking). registerSkills() records the outcome
  //    in a queryable in-process skill-catalog state (issue #1968) — query it
  //    via getSkillCatalogState() / GET /api/health/skills to detect the silent
  //    empty-catalog failure (all skills lost to OpenViking timeouts under load)
  //    that this fire-and-forget call used to hide behind a lone console.error.
  registerSkills().catch((err: any) => console.error(`[Learning] Skill registration failed: ${err.message}`));

  // 1b. Detect + repair a stale source-index cache (issue #2267). Runs BEFORE
  //     startKnowledgeIndexer so a cleared cache is honoured by this boot's
  //     initial pass. Best-effort/never-throws — a healthy OV or a cold cache is
  //     a no-op; only a populated-cache-but-empty-OV (OV reset) triggers a clear.
  await detectAndClearStaleSourceIndex();

  // 2. Start knowledge indexer
  startKnowledgeIndexer();
}
