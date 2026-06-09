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
  migrateRulesToPatterns,
  backfillPromotionMetadata,
  loadAgentMemory,
  formatMemoryForPrompt,
} from "./pattern-memory/agent-memory.ts";
import { consolidatePromotedRuleEffectiveness } from "./pattern-memory/rule-effectiveness.ts";
import {
  loadAnchorReflections,
  loadAnchorReflectionsByFile,
  backfillByFileIndex,
  extractFilesFromAnchor,
  loadRelevantReflections,
  formatReflectionsForPrompt,
  consolidateReflections,
} from "./reflections/reflections.ts";
import { registerSkills } from "./knowledge-base/skill-registration.ts";
import { startKnowledgeIndexer } from "./knowledge-base/knowledge-indexer.ts";

// ===========================================================================
// Public API — getContext
// ===========================================================================

/**
 * The sources getContext() composes. The names appear in the public trace,
 * so they're part of the interface — renaming one is a breaking change for
 * anything reading /api/learning/context-trace.
 *
 * Issue #804: `"knowledge-base"` joins the union. OpenViking search used to
 * be folded silently into the `agent-memory` block (inside `loadAgentMemory`);
 * it now surfaces as its own honest block at this composition seam. The OV
 * cluster is still *composed* here, not *owned* here — the dynamic import that
 * reaches OV lives behind `loadKnowledgeBaseBlock`, keeping the cluster
 * boundary visible (see CONTEXT.md — Learning Context).
 */
export type LearningContextSource =
  | "agent-memory"
  | "knowledge-base"
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
 *
 * Issue #804: `itemCount` is the structured count of discrete items the block
 * contributed — reflections for the reflection sources, OpenViking memories
 * for `knowledge-base`, promoted-pattern groups for `agent-memory`. It is
 * sourced from the underlying data, NOT regex-scanned out of the rendered
 * markdown. `0` for `miss`/`error` blocks. This is the field that lets
 * reflection-injection telemetry be exact instead of re-parsing the prompt.
 *
 * Issue #804 (PR-B): `dropPriority` is the within-bundle drop order consulted
 * when the assembled planner context exceeds its char budget. The learning
 * bundle is dropped WHOLE BLOCKS at a time (never sliced mid-text — slicing a
 * reflection body while leaving its header intact is exactly the corruption
 * that made post-budget counts unreliable). LOWER number = dropped FIRST.
 * The contract is the design-concept drop order:
 *
 *   global (0) → knowledge-base (1) → agent-memory (2) → by-file (3) → per-anchor (4)
 *
 * Per-anchor reflections carry the HIGHEST dropPriority so they are the LAST
 * learning block to be shed — retry-correctness invariant (#193: prior-failure
 * retries had a 0% merge rate without their per-anchor reflections).
 */
export interface LearningContextBlock {
  source: LearningContextSource;
  status: "hit" | "miss" | "error";
  content: string;
  itemCount: number;
  /** Within-bundle drop order under budget pressure; lower = dropped first. */
  dropPriority: number;
  error?: string;
}

/**
 * Issue #804 (PR-B): the canonical within-bundle drop order. Lower number is
 * dropped first when the assembled context is over budget. Frozen contract —
 * per-anchor MUST stay the highest (last-dropped) entry (#193 retry
 * correctness). `buildLearningContext` stamps each block's `dropPriority` from
 * this table; it is the single source of truth for the order rather than having
 * callers re-declare it. (The in-process context-builder budgeter that also
 * read this table was retired in issue #1128.)
 */
export const LEARNING_DROP_PRIORITY: Record<LearningContextSource, number> = {
  "global-reflections": 0,
  "knowledge-base": 1,
  "agent-memory": 2,
  "by-file-reflections": 3,
  "per-anchor-reflections": 4,
};

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

/**
 * Construct a LearningContextBlock, stamping the within-bundle `dropPriority`
 * from the frozen `LEARNING_DROP_PRIORITY` table (issue #804 PR-B). Centralised
 * so the drop-order contract lives in exactly one place — every block flows
 * through here and inherits its priority by source, never by hand.
 */
function mkBlock(
  source: LearningContextSource,
  status: "hit" | "miss" | "error",
  content: string,
  itemCount: number,
  error?: string,
): LearningContextBlock {
  const block: LearningContextBlock = {
    source,
    status,
    content,
    itemCount,
    dropPriority: LEARNING_DROP_PRIORITY[source],
  };
  if (error !== undefined) block.error = error;
  return block;
}

async function loadAgentMemoryBlock(agent: string): Promise<LearningContextBlock> {
  try {
    const memory = await loadAgentMemory(agent);
    const formatted = formatMemoryForPrompt(memory, agent);
    if (formatted) {
      // itemCount = number of formatted pattern groups. Each pattern block is
      // rendered with an `### [severity]` header by formatMemoryForPrompt.
      const itemCount = (formatted.match(/^### \[/gm) || []).length;
      return mkBlock("agent-memory", "hit", formatted, itemCount);
    }
    return mkBlock("agent-memory", "miss", "", 0);
  } catch (err: any) {
    console.error(`[Learning] getContext: agent memory load failed for ${agent}: ${err.message}`);
    return mkBlock("agent-memory", "error", "", 0, err.message);
  }
}

/**
 * Knowledge Base (OpenViking) block (issue #804). This call used to live
 * buried inside `loadAgentMemory` (pattern-memory/agent-memory.ts), folding
 * OV memories into the `agent-memory` block so the trace dishonestly reported
 * `agent-memory: hit` when the content was really OV search results. Lifting
 * it here makes the OV source a first-class, attributable block.
 *
 * Per CONTEXT.md, the Knowledge Base is queried by subagents directly at their
 * own seam; this dispatch-time block only *enriches* the planner prompt. So
 * the OV reach stays a dynamic import behind the cluster boundary — composed
 * here, not owned here.
 *
 * Fail-loud: an OV outage surfaces as `status: "error"` with the message, not
 * a silent drop (the old folded path swallowed OV errors with a bare catch).
 */
async function loadKnowledgeBaseBlock(agent: string): Promise<LearningContextBlock> {
  try {
    const { trackedOvSearch } = await import("./knowledge-base/ov-search.ts");
    const { memories } = await trackedOvSearch(
      `${agent} agent lessons failures prevention`,
      5,
    );
    const top = memories.slice(0, 5);
    const parts: string[] = [];
    for (const mem of top) {
      const abstract = mem.abstract || mem.content || "";
      if (abstract.trim()) parts.push(`- ${abstract.slice(0, 300)}`);
    }
    if (parts.length === 0) return mkBlock("knowledge-base", "miss", "", 0);
    const content = `# ${agent} — Learned Patterns (from OpenViking)\n\n${parts.join("\n")}`;
    return mkBlock("knowledge-base", "hit", content, parts.length);
  } catch (err: any) {
    console.error(`[Learning] getContext: knowledge-base (OV) search failed for ${agent}: ${err.message}`);
    return mkBlock("knowledge-base", "error", "", 0, err.message);
  }
}

async function loadPerAnchorReflectionsBlock(
  anchor: { reference: string; files?: string[] },
): Promise<LearningContextBlock> {
  try {
    const reflections = await loadAnchorReflections(anchor.reference);
    if (reflections.count === 0) return mkBlock("per-anchor-reflections", "miss", "", 0);
    // Acceptance: "Backfill on read: when an old reflection is hit by the
    // legacy path, opportunistically index it under by-file:". Side effect
    // is intentional and bounded — pre-#326 reflections age out at TTL.
    try {
      await backfillByFileIndex(anchor.reference, anchor.files);
    } catch (err: any) {
      console.error(`[Learning] getContext: by-file backfill failed for "${anchor.reference}": ${err.message}`);
    }
    return mkBlock("per-anchor-reflections", "hit", reflections.content, reflections.count);
  } catch (err: any) {
    console.error(`[Learning] getContext: per-anchor reflections failed for "${anchor.reference}": ${err.message}`);
    return mkBlock("per-anchor-reflections", "error", "", 0, err.message);
  }
}

async function loadByFileReflectionsBlock(
  anchor: { reference: string; files?: string[] },
): Promise<LearningContextBlock> {
  try {
    const files = extractFilesFromAnchor(anchor.reference, anchor.files);
    if (files.length === 0) return mkBlock("by-file-reflections", "miss", "", 0);
    const byFile = await loadAnchorReflectionsByFile(files, anchor.reference);
    if (byFile.count > 0) return mkBlock("by-file-reflections", "hit", byFile.content, byFile.count);
    return mkBlock("by-file-reflections", "miss", "", 0);
  } catch (err: any) {
    console.error(`[Learning] getContext: by-file reflections failed for "${anchor.reference}": ${err.message}`);
    return mkBlock("by-file-reflections", "error", "", 0, err.message);
  }
}

async function loadGlobalReflectionsBlock(
  anchor: { type: string; reference: string },
): Promise<LearningContextBlock> {
  try {
    const relevant = await loadRelevantReflections(anchor);
    const formatted = formatReflectionsForPrompt(relevant);
    if (formatted) return mkBlock("global-reflections", "hit", formatted, relevant.length);
    return mkBlock("global-reflections", "miss", "", 0);
  } catch (err: any) {
    console.error(`[Learning] getContext: global reflections failed for "${anchor.reference}": ${err.message}`);
    return mkBlock("global-reflections", "error", "", 0, err.message);
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
 * The five sources, in prompt order (issue #804 added knowledge-base):
 *
 *   1. agent-memory             — promoted pattern lessons for `agent`
 *   2. knowledge-base           — OpenViking memory search (lifted out of the
 *                                 agent-memory block so OV is honestly
 *                                 attributed in the trace)
 *   3. per-anchor-reflections   — legacy verbatim-key match on `reference`
 *   4. by-file-reflections      — reflections from *other* anchors that
 *                                 touched the same files (issue #326)
 *   5. global-reflections       — Reflexion-style relevant reflections
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string; files?: string[] },
): Promise<LearningContext> {
  const blocks: LearningContextBlock[] = [];

  blocks.push(await loadAgentMemoryBlock(agent));
  blocks.push(await loadKnowledgeBaseBlock(agent));
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
  // Issue #1356 — flush the global reflection buffer into the per-anchor store
  // FIRST, so planning-time injection (loadAnchorReflections) sees the
  // reap-side failure narratives (#1119) instead of staying starved. Runs
  // before pattern/rule consolidation; best-effort, never throws.
  try {
    await consolidateReflections();
  } catch (err: any) {
    console.error(`[Learning] Reflection consolidation failed: ${err.message}`);
  }

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

