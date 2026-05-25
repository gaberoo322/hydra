/**
 * learning.ts — Cross-cluster orchestration for Hydra's learning subsystems
 *
 * The three learning clusters live as sibling top-level modules:
 *
 *   - src/pattern-memory/  — Redis-backed pattern store, promotion, escalation
 *   - src/reflections/     — per-anchor + global Reflexion-style storage
 *   - src/knowledge-base/  — OpenViking search + indexers (source, knowledge)
 *
 * Two of those — Pattern Memory and Reflections — are composed here at
 * agent-dispatch time and injected into the subagent prompt. The Knowledge
 * Base sits at a different seam: subagents query it themselves via OV HTTP
 * during their own work. That separation is by design (see CONTEXT.md).
 *
 * This file owns the genuinely cross-cluster orchestration that composes
 * them — nothing else. Callers that want a single cluster's API should
 * import from that cluster directly, not from here.
 *
 * Public API:
 *   getContext()      — load Pattern Memory + Reflections for an agent prompt as a structured trace
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
 * The four sources getContext() composes. The names appear in the public
 * trace, so they're part of the interface — renaming one is a breaking
 * change for anything reading /api/learning/context-trace.
 */
export type LearningContextSource =
  | "agent-memory"
  | "per-anchor-reflections"
  | "by-file-reflections"
  | "global-reflections";

/**
 * Per-source diagnostic envelope. `status` distinguishes three real cases:
 *
 *   - "hit"   — the source returned content; it contributed to the prompt.
 *   - "miss"  — the source ran successfully but had nothing to say (steady
 *               state for a brand-new anchor; not a failure).
 *   - "error" — the source threw. `error` is populated. `content` is "".
 *               Detecting an all-error pattern across calls is the operator
 *               signal that something is broken (Redis namespace shift,
 *               by-file index drift, etc.).
 *
 * `content` carries the raw block text for "hit"; empty otherwise.
 */
export interface LearningContextBlock {
  source: LearningContextSource;
  status: "hit" | "miss" | "error";
  content: string;
  error?: string;
}

/**
 * Structured result of getContext(). Callers that want the prompt string
 * (the historical return shape) call `toPrompt()`. Callers that want to
 * know *which* sources contributed (debug endpoint, telemetry, tests)
 * inspect `blocks` directly.
 */
export interface LearningContext {
  blocks: LearningContextBlock[];
  /** Join the content of every "hit" block with the legacy "\n\n" separator. */
  toPrompt(): string;
}

function buildContext(blocks: LearningContextBlock[]): LearningContext {
  return {
    blocks,
    toPrompt(): string {
      return blocks
        .filter(b => b.status === "hit" && b.content.length > 0)
        .map(b => b.content)
        .join("\n\n");
    },
  };
}

async function loadAgentMemoryBlock(agent: string): Promise<LearningContextBlock> {
  try {
    const memory = await loadAgentMemory(agent);
    const formatted = formatMemoryForPrompt(memory, agent);
    if (formatted) return { source: "agent-memory", status: "hit", content: formatted };
    return { source: "agent-memory", status: "miss", content: "" };
  } catch (err: any) {
    console.error(`[Learning] getContext: agent memory load failed for ${agent}: ${err.message}`);
    return { source: "agent-memory", status: "error", content: "", error: err.message };
  }
}

async function loadPerAnchorReflectionsBlock(
  anchor: { reference: string; files?: string[] },
): Promise<LearningContextBlock> {
  try {
    const reflections = await loadAnchorReflections(anchor.reference);
    if (!reflections) return { source: "per-anchor-reflections", status: "miss", content: "" };
    // Acceptance: "Backfill on read: when an old reflection is hit by the
    // legacy path, opportunistically index it under by-file:". Side effect
    // is intentional and bounded — pre-#326 reflections age out at TTL.
    try {
      await backfillByFileIndex(anchor.reference, anchor.files);
    } catch (err: any) {
      console.error(`[Learning] getContext: by-file backfill failed for "${anchor.reference}": ${err.message}`);
    }
    return { source: "per-anchor-reflections", status: "hit", content: reflections };
  } catch (err: any) {
    console.error(`[Learning] getContext: per-anchor reflections failed for "${anchor.reference}": ${err.message}`);
    return { source: "per-anchor-reflections", status: "error", content: "", error: err.message };
  }
}

async function loadByFileReflectionsBlock(
  anchor: { reference: string; files?: string[] },
): Promise<LearningContextBlock> {
  try {
    const files = extractFilesFromAnchor(anchor.reference, anchor.files);
    if (files.length === 0) return { source: "by-file-reflections", status: "miss", content: "" };
    const byFile = await loadAnchorReflectionsByFile(files, anchor.reference);
    if (byFile) return { source: "by-file-reflections", status: "hit", content: byFile };
    return { source: "by-file-reflections", status: "miss", content: "" };
  } catch (err: any) {
    console.error(`[Learning] getContext: by-file reflections failed for "${anchor.reference}": ${err.message}`);
    return { source: "by-file-reflections", status: "error", content: "", error: err.message };
  }
}

async function loadGlobalReflectionsBlock(
  anchor: { type: string; reference: string },
): Promise<LearningContextBlock> {
  try {
    const relevant = await loadRelevantReflections(anchor);
    const formatted = formatReflectionsForPrompt(relevant);
    if (formatted) return { source: "global-reflections", status: "hit", content: formatted };
    return { source: "global-reflections", status: "miss", content: "" };
  } catch (err: any) {
    console.error(`[Learning] getContext: global reflections failed for "${anchor.reference}": ${err.message}`);
    return { source: "global-reflections", status: "error", content: "", error: err.message };
  }
}

/**
 * Load Pattern Memory + Reflections context for an agent + anchor.
 * Returns a structured trace: each source contributes a block with a
 * status ("hit" / "miss" / "error"). Never throws — sources degrade
 * individually.
 *
 * The composed prompt string (what callers historically consumed) is
 * available via `result.toPrompt()`.
 *
 * `anchor.files` (optional) hints scope files for the by-file index
 * lookup. When omitted, file paths are extracted from `anchor.reference`.
 *
 * The four sources, in prompt order:
 *
 *   1. agent-memory             — promoted pattern lessons for `agent`
 *   2. per-anchor-reflections   — legacy verbatim-key match on `reference`
 *   3. by-file-reflections      — reflections from *other* anchors that
 *                                 touched the same files (issue #326)
 *   4. global-reflections       — Reflexion-style relevant reflections
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string; files?: string[] },
): Promise<LearningContext> {
  const blocks: LearningContextBlock[] = [];

  blocks.push(await loadAgentMemoryBlock(agent));
  blocks.push(await loadPerAnchorReflectionsBlock(anchor));
  blocks.push(await loadByFileReflectionsBlock(anchor));
  blocks.push(await loadGlobalReflectionsBlock(anchor));

  return buildContext(blocks);
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

