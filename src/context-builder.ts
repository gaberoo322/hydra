/**
 * context-builder.ts — Centralized Planner context assembly.
 *
 * Loads all context sources needed by the Planner agent into a single
 * PlannerContext object. Each source is loaded with explicit error handling:
 * a missing source produces a logged warning, not silent failure.
 *
 * Adding a new context source requires changes here only — planner-prompt.ts
 * and control-loop.ts consume the assembled PlannerContext without knowing
 * where individual sources come from.
 *
 * Depends on: agent-memory, metrics, grounding, backlog (dynamic),
 *             reflections, ioredis (for continuity), redis-keys
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getContext,
  reflectionTelemetry,
  type ReflectionSource,
  type LearningContext,
  type LearningContextBlock,
} from "./learning.ts";
import { getCumulativeAccomplishments } from "./metrics/aggregate.ts";
import { summarizeForPrompt, getDiff } from "./grounding.ts";
import {
  getRecentReportIdsDesc,
  getRealityReport,
} from "./redis/reality-reports.ts";
import { getTargetWorkspace } from "./target-config.ts";
import { findRelatedFiles } from "./repo-file-matcher.ts";
import { formatScopedFileTree } from "./repo-file-tree-format.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

// ---------------------------------------------------------------------------
// Context budget constants
// ---------------------------------------------------------------------------

export const CONTEXT_BUDGET = 12_000;  // chars
export const MIN_TRUNCATED = 500;      // minimum chars to keep when truncating

// ---------------------------------------------------------------------------
// Planner-context source registry (issue #819)
// ---------------------------------------------------------------------------
//
// Single in-module registry of the planner-context sources. Each source is
// declared ONCE, in priority order (highest-priority first; grounding is
// never truncated). Both SOURCE_PRIORITY (the ordered priority list consulted
// by applyContextBudget) and the rawSources array assembled in
// buildPlannerContext() are derived from this one list — adding a source means
// editing a single entry here, not keeping a separate constant and an array
// literal in sync by convention. This is a registration-consolidation refactor:
// the order, names, and budget behaviour are byte-identical to the prior
// hand-maintained pair.
//
/** One planner-context source's registration: stable name + priority slot. */
export interface PlannerSourceSpec {
  /** Stable source name (matches the ContextSource.name used by the budget). */
  readonly name: string;
}

/** Ordered, highest-priority-first. Index = priority (lower = higher priority). */
export const PLANNER_SOURCE_REGISTRY: readonly PlannerSourceSpec[] = [
  { name: "grounding" },
  { name: "scopedFileTree" }, // issue #366: real file paths next to grounding
                              // so the planner never falls back to hallucinated
                              // names
  { name: "feedback" },
  { name: "reflections" },    // plannerMemory contains reflections
  { name: "priorities" },
  { name: "memory" },         // ovContext
  { name: "accomplishments" },
  { name: "continuity" },
] as const;

/**
 * Priority order: highest-priority first (grounding is never truncated).
 * Derived from PLANNER_SOURCE_REGISTRY so there is exactly one place to edit
 * when a source is added — no second hand-maintained list to drift out of sync.
 */
export const SOURCE_PRIORITY: readonly string[] =
  PLANNER_SOURCE_REGISTRY.map((s) => s.name);

/**
 * Token budget for the per-anchor scoped file-tree block injected into the
 * planner prompt (issue #366). Approximation is the same ~4-chars-per-token
 * heuristic used in repo-file-tree-format.ts, so 2000 tokens ≈ 8000 chars max.
 */
export const SCOPED_FILE_TREE_TOKEN_BUDGET = 2000;

/** Maximum number of files listed in the scoped file-tree block. */
export const SCOPED_FILE_TREE_LIMIT = 50;

// ---------------------------------------------------------------------------
// applyContextBudget — pure, testable truncation logic
// ---------------------------------------------------------------------------

export interface ContextSource {
  name: string;
  content: string;
}

/**
 * Truncate lower-priority sources so total char count fits within budget.
 * Higher-index sources are truncated first (lowest priority = last in array).
 * Sources are returned in the same order. Truncated sources keep at least
 * `minTruncated` chars plus a truncation notice.
 */
export function applyContextBudget(
  sources: ContextSource[],
  budget: number = CONTEXT_BUDGET,
  minTruncated: number = MIN_TRUNCATED,
): ContextSource[] {
  let total = sources.reduce((sum, s) => sum + s.content.length, 0);
  if (total <= budget) return sources;

  // Build a priority-indexed lookup: lower index = higher priority
  const priorityIndex = new Map<string, number>();
  SOURCE_PRIORITY.forEach((name, i) => priorityIndex.set(name, i));

  // Sort indices by priority ascending (lowest priority first for truncation)
  const indices = sources.map((_, i) => i);
  indices.sort((a, b) => {
    const pa = priorityIndex.get(sources[a].name) ?? SOURCE_PRIORITY.length;
    const pb = priorityIndex.get(sources[b].name) ?? SOURCE_PRIORITY.length;
    return pb - pa; // highest index = lowest priority = truncate first
  });

  const result = sources.map((s) => ({ ...s }));

  for (const idx of indices) {
    if (total <= budget) break;
    const src = result[idx];
    // Never truncate the highest-priority source (grounding)
    if (priorityIndex.get(src.name) === 0) continue;
    if (src.content.length <= minTruncated) continue;

    const originalLen = src.content.length;
    const notice = `\n... (truncated from ${originalLen} chars)`;
    const keepChars = Math.max(minTruncated, src.content.length - (total - budget));
    if (keepChars < src.content.length) {
      const saved = src.content.length - keepChars;
      src.content = src.content.slice(0, keepChars) + notice;
      total -= saved - notice.length;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Block-aware budget for the learning source (issue #804 PR-B)
// ---------------------------------------------------------------------------
//
// The learning bundle (the `reflections` planner-context source) is the one
// source whose content is a *composition* of independently-meaningful blocks
// (agent-memory, knowledge-base, per-anchor / by-file / global reflections).
// The monolithic char-slice in applyContextBudget can sever a reflection body
// while leaving its header intact — corrupting the post-budget count and, worse,
// handing the planner half a reflection. PR-B replaces that slice (for the
// learning source ONLY — the other 7 sources stay monolithic strings) with a
// whole-block drop: shed entire blocks lowest-dropPriority-first until the
// bundle fits, never cutting mid-block. The surviving blocks are the exact set
// the planner sees, so reflection telemetry is read off them post-budget.

/** The name of the planner-context source carrying the learning bundle. */
export const LEARNING_SOURCE_NAME = "reflections";

/**
 * Wrap a list of blocks as a minimal LearningContext so reflectionTelemetry
 * (which reads `.blocks` only) can be computed off the post-budget survivors.
 * toPrompt() mirrors the canonical hit-join in case a caller renders it.
 */
function buildContextFromBlocks(blocks: LearningContextBlock[]): LearningContext {
  return {
    blocks,
    toPrompt: () =>
      blocks
        .filter((b) => b.status === "hit" && b.content.length > 0)
        .map((b) => b.content)
        .join("\n\n"),
  };
}

/**
 * Render a list of hit learning blocks to the prompt string, using the same
 * `\n\n` separator as LearningContext.toPrompt(). Miss/error blocks (empty
 * content) are skipped. `excludeSources` drops named sources from the rendering
 * WITHOUT dropping them from the trace — used to dedupe OpenViking when the
 * separate `memory` source already injects it (invariant: OV injected once).
 */
function renderLearningBlocks(
  blocks: LearningContextBlock[],
  excludeSources: ReadonlySet<string> = new Set(),
): string {
  return blocks
    .filter((b) => b.status === "hit" && b.content.length > 0 && !excludeSources.has(b.source))
    .map((b) => b.content)
    .join("\n\n");
}

/**
 * Drop whole learning blocks lowest-dropPriority-first until the rendered
 * bundle fits within `learningBudget` chars. Never slices a block mid-text.
 *
 * Returns the surviving hit-blocks (in their original order) plus the rendered
 * string. Invariant (#193): because per-anchor-reflections carries the highest
 * dropPriority, it is the LAST learning block shed — retry correctness holds.
 * If a single surviving block still exceeds the budget, it is kept whole rather
 * than sliced: a truncated reflection is worse than an over-budget one, and the
 * monolithic sources still absorb the remaining pressure via applyContextBudget.
 *
 * Exported for direct unit testing of the drop order and the never-slice
 * guarantee — the brittle header-regex tests it replaces are deleted.
 */
export function applyLearningBlockBudget(
  blocks: LearningContextBlock[],
  learningBudget: number,
  excludeSources: ReadonlySet<string> = new Set(),
): { survivors: LearningContextBlock[]; content: string } {
  // Only hit blocks with content contribute to the prompt (and to the budget).
  const hits = blocks.filter(
    (b) => b.status === "hit" && b.content.length > 0 && !excludeSources.has(b.source),
  );

  const survive = new Set(hits);
  const rendered = () =>
    [...survive]
      // preserve original block order in the output
      .sort((a, b) => blocks.indexOf(a) - blocks.indexOf(b))
      .map((b) => b.content)
      .join("\n\n");

  const size = () => rendered().length;

  // Candidates to drop, lowest dropPriority (dropped first) → highest (last).
  const dropOrder = [...hits].sort((a, b) => a.dropPriority - b.dropPriority);

  for (const block of dropOrder) {
    if (size() <= learningBudget) break;
    // Keep at least one block — if only one survivor remains, stop dropping
    // (a lone over-budget block is kept whole; never sliced).
    if (survive.size <= 1) break;
    survive.delete(block);
  }

  const survivors = blocks.filter((b) => survive.has(b));
  return { survivors, content: rendered() };
}

// ---------------------------------------------------------------------------
// PlannerContext — all context sources needed by the Planner agent
// ---------------------------------------------------------------------------

export interface PlannerContext {
  /** Operator priorities from config/direction/priorities.md */
  priorities: string;
  /** Operator feedback from config/feedback/to-planner.md */
  feedback: string;
  /** Agent memory patterns for the planner */
  plannerMemory: string;
  /** OpenViking compiled context (resources + memories relevant to this anchor) */
  ovContext: string;
  /** Milestone progress summary */
  milestoneContext: string;
  /** Cumulative accomplishments (to prevent re-proposing completed work) */
  accomplishmentsContext: string;
  /** Grounding summary formatted for prompt injection */
  groundingSummary: string;
  /** Continuity context: last cycle report + repo diff + reflections */
  continuityContext: string;
  /**
   * Issue #366: token-bounded list of real file paths relevant to the anchor
   * reference. Empty string when the anchor produced no recognizable tokens
   * (e.g. doc anchors) or when grounding has no `fileTree`. Listed paths are
   * guaranteed to exist on disk at grounding time — the planner can use them
   * directly in `scopeBoundary.in` without risking the preflight "non-existent
   * file" rejection that historically ate ~11% of abandoned cycles.
   */
  scopedFileTree: string;
  /** Per-source warnings for degraded loads */
  warnings: string[];
  /**
   * Issue #221: Reflection injection telemetry. Set whenever reflections were
   * actually present in the assembled prompt (after budget truncation). Used by
   * planner-prompt.ts to tag the resulting task and by metric writers to
   * compute the reflectionInjected/reflectionCount/reflectionSources fields.
   */
  reflectionInjected: number;
  /** Which reflection sources contributed: "per-anchor" and/or "global". */
  reflectionSources: ReflectionSource[];
}

// Issue #804: ReflectionSource now lives in learning.ts (the composition seam
// that owns the reflection blocks). Re-exported here so existing importers of
// `context-builder.ts`'s ReflectionSource keep working unchanged.
export type { ReflectionSource };

// ---------------------------------------------------------------------------
// buildPlannerContext — loads all context sources with graceful degradation
// ---------------------------------------------------------------------------

export async function buildPlannerContext(
  anchor: { type: string; reference: string; [k: string]: any },
  grounding: any,
  ovSession: any = null,
): Promise<PlannerContext> {
  const warnings: string[] = [];
  const isQuickFixAnchor = anchor.type === "failing-test" || anchor.type === "prior-failure";

  // Grounding summary — always loaded
  let groundingSummary = "";
  try {
    groundingSummary = summarizeForPrompt(grounding);
  } catch (err: any) {
    console.error(`[ContextBuilder] Grounding summary failed: ${err.message}`);
    warnings.push("grounding-summary: failed");
  }

  // Quick-fix anchors skip most context — the anchor IS the entire scope.
  // EXCEPTION (issue #193): Episodic reflections MUST be loaded for retries,
  // otherwise the planner produces the same plan that failed last time. Without
  // this, prior-failure retries had a 0% merge rate (measured 2026-05-09).
  if (isQuickFixAnchor) {
    // Issue #804: capture the structured LearningContext so telemetry is read
    // off the typed blocks (reflectionTelemetry), not regex-scanned out of the
    // flattened prompt string. getContext() never throws — sources degrade
    // individually — so the loadSource wrapper is just here for symmetry/logging.
    let learningCtx = await loadSource("planner-context", () => getContext("planner", anchor), warnings);
    if (!learningCtx) learningCtx = (await getContext("planner", anchor));
    const plannerMemory = learningCtx.toPrompt();
    const reflectionStats = reflectionTelemetry(learningCtx);
    if (reflectionStats.count > 0) {
      console.log(`[Planner] Injected ${reflectionStats.count} reflection(s) for anchor "${anchor.reference.slice(0, 80)}" (type=${anchor.type}, sources=${reflectionStats.sources.join(",")})`);
    }
    return {
      priorities: "",
      feedback: "",
      plannerMemory,
      ovContext: "",
      milestoneContext: "",
      accomplishmentsContext: "",
      groundingSummary,
      continuityContext: "",
      // Quick-fix anchors already name the exact file in the anchor reference
      // (failing-test path / prior-failure title). The planner doesn't need a
      // file-tree snapshot — it has the file. Keep prompts cheap.
      scopedFileTree: "",
      warnings,
      reflectionInjected: reflectionStats.count,
      reflectionSources: reflectionStats.sources,
    };
  }

  // Load file-based context + agent memory/reflections + OV context in parallel.
  // Issue #804: getContext returns the structured LearningContext; we keep the
  // object (for typed reflection telemetry) and flatten to a string separately.
  const [priorities, feedback, learningCtx, ovResult] = await Promise.all([
    loadSource("priorities", () =>
      readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8"), warnings),
    loadSource("feedback", () =>
      readFile(join(CONFIG_PATH, "feedback", "to-planner.md"), "utf-8"), warnings),
    loadSource("planner-context", () => getContext("planner", anchor), warnings),
    loadSource("openviking-context", () =>
      ovSession?.getAgentContext?.("planner", anchor) || Promise.resolve({ formatted: "" }), warnings),
  ]);
  const ovContext = (ovResult as any)?.formatted || "";

  // Issue #804 PR-B: OpenViking is injected exactly once. The `memory` source
  // (ovSession.getAgentContext — resources + memories) is the richer OV surface
  // and occupies its own priority slot, so when it fires we drop the learning
  // bundle's `knowledge-base` block from the *prompt rendering* (NOT from the
  // trace — getContext()'s blocks are untouched, so /api/learning/context-trace
  // still honestly reports the KB block). When `memory` is empty (no OV session,
  // or it returned nothing) the KB block is the only OV surface and is kept.
  const learningExclude = new Set<string>();
  if (ovContext.length > 0) learningExclude.add("knowledge-base");

  // Load milestone progress
  const milestoneContext = await loadSource("milestone-progress", async () => {
    const { getCurrentMilestoneProgress } = await import("./backlog/reads.ts");
    const milestone = await getCurrentMilestoneProgress();
    if (!milestone) return "";
    const remaining = milestone.remainingTitles.slice(0, 5).join(", ");
    return `## CURRENT MILESTONE\n${milestone.name} — ${milestone.pctComplete}% complete (${milestone.done}/${milestone.total} epics done, ${milestone.blocked} blocked)\nRemaining epics: ${remaining}\nFocus your task on completing this milestone's remaining epics.\n`;
  }, warnings);

  // Load cumulative accomplishments
  const accomplishmentsContext = await loadSource("accomplishments", async () => {
    const acc = await getCumulativeAccomplishments(10);
    if (acc.length === 0) return "";
    return `## ALREADY ACCOMPLISHED (do NOT re-propose these)\n${acc.map((a) => `- "${a.title}"`).join("\n")}\n`;
  }, warnings);

  // Load continuity context (last cycle report + repo diff)
  const continuityContext = await loadContinuityContext(anchor, warnings);

  // Issue #366: build the scoped file-tree block from grounding.fileTree.
  // This is cheap (string scan over the same ls-files output grounding
  // already produces) and bounded, so it runs synchronously here rather than
  // through loadSource. When the anchor reference has no recognizable tokens
  // (doc anchors, opaque IDs) findRelatedFiles returns []. We then emit an
  // empty string so the prompt doesn't bloat with a useless header.
  const scopedFileTree = buildScopedFileTree(anchor, grounding);

  // --- Context budget: measure, log, truncate if needed ---
  // Issue #819: rawSources is derived from PLANNER_SOURCE_REGISTRY (the single
  // source-of-truth for source names + order) by mapping each registered name
  // to its loaded content. This makes the assembled source-name list and
  // SOURCE_PRIORITY structurally identical — adding a source can no longer
  // drift the two apart.
  //
  // Issue #804 PR-B: the learning bundle (`reflections` source) is budgeted
  // block-wise BEFORE the monolithic char-budget runs. We give it the residual
  // budget left by the other (non-learning) sources, drop whole blocks
  // lowest-dropPriority-first to fit, and read reflection telemetry off the
  // SURVIVING blocks so the count is exact post-budget (no mid-text slice can
  // corrupt a reflection header). The block-budgeted string then enters
  // applyContextBudget alongside the monolithic sources; because it already
  // fits its share, the slice path leaves it alone (unless the non-learning
  // sources alone blow the whole budget, in which case the lower-priority
  // monolithic sources absorb the pressure first — `reflections` outranks
  // priorities/memory/accomplishments/continuity).
  const monolithicByName: Record<string, string> = {
    grounding: groundingSummary,
    scopedFileTree,
    feedback: feedback || "",
    priorities: priorities || "",
    memory: ovContext,
    accomplishments: (accomplishmentsContext || "") + (milestoneContext || ""),
    continuity: continuityContext,
  };
  const monolithicTotal = Object.values(monolithicByName).reduce((sum, c) => sum + c.length, 0);

  // Residual budget for the learning bundle = whole budget minus everything
  // else, floored at MIN_TRUNCATED so a single reflection always survives.
  const learningBudget = Math.max(MIN_TRUNCATED, CONTEXT_BUDGET - monolithicTotal);
  const learningBlocks = learningCtx ? learningCtx.blocks : [];
  const { survivors: survivingBlocks, content: plannerMemory } = applyLearningBlockBudget(
    learningBlocks,
    learningBudget,
    learningExclude,
  );

  // Issue #804 PR-B: reflection accounting is derived from the SURVIVING blocks
  // — exact post-budget. reflectionTelemetry only counts the three reflection
  // sources, so the knowledge-base exclusion above never affects the count.
  const reflectionStats: { count: number; sources: ReflectionSource[] } = reflectionTelemetry(
    buildContextFromBlocks(survivingBlocks),
  );

  const contentByName: Record<string, string> = {
    ...monolithicByName,
    reflections: plannerMemory || "",
  };
  const rawSources: ContextSource[] = PLANNER_SOURCE_REGISTRY.map((spec) => ({
    name: spec.name,
    content: contentByName[spec.name] ?? "",
  }));

  const sourceSizes: Record<string, number> = {};
  for (const s of rawSources) sourceSizes[s.name] = s.content.length;
  const total = rawSources.reduce((sum, s) => sum + s.content.length, 0);
  console.log(`[ContextBuilder] Source sizes: ${JSON.stringify(sourceSizes)}`);
  console.log(`[ContextBuilder] Total context: ${total} chars (budget: ${CONTEXT_BUDGET})`);

  const budgeted = applyContextBudget(rawSources);

  // Map budgeted sources back to PlannerContext fields
  const byName = new Map(budgeted.map((s) => [s.name, s.content]));

  // Issue #193: log reflection injection count so production logs show whether
  // reflections actually reached the planner (previously silent for quick-fix).
  // Issue #804 PR-B: count + sources are read off the SURVIVING structured
  // blocks (reflectionStats, computed above) — exact post-budget, never
  // regex-scanned out of the budgeted markdown string.
  const finalPlannerMemory = byName.get("reflections") ?? "";
  if (reflectionStats.count > 0) {
    console.log(`[Planner] Injected ${reflectionStats.count} reflection(s) for anchor "${anchor.reference.slice(0, 80)}" (type=${anchor.type}, sources=${reflectionStats.sources.join(",")})`);
  }

  return {
    priorities: byName.get("priorities") ?? "",
    feedback: byName.get("feedback") ?? "",
    plannerMemory: finalPlannerMemory,
    ovContext: byName.get("memory") ?? "",
    milestoneContext: milestoneContext || "",
    accomplishmentsContext: byName.get("accomplishments") ?? "",
    groundingSummary: byName.get("grounding") ?? "",
    continuityContext: byName.get("continuity") ?? "",
    scopedFileTree: byName.get("scopedFileTree") ?? "",
    warnings,
    reflectionInjected: reflectionStats.count,
    reflectionSources: reflectionStats.sources,
  };
}

/**
 * Issue #366: build the scoped file-tree block for the planner prompt.
 *
 * Exported for unit tests so the file-tree contract is locked separately
 * from the full async buildPlannerContext pipeline. The function is pure
 * (no I/O, no Redis, no logging) and never throws — bad input returns "".
 *
 * Inputs:
 *   - anchor.reference: tokenized for relevance scoring
 *   - grounding.fileTree: newline-separated `git ls-files` output
 *
 * Output: a labelled block ready to drop into the planner prompt, or "" when
 * there's nothing useful to inject. The block always starts with the marker
 * `## SCOPED FILE TREE` and ends with a one-liner reminding the planner that
 * the listed paths are real and should be preferred for `scopeBoundary.in`.
 */
export function buildScopedFileTree(
  anchor: { reference?: string; [k: string]: any },
  grounding: { fileTree?: string; [k: string]: any },
): string {
  if (!anchor || typeof anchor.reference !== "string") return "";
  if (!grounding || typeof grounding.fileTree !== "string" || grounding.fileTree.length === 0) {
    return "";
  }
  const lines = grounding.fileTree.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";

  const related = findRelatedFiles(anchor.reference, lines, SCOPED_FILE_TREE_LIMIT);
  if (related.length === 0) return "";

  const body = formatScopedFileTree(related, SCOPED_FILE_TREE_TOKEN_BUDGET);
  if (!body) return "";

  return [
    `## SCOPED FILE TREE (real paths relevant to "${anchor.reference}" — DO NOT invent file names)`,
    body,
    `# These paths exist on disk at grounding time. Prefer them for scopeBoundary.in.`,
    `# Files the executor will CREATE go in scopeBoundary.creates, not "in".`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Continuity context — last cycle report, repo diff, episodic reflections
// ---------------------------------------------------------------------------

async function loadContinuityContext(
  anchor: { type: string; reference: string; [k: string]: any },
  warnings: string[],
): Promise<string> {
  const PROJECT_WORKSPACE = getTargetWorkspace();
  let continuityContext = "";

  // Last cycle report (single fetch, format separately)
  const lastCycleReport = await loadSource("continuity-report", () => loadLastCycleReportFull(), warnings);
  const lastReport = lastCycleReport ? formatCycleReport(lastCycleReport) : null;
  if (lastReport) {
    if (lastCycleReport?.commitSha) {
      try {
        const { diff: diffSince, stat: diffStat } = await getDiff(PROJECT_WORKSPACE, lastCycleReport.commitSha);
        const diffLines = diffSince.split("\n").length;
        continuityContext = `## CONTINUITY (what happened since last cycle)\n${lastReport}\n\nRepo changes since last cycle commit (${lastCycleReport.commitSha.slice(0, 7)}): ${diffLines} diff lines\n`;
        if (diffLines > 0 && diffLines < 200) {
          continuityContext += `Diff stat:\n${diffStat}\n`;
        }
      } catch (err: any) {
        console.error(`[ContextBuilder] Continuity diff failed, using simpler context: ${err.message}`);
        continuityContext = `## CONTINUITY\n${lastReport}\n`;
      }
    } else {
      continuityContext = `## CONTINUITY\n${lastReport}\n`;
    }
  }

  // Episodic reflections and global reflections are now loaded via
  // getContext() in buildPlannerContext() and included in plannerMemory.

  return continuityContext;
}

// ---------------------------------------------------------------------------
// loadLastCycleReport / loadLastCycleReportFull — moved from control-loop.ts
// ---------------------------------------------------------------------------

function formatCycleReport(report: any): string {
  return [
    `Last cycle: ${report.cycleId}`,
    `Task: "${report.task?.title}" → ${report.task?.finalState}`,
    `Tests: ${report.grounding?.before?.passed} → ${report.grounding?.after?.passed}`,
    report.regressionIntroduced ? "WARNING: Regression introduced" : "No regression",
    `Commit: ${report.commitSha || "none"}`,
    report.rollbackRisk ? `Rollback risk: ${report.rollbackRisk}` : "",
    report.filesChanged?.length > 0 ? `Files changed: ${report.filesChanged.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

async function loadLastCycleReportFull(): Promise<any> {
  try {
    const recentIds = await getRecentReportIdsDesc(1);
    if (recentIds.length === 0) return null;
    const raw = await getRealityReport(recentIds[0]);
    return raw ? JSON.parse(raw) : null;
  } catch (err: any) {
    console.error(`[ContextBuilder] loadLastCycleReportFull failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// loadSource — generic loader with error handling and warning collection
// ---------------------------------------------------------------------------

async function loadSource<T>(name: string, loader: () => Promise<T>, warnings: string[]): Promise<T | ""> {
  try {
    const result = await loader();
    return result ?? "";
  } catch (err: any) {
    console.error(`[ContextBuilder] ${name} failed: ${err.message}`);
    warnings.push(`${name}: ${err.message}`);
    return "";
  }
}
