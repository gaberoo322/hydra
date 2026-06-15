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
import { loadAnchorReflections } from "./reflections/per-anchor.ts";
import {
  loadAnchorReflectionsByFile,
  backfillByFileIndex,
  extractFilesFromAnchor,
} from "./reflections/by-file.ts";
import { registerSkills } from "./knowledge-base/skill-registration.ts";
import { startKnowledgeIndexer } from "./knowledge-base/knowledge-indexer.ts";
// Issue #1440: per-cycle knowledge-context-availability tracking. The planner
// enrichment block below records whether the dispatch-time OV search produced
// non-empty context, so the health surface can trend it. Behind a best-effort
// wrapper so a Redis error never breaks planner-context assembly.
import { recordKnowledgeContextAvailability } from "./redis/ov-search-metrics.ts";

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
 *
 * Issue #1454: the `"global-reflections"` member was removed with the dead
 * global reflection buffer subsystem. getContext() now composes four blocks.
 */
export type LearningContextSource =
  | "agent-memory"
  | "knowledge-base"
  | "per-anchor-reflections"
  | "by-file-reflections";

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
 * The contract is the design-concept drop order (issue #1454 removed the
 * global-reflections head of the order with the dead buffer subsystem):
 *
 *   knowledge-base (0) → agent-memory (1) → by-file (2) → per-anchor (3)
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
  "knowledge-base": 0,
  "agent-memory": 1,
  "by-file-reflections": 2,
  "per-anchor-reflections": 3,
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
 * What every learning source's read returns: rendered prompt `content` and the
 * structured `itemCount` of items that contributed to it. Both are sourced
 * from the underlying data inside the source's own read (#804 count-from-data),
 * never re-derived from the rendered markdown at this seam. An empty `content`
 * means the source ran but had nothing to say (→ a `miss` block).
 */
export interface SourceRead {
  content: string;
  itemCount: number;
}

/**
 * Issue #1455 — the composition seam over a uniform per-source descriptor.
 * Each descriptor pairs a `source` name (the public trace key) with a `load`
 * thunk returning `{content,itemCount}`. The thunk owns its cluster-specific
 * work (per-anchor backfill side effect, by-file extract gate, OV availability
 * record); the seam owns only the composition contract — block envelope,
 * hit/miss/error mapping, ordering, and `dropPriority` stamping. Clusters never
 * import `LearningContextBlock` — they hand back the cluster-agnostic
 * `SourceRead` and the descriptor adapts it.
 */
export interface SourceDescriptor {
  source: LearningContextSource;
  load: () => Promise<SourceRead>;
}

/**
 * The one generic block loader (issue #1455). Runs a source descriptor's thunk
 * and maps its `{content,itemCount}` read into a `LearningContextBlock`,
 * stamping the within-bundle `dropPriority` from the frozen
 * `LEARNING_DROP_PRIORITY` table (issue #804 PR-B):
 *
 *   - thunk resolves with non-empty `content` → `hit` (itemCount from data)
 *   - thunk resolves with empty `content`     → `miss` (itemCount forced to 0)
 *   - thunk throws                            → `error` (content "", count 0)
 *
 * This replaces the four bespoke per-source block loaders: the hit/miss/error
 * envelope is defined ONCE here rather than re-hand-rolled per source. The
 * drop-order contract lives in exactly one place — every block flows through
 * here and inherits its priority by source, never by hand.
 */
export async function loadBlock(descriptor: SourceDescriptor): Promise<LearningContextBlock> {
  const { source, load } = descriptor;
  const dropPriority = LEARNING_DROP_PRIORITY[source];
  try {
    const { content, itemCount } = await load();
    if (content.length > 0) {
      return { source, status: "hit", content, itemCount, dropPriority };
    }
    return { source, status: "miss", content: "", itemCount: 0, dropPriority };
  } catch (err: any) {
    console.error(`[Learning] getContext: ${source} load failed: ${err.message}`);
    return { source, status: "error", content: "", itemCount: 0, dropPriority, error: err.message };
  }
}

/**
 * Best-effort, never-throw wrapper around the per-cycle context-availability
 * record (issue #1440). Observability must never break planner-context
 * assembly, so a Redis error here is logged and swallowed.
 */
async function recordContextAvailability(hadContext: boolean): Promise<void> {
  try {
    await recordKnowledgeContextAvailability(hadContext);
  } catch (err: any) {
    console.error(`[Learning] knowledge-context availability record failed: ${err?.message ?? err}`);
  }
}

/**
 * Load Pattern Memory + Reflections context for an agent + anchor.
 * Returns a structured trace: each source contributes a block with a
 * status ("hit" / "miss" / "error"). Never throws — sources degrade
 * individually (the one generic `loadBlock` maps each source's read into the
 * hit/miss/error envelope).
 *
 * The composed prompt string (what callers historically consumed) is
 * available via `result.toPrompt()`.
 *
 * `anchor.files` (optional) hints scope files for the by-file index
 * lookup. When omitted, file paths are extracted from `anchor.reference`.
 *
 * The four sources, in prompt order (issue #804 added knowledge-base; issue
 * #1454 removed the dead global-reflections block; issue #1455 collapsed the
 * four bespoke block loaders into one generic loader over these descriptors):
 *
 *   1. agent-memory             — promoted pattern lessons for `agent`; the
 *                                 itemCount is the rendered pattern-group count
 *                                 reported by formatMemoryForPrompt (from data,
 *                                 not a regex over the markdown).
 *   2. knowledge-base           — OpenViking memory search (lifted out of the
 *                                 agent-memory block so OV is honestly
 *                                 attributed in the trace); the thunk also
 *                                 records #1440 context availability.
 *   3. per-anchor-reflections   — legacy verbatim-key match on `reference`; the
 *                                 thunk keeps the opportunistic by-file backfill
 *                                 side effect on a hit.
 *   4. by-file-reflections      — reflections from *other* anchors that touched
 *                                 the same files (issue #326); the thunk keeps
 *                                 the extractFilesFromAnchor gate.
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string; files?: string[] },
): Promise<LearningContext> {
  const descriptors: SourceDescriptor[] = [
    {
      source: "agent-memory",
      load: async () => {
        const memory = await loadAgentMemory(agent);
        // formatMemoryForPrompt reports the rendered pattern-group count from
        // the structured blocks it assembles — the count-from-data source.
        return formatMemoryForPrompt(memory, agent);
      },
    },
    {
      source: "knowledge-base",
      load: async () => {
        const { loadKnowledgeBaseForPrompt } = await import("./knowledge-base/ov-search.ts");
        const read = await loadKnowledgeBaseForPrompt(agent);
        // Issue #1440: record per-cycle knowledge-context availability so the
        // operator can trend "what fraction of planned cycles saw non-empty
        // knowledge context". itemCount > 0 ⇔ the block had content. Best-effort
        // and never-throws — a Redis hiccup must not break context assembly.
        await recordContextAvailability(read.itemCount > 0);
        return read;
      },
    },
    {
      source: "per-anchor-reflections",
      load: async () => {
        const reflections = await loadAnchorReflections(anchor.reference);
        if (reflections.count === 0) return { content: "", itemCount: 0 };
        // Backfill on read: when an old reflection is hit by the legacy path,
        // opportunistically index it under by-file:. Side effect is intentional
        // and bounded — pre-#326 reflections age out at TTL.
        try {
          await backfillByFileIndex(anchor.reference, anchor.files);
        } catch (err: any) {
          console.error(`[Learning] getContext: by-file backfill failed for "${anchor.reference}": ${err.message}`);
        }
        return { content: reflections.content, itemCount: reflections.count };
      },
    },
    {
      source: "by-file-reflections",
      load: async () => {
        const files = extractFilesFromAnchor(anchor.reference, anchor.files);
        if (files.length === 0) return { content: "", itemCount: 0 };
        const byFile = await loadAnchorReflectionsByFile(files, anchor.reference);
        return { content: byFile.content, itemCount: byFile.count };
      },
    },
  ];

  // Sequential, in descriptor order: the per-anchor thunk's by-file backfill
  // side effect must commit BEFORE the by-file thunk reads the index (the
  // backfill-then-read ordering the bespoke loaders had). Running them
  // concurrently would let by-file miss a freshly-backfilled entry.
  const blocks: LearningContextBlock[] = [];
  for (const descriptor of descriptors) {
    blocks.push(await loadBlock(descriptor));
  }
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

  // 2. Register OV skills (non-blocking)
  registerSkills().catch((err: any) => console.error(`[Learning] Skill registration failed: ${err.message}`));

  // 3. Start knowledge indexer
  startKnowledgeIndexer();
}

