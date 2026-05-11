/**
 * learning.ts — Facade for the Hydra learning system
 *
 * After the issue #219 split, this module is a thin orchestrator that
 * composes the learning subsystems:
 *
 *   - learning/agent-memory.ts        — Redis-backed pattern memory + auto-promotion
 *   - learning/reflections.ts         — per-anchor + global Reflexion-style storage
 *   - learning/ov-search.ts           — OpenViking search wrapper + cycle sessions
 *   - learning/knowledge-indexer.ts   — fs.watch + Redis polling background process
 *   - learning/skill-registration.ts  — OV skill catalog
 *   - learning/source-indexer.ts + learning/ov-upload.ts — already split (#210/#217)
 *
 * Public API (kept stable for callers):
 *   recordOutcome()  — record agent lessons + reflections after a cycle
 *   getContext()     — load all learning context for an agent prompt
 *   consolidate()    — prune stale patterns + auto-promoted rules (daily)
 *   initLearning()   — start knowledge indexer, register OV skills, migrate rules
 *   clearOutcomes()  — drop reflections for an anchor after a successful merge
 *
 * All other exports are pass-throughs from the subsystem modules so existing
 * callers (codex-runner, control-loop, api/*, tests) keep working without
 * needing to update their imports.
 */

import {
  loadAgentMemory,
  formatMemoryForPrompt,
  recordPlannerLesson,
  recordExecutorLesson,
  recordSkepticLesson,
  recordPattern as recordPatternImpl,
  consolidateAgentPatterns,
  consolidateStalePromotedRules,
  migrateRulesToPatterns,
  PROMOTION_THRESHOLD as PROMOTION_THRESHOLD_VALUE,
  detectStalePromotedRules as detectStalePromotedRulesImpl,
  processStaleRules as processStaleRulesImpl,
} from "./learning/agent-memory.ts";
import {
  recordAnchorReflection,
  loadAnchorReflections,
  recordGlobalReflection,
  loadRelevantReflections as loadRelevantReflectionsImpl,
  formatReflectionsForPrompt as formatReflectionsForPromptImpl,
  clearReflectionsForAnchor as clearReflectionsForAnchorImpl,
  recordReflection as recordReflectionImpl,
  recordReflectionOutcome,
  deleteAnchorReflections,
  extendAnchorReflectionsTTL,
  getAllReflections as getAllReflectionsImpl,
  closeReflectionsRedis as closeReflectionsRedisImpl,
  getReflectionEffectiveness as getReflectionEffectivenessImpl,
} from "./learning/reflections.ts";
import {
  trackedOvSearch as trackedOvSearchImpl,
  buildFallbackQuery as buildFallbackQueryImpl,
  getOvSearchMetrics as getOvSearchMetricsImpl,
  resetOvSearchMetrics as resetOvSearchMetricsImpl,
  createCycleSession as createCycleSessionImpl,
  type OvSearchMetrics,
} from "./learning/ov-search.ts";
import { registerSkills } from "./learning/skill-registration.ts";
import { startKnowledgeIndexer } from "./learning/knowledge-indexer.ts";
import type { SourcePath } from "./learning/source-indexer.ts";
import {
  parseSourcePaths,
  shouldIndexSource,
  enumerateSourceFiles,
  buildSourceTitle,
  runSourceInitialPass,
  getCoverageStats,
  resetCoverageStats,
} from "./learning/source-indexer.ts";

// ===========================================================================
// Re-exports — keep public surface stable for existing callers / tests
// ===========================================================================

export const PROMOTION_THRESHOLD = PROMOTION_THRESHOLD_VALUE;
export type { SourcePath, OvSearchMetrics };
export {
  // source indexer (issue #210/#211)
  parseSourcePaths,
  shouldIndexSource,
  enumerateSourceFiles,
  buildSourceTitle,
  runSourceInitialPass,
  getCoverageStats,
  resetCoverageStats,
};

// OV search (issue #219)
export const trackedOvSearch = trackedOvSearchImpl;
export const buildFallbackQuery = buildFallbackQueryImpl;
export const getOvSearchMetrics = getOvSearchMetricsImpl;
export const resetOvSearchMetrics = resetOvSearchMetricsImpl;
export const createCycleSession = createCycleSessionImpl;

// Reflection storage (issue #219)
export const recordReflection = recordReflectionImpl;
export const getAllReflections = getAllReflectionsImpl;
export const closeReflectionsRedis = closeReflectionsRedisImpl;
export const loadRelevantReflections = loadRelevantReflectionsImpl;
export const formatReflectionsForPrompt = formatReflectionsForPromptImpl;
export const clearReflectionsForAnchor = clearReflectionsForAnchorImpl;
export const getReflectionEffectiveness = getReflectionEffectivenessImpl;

// Agent memory (issue #219)
export { loadAgentMemory, formatMemoryForPrompt };
export const recordPattern = recordPatternImpl;
export const detectStalePromotedRules = detectStalePromotedRulesImpl;
export const processStaleRules = processStaleRulesImpl;
export type { StaleRule } from "./learning/agent-memory.ts";
export {
  getIneffectivePromotedPatterns,
  evaluatePromotedPatternEffectiveness,
  MIN_DAYS_POST_PROMOTION,
} from "./learning/agent-memory.ts";
export type {
  IneffectivePromotedPattern,
  MemoryPattern,
} from "./learning/agent-memory.ts";
export type {
  GlobalReflection,
  ReflectionOutcome,
  ReflectionEffectiveness,
} from "./learning/reflections.ts";

// ===========================================================================
// Public types
// ===========================================================================

export type OutcomeAgent = "planner" | "executor" | "skeptic";

export interface OutcomeOpts {
  agents: OutcomeAgent[];
  cycleId: string;
  task: any;
  finalState: string;
  anchorRef: string;
  anchorType: string;
  context?: any;
  skepticVerdict?: string;
  reflection?: {
    failureMode: string;
    whatFailed: string;
    whyItFailed: string;
    whatToTryDifferently: string;
    verificationErrors?: string[];
  };
}

// ===========================================================================
// Public API — recordOutcome
// ===========================================================================

/**
 * Record outcome for one or more agents + optional reflections.
 * Never throws — all errors are logged with context.
 */
export async function recordOutcome(opts: OutcomeOpts): Promise<void> {
  const {
    agents, cycleId, task, finalState, anchorRef, anchorType,
    context = {}, skepticVerdict, reflection,
  } = opts;

  // AC1: Check if anchor had existing reflections — if so, record the outcome
  try {
    const outcome = finalState === "merged"
      ? "merged"
      : finalState === "abandoned" ? "abandoned" : "failed";
    const priorCount = await recordReflectionOutcome({ anchorRef, outcome, cycleId });
    if (priorCount > 0) {
      console.log(`[Learning] Recorded reflection outcome for "${anchorRef.slice(0, 60)}": ${outcome} (had ${priorCount} prior reflections)`);
    }
  } catch (err: any) {
    console.error(`[Learning] Failed to record reflection outcome for ${cycleId}: ${err.message}`);
  }

  // Record per-agent lessons
  for (const agent of agents) {
    try {
      switch (agent) {
        case "planner":
          await recordPlannerLesson(cycleId, task, finalState, context);
          break;
        case "executor":
          await recordExecutorLesson(cycleId, task, finalState, context);
          break;
        case "skeptic":
          await recordSkepticLesson(cycleId, task, skepticVerdict ?? "approve", finalState);
          break;
      }
    } catch (err: any) {
      console.error(`[Learning] Failed to record ${agent} lesson for ${cycleId}: ${err.message}`);
    }
  }

  // Record reflections (both per-anchor and global) if provided
  if (reflection) {
    try {
      await recordAnchorReflection({
        cycleId,
        anchorRef,
        taskTitle: reflection.whatFailed,
        outcome: reflection.failureMode,
        reason: reflection.whyItFailed,
        verificationErrors: reflection.verificationErrors,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record per-anchor reflection for ${cycleId}: ${err.message}`);
    }

    try {
      await recordGlobalReflection({
        cycleId,
        anchorType,
        anchorReference: anchorRef,
        failureMode: reflection.failureMode,
        whatFailed: reflection.whatFailed,
        whyItFailed: reflection.whyItFailed,
        whatToTryDifferently: reflection.whatToTryDifferently,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record global reflection for ${cycleId}: ${err.message}`);
    }
  }
}

// ===========================================================================
// Public API — getContext
// ===========================================================================

/**
 * Load all learning context for an agent + anchor in one call.
 * Combines agent memory, per-anchor reflections, and global reflections.
 * Never throws — individual sources degrade gracefully.
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string },
): Promise<string> {
  const parts: string[] = [];

  // 1. Agent memory patterns
  try {
    const memory = await loadAgentMemory(agent);
    const formatted = formatMemoryForPrompt(memory, agent);
    if (formatted) parts.push(formatted);
  } catch (err: any) {
    console.error(`[Learning] getContext: agent memory load failed for ${agent}: ${err.message}`);
  }

  // 2. Per-anchor episodic reflections
  try {
    const reflections = await loadAnchorReflections(anchor.reference);
    if (reflections) parts.push(reflections);
  } catch (err: any) {
    console.error(`[Learning] getContext: per-anchor reflections failed for "${anchor.reference}": ${err.message}`);
  }

  // 3. Global relevant reflections (Reflexion pattern)
  try {
    const relevant = await loadRelevantReflectionsImpl(anchor);
    const formatted = formatReflectionsForPromptImpl(relevant);
    if (formatted) parts.push(formatted);
  } catch (err: any) {
    console.error(`[Learning] getContext: global reflections failed for "${anchor.reference}": ${err.message}`);
  }

  return parts.join("\n\n");
}

// ===========================================================================
// Public API — consolidate
// ===========================================================================

/**
 * Run daily consolidation: prune stale agent patterns + sweep stale
 * auto-promoted feedback rules. Called by the scheduler once per day.
 */
export async function consolidate(): Promise<void> {
  await consolidateAgentPatterns();

  // Detect and process stale auto-promoted rules in feedback files
  try {
    await consolidateStalePromotedRules();
  } catch (err: any) {
    console.error(`[Learning] Stale rule consolidation failed: ${err.message}`);
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

  // 2. Register OV skills (non-blocking)
  registerSkills().catch((err: any) => console.error(`[Learning] Skill registration failed: ${err.message}`));

  // 3. Start knowledge indexer
  startKnowledgeIndexer();
}

// ===========================================================================
// Public API — clearOutcomes (post-merge cleanup)
// ===========================================================================

/**
 * Clear per-anchor and global reflections for an anchor reference.
 * Called after a successful merge. Never throws.
 *
 * AC3: If the reflection has >50% success rate, extend TTL to 30 days
 * instead of deleting — preserving effective reflections longer.
 */
export async function clearOutcomes(anchorRef: string): Promise<void> {
  try {
    // Check effectiveness before deciding to delete or extend
    const effectiveness = await getReflectionEffectivenessImpl();
    const anchorStats = effectiveness.anchors.find(a => a.ref === anchorRef);

    if (anchorStats && anchorStats.successRate > 0.5) {
      // Effective reflections: extend TTL instead of deleting
      await extendAnchorReflectionsTTL(anchorRef);
      console.log(`[Learning] Extended TTL for effective reflections "${anchorRef.slice(0, 60)}" to 30 days (${Math.round(anchorStats.successRate * 100)}% success rate)`);
    } else {
      // Ineffective or no data: delete as before
      await deleteAnchorReflections(anchorRef);
    }
  } catch (err: any) {
    console.error(`[Learning] Failed to clear per-anchor reflections for "${anchorRef}": ${err.message}`);
  }

  try {
    await clearReflectionsForAnchorImpl(anchorRef);
  } catch (err: any) {
    console.error(`[Learning] Failed to clear global reflections for "${anchorRef}": ${err.message}`);
  }
}
