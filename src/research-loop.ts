/**
 * Research Loop
 *
 * Phase A (#342): in-process codex research agents removed. Research is now
 * driven by the /hydra-target-research skill. The helpers below
 * (normalizeOpportunity, parseAgentJson, generateResearchId,
 * validatePrerequisites, loadMethodologyOverrides, loadLastResearchReport,
 * scoreLastResearchOutcomes, listResearchReports, getLatestResearch,
 * vetoOpportunity) are still consumed by dashboard read-paths and by
 * /hydra-target-research output normalization.
 *
 * The `runResearchLoop()` no-op shim was deleted in #706 (scheduler fold
 * PR-1/4) along with the in-process scheduler research-decision plane that
 * was its only scheduler-side caller. The research-force policy now lives
 * entirely in the autopilot brain (`scripts/autopilot/decide.py`
 * `_research_force_allowed`).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getMetricsTrend } from "./metrics/trend.ts";
import {
  getRecentResearchIds,
  getResearchReport as getResearchReportAdapter,
} from "./redis/research-reports.ts";
import { getWorkQueueItems, removeFromWorkQueue } from "./redis/work-queue.ts";
import { getTargetWorkspace } from "./target-config.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const PROJECT_WORKSPACE = getTargetWorkspace();
const METHODOLOGY_DIR = join(CONFIG_PATH, "research");

/**
 * Validate that an opportunity's prerequisites exist in the target codebase.
 * Returns { valid: true } if all prerequisites map to real files/modules/functions,
 * or { valid: false, missing: [...] } if some cannot be found.
 *
 * This prevents auto-queuing items that agents cannot implement because the
 * foundational code doesn't exist yet.
 */
async function validatePrerequisites(prerequisites: string[]): Promise<{ valid: boolean; missing: string[] }> {
  if (!prerequisites || prerequisites.length === 0) return { valid: true, missing: [] };

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const missing: string[] = [];

  for (const prereq of prerequisites) {
    // Extract searchable terms: file paths, module names, function names, class names
    // Strip common filler words to get the core concept
    const searchTerms = extractSearchTerms(prereq);
    if (searchTerms.length === 0) continue;

    let found = false;
    for (const term of searchTerms) {
      try {
        const { stdout } = await execFileAsync("grep", ["-rl", "--include=*.ts", term, PROJECT_WORKSPACE + "/web/src"], { timeout: 5000 });
        if (stdout.trim().length > 0) {
          found = true;
          break;
        }
      } catch { /* intentional: grep returns exit 1 when no matches — expected, treat as not-found */ }
    }
    if (!found) missing.push(prereq);
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Extract grep-able search terms from a prerequisite description.
 * Looks for camelCase identifiers, file paths, and hyphenated module names.
 */
function extractSearchTerms(prereq: string): string[] {
  const terms: string[] = [];

  // Match camelCase or PascalCase identifiers (e.g., "getAccountLimits", "ArbitrageRunPacket")
  const identifiers = prereq.match(/[A-Z]?[a-z]+(?:[A-Z][a-z]+)+/g) || [];
  terms.push(...identifiers);

  // Match file-path-like segments (e.g., "kalshi-orderbooks/orderbooks.ts")
  const paths = prereq.match(/[\w-]+(?:\/[\w-]+)*\.ts/g) || [];
  terms.push(...paths);

  // Match hyphenated module names (e.g., "arbitrage-replay-runner", "scanner-sizing")
  const hyphenated = prereq.match(/[a-z]+-[a-z]+(?:-[a-z]+)*/g) || [];
  terms.push(...hyphenated.filter(h => h.length > 5));

  // Deduplicate
  return [...new Set(terms)];
}

function generateResearchId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `research-${date}-${hour}${min}`;
}

/**
 * Load methodology overrides written by the Research Architect.
 * These are appended to researcher prompts to improve quality over time.
 */
async function loadMethodologyOverrides(researcherName) {
  try {
    const content = await readFile(join(METHODOLOGY_DIR, `${researcherName}.md`), "utf-8");
    return content.trim();
  } catch {
    return "";
  }
}

/**
 * Load the most recent research report for continuity.
 */
async function loadLastResearchReport() {
  try {
    const ids = await getRecentResearchIds(1);
    if (ids.length === 0) return null;
    const raw = await getResearchReportAdapter(ids[0]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Score outcomes of the previous research cycle's recommendations.
 * Checks what happened to each item: merged, failed, abandoned, still-queued.
 * Returns a formatted scorecard for the Director to learn from.
 */
async function scoreLastResearchOutcomes(): Promise<string> {
  try {
    const lastReport = await loadLastResearchReport();
    if (!lastReport?.synthesis?.opportunities) return "";

    const titles = (lastReport.synthesis.opportunities as any[]).map(o => o.title);
    if (titles.length === 0) return "";

    // Check metrics for matching task titles
    const trend = await getMetricsTrend(50);
    const merged: string[] = [];
    const failed: string[] = [];
    const abandoned: string[] = [];
    const stillQueued: string[] = [];

    for (const title of titles) {
      const titleLower = title.toLowerCase();
      const match = trend.find(m => {
        const taskTitle = (m.taskTitle || "").toLowerCase();
        // Fuzzy match: check if significant words overlap
        const titleWords = new Set(titleLower.split(/\s+/).filter((w: string) => w.length > 3));
        const taskWords = new Set(taskTitle.split(/\s+/).filter((w: string) => w.length > 3));
        if (titleWords.size === 0 || taskWords.size === 0) return false;
        const overlap = [...titleWords].filter((w: string) => taskWords.has(w)).length;
        return overlap / Math.max(titleWords.size, taskWords.size) > 0.5;
      });

      if (match) {
        if (parseInt(match.tasksMerged as string) > 0) merged.push(title);
        else if (parseInt(match.tasksFailed as string) > 0) failed.push(title);
        else if (parseInt(match.tasksAbandoned as string) > 0) abandoned.push(title);
      } else {
        stillQueued.push(title);
      }
    }

    const total = titles.length;
    const mergeRate = total > 0 ? Math.round((merged.length / total) * 100) : 0;

    const lines = [
      `## PREVIOUS RESEARCH OUTCOMES (learn from these)`,
      `Research cycle ${lastReport.researchId} produced ${total} items. Merge rate: ${mergeRate}%`,
    ];

    if (merged.length > 0) {
      lines.push(`\nMerged (${merged.length} — these were GOOD suggestions):`);
      for (const t of merged.slice(0, 5)) lines.push(`  + ${t}`);
    }
    if (failed.length > 0) {
      lines.push(`\nFailed (${failed.length} — these were POORLY SCOPED, avoid similar):`);
      for (const t of failed) lines.push(`  - ${t}`);
    }
    if (abandoned.length > 0) {
      lines.push(`\nAbandoned (${abandoned.length} — skeptic rejected, NOT ACTIONABLE):`);
      for (const t of abandoned) lines.push(`  - ${t}`);
    }
    if (stillQueued.length > 0) {
      lines.push(`\nStill queued (${stillQueued.length} — not yet attempted):`);
      for (const t of stillQueued.slice(0, 3)) lines.push(`  ? ${t}`);
    }

    if (mergeRate < 50 && total >= 3) {
      lines.push(`\nWARNING: Less than half of last research suggestions merged. Improve suggestion quality by:`);
      lines.push(`- Making items more specific and bounded (single file or module)`);
      lines.push(`- Aligning more tightly with the operator vision's decision vectors`);
      lines.push(`- Avoiding broad multi-file proposals that the executor struggles to complete`);
    }

    return lines.join("\n");
  } catch (err: any) {
    console.error(`[Research] Failed to build accomplishments context: ${err.message}`);
    return "";
  }
}

/**
 * Parse JSON from agent output, handling markdown fences and JSON lines.
 */
/**
 * Normalize a director-produced opportunity to the field names the
 * auto-queue consumer (and downstream logs) expect.
 *
 * The director's JSON schema (config/research/director.md) emits:
 *   { title, description, category, impact, feasibility, alignmentScore,
 *     reasoning, autoQueue, prerequisites }
 *
 * But the auto-queue logger and the work-queue payload reference
 * `rank`, `adjustedScore`, `confidence`, `complexity`, `rationale`,
 * `acceptanceCriteria`, and `estimatedCycles`. Before this normalizer,
 * those fields were always undefined — producing log lines like
 * `[Research] Auto-queued #undefined: "..." (score: undefined, confidence: undefined)`
 * (issue #314). We now derive the missing fields from director output
 * so telemetry surfaces real values without changing the director's
 * schema contract.
 *
 * Mappings:
 *   rank             ← 1-based index after sorting by alignmentScore desc
 *                      (caller supplies via rank arg; falls back to opp.rank
 *                      if the director ever begins emitting one directly)
 *   adjustedScore    ← alignmentScore (0..1)
 *   confidence       ← feasibility (high|medium|low) — director's
 *                      feasibility field is the semantic closest to
 *                      "how confident we are we can ship this"
 *   complexity       ← inverse of feasibility (high feasibility ⇒ low
 *                      complexity), used only when director omits it.
 *                      complexityToEstimate map keys are
 *                      trivial|low|medium|high|extreme.
 *   rationale        ← reasoning (the actual field name in director output)
 *   acceptanceCriteria ← preserved as-is if present (director may emit it
 *                        even though the documented schema doesn't list it)
 *   estimatedCycles  ← preserved as-is if present, otherwise undefined
 *
 * Any field already present on the input wins — we never overwrite a
 * real value with a derived one. This keeps the door open for the
 * director schema to be expanded in the future without re-breaking
 * this normalization.
 */
export function normalizeOpportunity(opp: any, rank?: number): any {
  if (!opp || typeof opp !== "object") return opp;

  const feasibilityToComplexity: Record<string, string> = {
    high: "low",
    medium: "medium",
    low: "high",
  };

  const feasibility = typeof opp.feasibility === "string" ? opp.feasibility.toLowerCase() : null;

  const normalized: any = { ...opp };

  if (normalized.rank === undefined || normalized.rank === null) {
    if (typeof rank === "number") normalized.rank = rank;
  }

  if (normalized.adjustedScore === undefined || normalized.adjustedScore === null) {
    if (typeof opp.alignmentScore === "number") normalized.adjustedScore = opp.alignmentScore;
  }

  if (normalized.confidence === undefined || normalized.confidence === null) {
    if (feasibility) normalized.confidence = feasibility;
  }

  if (normalized.complexity === undefined || normalized.complexity === null) {
    if (feasibility && feasibilityToComplexity[feasibility]) {
      normalized.complexity = feasibilityToComplexity[feasibility];
    }
  }

  if (normalized.rationale === undefined || normalized.rationale === null) {
    if (typeof opp.reasoning === "string") normalized.rationale = opp.reasoning;
  }

  return normalized;
}

/**
 * Normalize an opportunity array: sort by alignmentScore (desc), assign
 * 1-based rank, and fill in derived consumer fields via normalizeOpportunity.
 * Stable for already-ranked input — explicit rank values are preserved.
 */
export function normalizeOpportunities(opportunities: any[]): any[] {
  if (!Array.isArray(opportunities)) return [];

  // Sort by adjustedScore/alignmentScore descending (existing rank takes
  // precedence; otherwise sort by alignmentScore so the top opportunity
  // is #1). Use a stable sort by attaching the original index.
  const withIndex = opportunities.map((opp, i) => ({ opp, i }));
  withIndex.sort((a, b) => {
    const aRank = typeof a.opp?.rank === "number" ? a.opp.rank : null;
    const bRank = typeof b.opp?.rank === "number" ? b.opp.rank : null;
    if (aRank !== null && bRank !== null) return aRank - bRank;
    if (aRank !== null) return -1;
    if (bRank !== null) return 1;

    const aScore = typeof a.opp?.adjustedScore === "number" ? a.opp.adjustedScore
                  : (typeof a.opp?.alignmentScore === "number" ? a.opp.alignmentScore : -Infinity);
    const bScore = typeof b.opp?.adjustedScore === "number" ? b.opp.adjustedScore
                  : (typeof b.opp?.alignmentScore === "number" ? b.opp.alignmentScore : -Infinity);
    if (bScore !== aScore) return bScore - aScore;
    return a.i - b.i;
  });

  return withIndex.map(({ opp }, i) => normalizeOpportunity(opp, i + 1));
}

function parseAgentJson(output) {
  // Try direct parse
  try { return JSON.parse(output); } catch { /* intentional: fallback parse — try fence/object extraction below */ }

  // Try extracting from markdown fences
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* intentional: fallback parse — try largest object extraction below */ }
  }

  // Try extracting the largest JSON object
  const match = output.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* intentional: all parse attempts exhausted, return null below */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Research helpers retained for dashboard read-paths
//
// The in-process codex research agents (runDomainResearcher,
// runTechnicalResearcher, runMarketResearcher, runStrategistSynthesis, and
// the Director synthesis chain inside the former runResearchLoop) were
// removed in issue #342 (Phase A codex-removal). The no-op `runResearchLoop`
// shim that survived that cut was deleted in #706 (scheduler fold PR-1/4),
// together with the scheduler research-decision plane that was its only
// scheduler-side caller. Research is driven by the /hydra-target-research
// skill, which runs Claude with WebSearch and writes priorities.md /
// roadmap.md / research-journal.md directly.
//
// Helpers kept above (normalizeOpportunity, normalizeOpportunities,
// parseAgentJson, generateResearchId, validatePrerequisites,
// loadMethodologyOverrides, loadLastResearchReport, scoreLastResearchOutcomes,
// extractSearchTerms) are still consumed by the dashboard read-paths and by
// /hydra-target-research output normalization.
// ---------------------------------------------------------------------------

/**
 * Get the most recent research report.
 */
export async function getLatestResearch() {
  return loadLastResearchReport();
}

/**
 * List recent research reports (metadata only).
 */
export async function listResearchReports(count = 10) {
  try {
    const ids = await getRecentResearchIds(count);
    const reports = [];
    for (const id of ids) {
      const raw = await getResearchReportAdapter(id);
      if (raw) {
        const report = JSON.parse(raw);
        reports.push({
          researchId: report.researchId,
          timestamp: report.timestamp,
          projectName: report.projectName,
          opportunityCount: report.opportunityCount,
          autoQueued: report.autoQueued,
          summary: report.synthesis?.summary,
          duration: report.duration?.totalHuman,
          cost: report.cost?.totalUsd,
        });
      }
    }
    return reports;
  } catch {
    return [];
  }
}

/**
 * Veto (remove from queue) a research-recommended item.
 */
export async function vetoOpportunity(title) {
  const items = await getWorkQueueItems();
  let removed = 0;

  for (let i = items.length - 1; i >= 0; i--) {
    try {
      const item = JSON.parse(items[i]);
      if (item.reference === title && item.source === "research") {
        await removeFromWorkQueue(items[i]);
        removed++;
      }
    } catch { /* intentional: skip corrupt items */ }
  }

  return { vetoed: removed > 0, title, removed };
}
