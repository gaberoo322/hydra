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
import { getContext } from "./learning.ts";
import { getCumulativeAccomplishments } from "./metrics/aggregate.ts";
import { summarizeForPrompt, getDiff } from "./grounding.ts";
import {
  getRecentReportIdsDesc,
  getRealityReport,
} from "./redis/reality-reports.ts";
import { getTargetWorkspace } from "./target-config.ts";
import { findRelatedFiles, formatScopedFileTree } from "./repo-map.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

// ---------------------------------------------------------------------------
// Context budget constants
// ---------------------------------------------------------------------------

export const CONTEXT_BUDGET = 12_000;  // chars
export const MIN_TRUNCATED = 500;      // minimum chars to keep when truncating

/** Priority order: highest-priority first (grounding is never truncated). */
export const SOURCE_PRIORITY: readonly string[] = [
  "grounding",
  "scopedFileTree", // issue #366: real file paths next to grounding so the
                    // planner never falls back to hallucinated names
  "feedback",
  "reflections",    // plannerMemory contains reflections
  "priorities",
  "memory",         // ovContext
  "accomplishments",
  "continuity",
] as const;

/**
 * Token budget for the per-anchor scoped file-tree block injected into the
 * planner prompt (issue #366). Approximation is the same ~4-chars-per-token
 * heuristic used in repo-map.ts, so 2000 tokens ≈ 8000 chars max.
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

export type ReflectionSource = "per-anchor" | "global" | "by-file";

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
    const plannerMemory = await loadSource("planner-context", async () =>
      (await getContext("planner", anchor)).toPrompt(), warnings) || "";
    const reflectionStats = inspectReflections(plannerMemory as string);
    if (reflectionStats.count > 0) {
      console.log(`[Planner] Injected ${reflectionStats.count} reflection(s) for anchor "${anchor.reference.slice(0, 80)}" (type=${anchor.type}, sources=${reflectionStats.sources.join(",")})`);
    }
    return {
      priorities: "",
      feedback: "",
      plannerMemory: plannerMemory as string,
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

  // Load file-based context + agent memory/reflections + OV context in parallel
  const [priorities, feedback, plannerMemory, ovResult] = await Promise.all([
    loadSource("priorities", () =>
      readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8"), warnings),
    loadSource("feedback", () =>
      readFile(join(CONFIG_PATH, "feedback", "to-planner.md"), "utf-8"), warnings),
    loadSource("planner-context", async () =>
      (await getContext("planner", anchor)).toPrompt(), warnings),
    loadSource("openviking-context", () =>
      ovSession?.getAgentContext?.("planner", anchor) || Promise.resolve({ formatted: "" }), warnings),
  ]);
  const ovContext = (ovResult as any)?.formatted || "";

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
  const rawSources: ContextSource[] = [
    { name: "grounding", content: groundingSummary },
    { name: "scopedFileTree", content: scopedFileTree },
    { name: "feedback", content: feedback || "" },
    { name: "reflections", content: plannerMemory || "" },
    { name: "priorities", content: priorities || "" },
    { name: "memory", content: ovContext },
    { name: "accomplishments", content: (accomplishmentsContext || "") + (milestoneContext || "") },
    { name: "continuity", content: continuityContext },
  ];

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
  const finalPlannerMemory = byName.get("reflections") ?? "";
  const reflectionStats = inspectReflections(finalPlannerMemory);
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

/**
 * Count reflection blocks in formatted planner context.
 * Looks for the "PRIOR ATTEMPTS" header (per-anchor) and "Recent Failures"
 * header (global). Used for telemetry and the reflectionInjected metric.
 */
export function countReflections(plannerMemory: string): number {
  return inspectReflections(plannerMemory).count;
}

/**
 * Inspect reflection content in formatted planner context. Returns both the
 * total count and the list of contributing sources ("per-anchor" / "global").
 *
 * Issue #221: previously only the total count was exposed; the metric pipeline
 * could not distinguish which reflection sources reached the planner.
 */
export function inspectReflections(plannerMemory: string): {
  count: number;
  sources: ReflectionSource[];
} {
  if (!plannerMemory) return { count: 0, sources: [] };
  let count = 0;
  const sources: ReflectionSource[] = [];
  // Per-anchor reflections format: "## PRIOR ATTEMPTS (N previous failures...)"
  const priorMatch = plannerMemory.match(/## PRIOR ATTEMPTS \((\d+) previous failures?/);
  if (priorMatch) {
    const n = parseInt(priorMatch[1], 10) || 0;
    if (n > 0) {
      count += n;
      sources.push("per-anchor");
    }
  }
  // By-file reflections (issue #326) format:
  // "## RELATED FILES — Prior Failures (N matched by file)"
  const byFileMatch = plannerMemory.match(/## RELATED FILES — Prior Failures \((\d+) matched by file/);
  if (byFileMatch) {
    const n = parseInt(byFileMatch[1], 10) || 0;
    if (n > 0) {
      count += n;
      sources.push("by-file");
    }
  }
  // Global reflections format: each reflection starts with "### <cycleId>"
  // under a "## Recent Failures" section
  const recentIdx = plannerMemory.indexOf("## Recent Failures");
  if (recentIdx >= 0) {
    const recentSection = plannerMemory.slice(recentIdx);
    const matches = recentSection.match(/^### /gm);
    if (matches && matches.length > 0) {
      count += matches.length;
      sources.push("global");
    }
  }
  return { count, sources };
}

/**
 * Issue #326: derive a single-token `reflectionMatchSource` value for cycle
 * metrics from the source list. Buckets:
 *
 *   - "none"        — no reflections injected
 *   - "by-anchor"   — only per-anchor (legacy primary key) matched
 *   - "by-file"     — only the file-based secondary index matched
 *   - "both"        — both per-anchor and by-file matched
 *   - "global"      — only the global recent-failures buffer matched
 *   - "mixed"       — any other combination involving global + one specific
 *
 * Kept narrow on purpose so the metric remains dashboardable as a categorical
 * field rather than a free-form list.
 */
export function reflectionMatchSource(sources: ReflectionSource[]): string {
  if (!Array.isArray(sources) || sources.length === 0) return "none";
  const hasPerAnchor = sources.includes("per-anchor");
  const hasByFile = sources.includes("by-file");
  const hasGlobal = sources.includes("global");
  if (hasPerAnchor && hasByFile && !hasGlobal) return "both";
  if (hasPerAnchor && !hasByFile && !hasGlobal) return "by-anchor";
  if (!hasPerAnchor && hasByFile && !hasGlobal) return "by-file";
  if (!hasPerAnchor && !hasByFile && hasGlobal) return "global";
  return "mixed";
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
