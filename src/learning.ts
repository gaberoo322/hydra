/**
 * learning.ts — Cross-cluster orchestration for Hydra's learning subsystems
 *
 * The three learning clusters live as sibling top-level modules:
 *
 *   - src/pattern-memory/  — Redis-backed pattern store, promotion, escalation
 *   - src/reflections/     — per-anchor + global Reflexion-style storage
 *   - src/knowledge-base/  — OpenViking search + indexers (source, knowledge)
 *
 * This file owns the genuinely cross-cluster orchestration that composes them
 * — nothing else. Callers that want a single cluster's API should import from
 * that cluster directly, not from here.
 *
 * Public API:
 *   getContext()      — load all learning context for an agent prompt (Pattern Memory + Reflections)
 *   consolidate()     — prune stale patterns + auto-promoted rules (daily)
 *   initLearning()    — start knowledge indexer, register OV skills, migrate rules
 */

import {
  consolidateAgentPatterns,
  consolidateStalePromotedRules,
  consolidatePromotedRuleEffectiveness,
  migrateRulesToPatterns,
  backfillPromotionMetadata,
  loadAgentMemory,
  formatMemoryForPrompt,
} from "./pattern-memory/agent-memory.ts";
import {
  loadAnchorReflections,
  loadAnchorReflectionsByFile,
  backfillByFileIndex,
  extractFilesFromAnchor,
  loadRelevantReflections,
  formatReflectionsForPrompt,
} from "./reflections/reflections.ts";
import { registerSkills } from "./knowledge-base/skill-registration.ts";
import { startKnowledgeIndexer } from "./knowledge-base/knowledge-indexer.ts";

// ===========================================================================
// Public API — getContext
// ===========================================================================

/**
 * Load all learning context for an agent + anchor in one call.
 * Combines agent memory, per-anchor reflections, by-file reflections (issue
 * #326), and global reflections. Never throws — individual sources degrade
 * gracefully.
 *
 * `anchor.files` (optional) hints scope files for the by-file index lookup.
 * When omitted, file paths are extracted from `anchor.reference`.
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string; files?: string[] },
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

  // 2. Per-anchor episodic reflections (legacy primary key — verbatim
  //    anchor.reference). When this returns content, opportunistically
  //    backfill the by-file index so the new path warms organically.
  let perAnchorHit = false;
  try {
    const reflections = await loadAnchorReflections(anchor.reference);
    if (reflections) {
      parts.push(reflections);
      perAnchorHit = true;
      // Acceptance: "Backfill on read: when an old reflection is hit by the
      // legacy path, opportunistically index it under by-file:".
      try {
        await backfillByFileIndex(anchor.reference, anchor.files);
      } catch (err: any) {
        console.error(`[Learning] getContext: by-file backfill failed for "${anchor.reference}": ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[Learning] getContext: per-anchor reflections failed for "${anchor.reference}": ${err.message}`);
  }

  // 3. By-file secondary index (issue #326): fan out to reflections recorded
  //    for *other* anchors that touched the same files. This is the dominant
  //    reflection-injection failure mode — verbatim anchor.reference rarely
  //    matches but file paths recur constantly.
  try {
    const files = extractFilesFromAnchor(anchor.reference, anchor.files);
    if (files.length > 0) {
      const byFile = await loadAnchorReflectionsByFile(files, anchor.reference);
      if (byFile) parts.push(byFile);
    }
  } catch (err: any) {
    console.error(`[Learning] getContext: by-file reflections failed for "${anchor.reference}": ${err.message}`);
  }

  // 4. Global relevant reflections (Reflexion pattern)
  try {
    const relevant = await loadRelevantReflections(anchor);
    const formatted = formatReflectionsForPrompt(relevant);
    if (formatted) parts.push(formatted);
  } catch (err: any) {
    console.error(`[Learning] getContext: global reflections failed for "${anchor.reference}": ${err.message}`);
  }

  // Silence unused-var lint when perAnchorHit is purely for future telemetry.
  void perAnchorHit;
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

  // 2. Register OV skills (non-blocking)
  registerSkills().catch((err: any) => console.error(`[Learning] Skill registration failed: ${err.message}`));

  // 3. Start knowledge indexer
  startKnowledgeIndexer();
}

