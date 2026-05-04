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
import { getCumulativeAccomplishments } from "./metrics.ts";
import { summarizeForPrompt, getDiff } from "./grounding.ts";
import { redisKeys } from "./redis-keys.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

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
  /** Per-source warnings for degraded loads */
  warnings: string[];
}

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

  // Quick-fix anchors skip most context — the anchor IS the entire scope
  if (isQuickFixAnchor) {
    return {
      priorities: "",
      feedback: "",
      plannerMemory: "",
      ovContext: "",
      milestoneContext: "",
      accomplishmentsContext: "",
      groundingSummary,
      continuityContext: "",
      warnings,
    };
  }

  // Load file-based context + agent memory/reflections + OV context in parallel
  const [priorities, feedback, plannerMemory, ovResult] = await Promise.all([
    loadSource("priorities", () =>
      readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8"), warnings),
    loadSource("feedback", () =>
      readFile(join(CONFIG_PATH, "feedback", "to-planner.md"), "utf-8"), warnings),
    loadSource("planner-context", () =>
      getContext("planner", anchor), warnings),
    loadSource("openviking-context", () =>
      ovSession?.getAgentContext?.("planner", anchor) || Promise.resolve({ formatted: "" }), warnings),
  ]);
  const ovContext = (ovResult as any)?.formatted || "";

  // Load milestone progress
  const milestoneContext = await loadSource("milestone-progress", async () => {
    const { _admin: backlogAdmin } = await import("./backlog.ts");
    const milestone = await backlogAdmin.getCurrentMilestoneProgress();
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

  return {
    priorities: priorities || "",
    feedback: feedback || "",
    plannerMemory: plannerMemory || "",
    ovContext,
    milestoneContext: milestoneContext || "",
    accomplishmentsContext: accomplishmentsContext || "",
    groundingSummary,
    continuityContext,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Continuity context — last cycle report, repo diff, episodic reflections
// ---------------------------------------------------------------------------

async function loadContinuityContext(
  anchor: { type: string; reference: string; [k: string]: any },
  warnings: string[],
): Promise<string> {
  const PROJECT_WORKSPACE = process.env.HYDRA_WORKSPACE || resolve(process.env.HOME, "hydra-betting");
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
  let rConn: any;
  try {
    const Redis = (await import("ioredis")).default;
    rConn = new (Redis as any)(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    const recentIds = await rConn.zrevrange(redisKeys.realityReportIndex(), 0, 0);
    if (recentIds.length === 0) return null;
    const raw = await rConn.get(redisKeys.realityReport(recentIds[0]));
    return raw ? JSON.parse(raw) : null;
  } catch (err: any) {
    console.error(`[ContextBuilder] loadLastCycleReportFull failed: ${err.message}`);
    return null;
  } finally {
    rConn?.disconnect();
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
