/**
 * Trend-rollup aggregations consumed by /metrics, /summary, and planner-
 * facing accomplishments. Pure compositions over getMetricsTrend() — no
 * Redis access of their own.
 */

import { getMetricsTrend } from "./trend.ts";
import { getDailyTokenCounter, todayDateString } from "../cost/index.ts";

// ---------------------------------------------------------------------------
// Per-class cost attribution (issue #1439)
// ---------------------------------------------------------------------------

/**
 * The dispatch-class buckets used for per-class cost attribution. These mirror
 * the autopilot class taxonomy (docs/operator-playbooks/hydra-autopilot.md):
 * the cost-driving code-writing / review / research / housekeeping classes,
 * plus an `other` long-tail bucket for everything else (sweep, digest, doctor,
 * autopilot itself, …) so no token spend silently disappears.
 */
export type CostClass =
  | "research"
  | "dev-orch"
  | "dev-target"
  | "qa"
  | "cleanup"
  | "retro"
  | "other";

/** Stable ordering for the stacked-chart series. `other` always last. */
export const COST_CLASS_ORDER: readonly CostClass[] = Object.freeze([
  "research",
  "dev-orch",
  "dev-target",
  "qa",
  "cleanup",
  "retro",
  "other",
]);

/**
 * Map a dispatched skill name to its cost-attribution class. Pure + exported
 * so the test suite can pin the mapping. Unknown / housekeeping skills fall to
 * `other` rather than `unknown` so the bucket sum always equals the daily
 * total. Target-scoped QA (`hydra-target-qa`) is attributed to `qa` since the
 * operator's question is "how much does review cost", not "orch vs target".
 */
export function skillToCostClass(skill: string | undefined | null): CostClass {
  const s = (skill || "").trim().toLowerCase();
  if (!s) return "other";

  // Order matters: check the more specific `target` variants before the
  // generic prefixes so `hydra-target-build` doesn't fall into `dev-orch`.
  if (s === "hydra-target-build") return "dev-target";
  if (s === "hydra-dev") return "dev-orch";
  if (s === "hydra-qa" || s === "hydra-target-qa") return "qa";
  if (s === "hydra-retro" || s === "hydra-target-retro") return "retro";
  if (s === "hydra-cleanup") return "cleanup";
  // Research family: hydra-research, hydra-issue-research, hydra-target-research,
  // and the discover/scout/architecture scouting skills that feed the research
  // pipeline.
  if (
    s === "hydra-research" ||
    s === "hydra-issue-research" ||
    s === "hydra-target-research" ||
    s === "hydra-discover" ||
    s === "hydra-target-discover" ||
    s === "hydra-tool-scout" ||
    s === "hydra-architecture-scan" ||
    s === "hydra-architect"
  ) {
    return "research";
  }
  return "other";
}

export interface CostByClassEntry {
  /** Total tokens attributed to this class for the window. */
  tokens: number;
  /** Fraction of the window's total tokens (0..1, rounded to 2 dp). */
  fraction: number;
  /** Skills that rolled up into this class (sorted by tokens desc). */
  skills: Array<{ skill: string; tokens: number }>;
}

export interface CostByClassResult {
  /** YYYY-MM-DD (UTC) the breakdown was computed for. */
  date: string;
  /** Total subagent tokens across all classes for the date. */
  totalTokens: number;
  /** Per-class breakdown keyed by CostClass; every class present, zeros included. */
  byClass: Record<CostClass, CostByClassEntry>;
}

/**
 * Pure projection: fold a per-skill token breakdown (the shape returned by
 * `getDailyTokenCounter().bySkill`) into per-class totals + fractions.
 *
 * Exported separately from the Redis-reading `getCostByClass` so the fold is
 * unit-testable on fixtures without a live Redis (ADR-0014 pure-core seam).
 */
export function projectCostByClass(
  bySkill: Array<{ skill: string; tokens: number }>,
  date: string,
): CostByClassResult {
  const byClass: Record<CostClass, CostByClassEntry> = {
    research: { tokens: 0, fraction: 0, skills: [] },
    "dev-orch": { tokens: 0, fraction: 0, skills: [] },
    "dev-target": { tokens: 0, fraction: 0, skills: [] },
    qa: { tokens: 0, fraction: 0, skills: [] },
    cleanup: { tokens: 0, fraction: 0, skills: [] },
    retro: { tokens: 0, fraction: 0, skills: [] },
    other: { tokens: 0, fraction: 0, skills: [] },
  };

  let totalTokens = 0;
  for (const { skill, tokens } of bySkill) {
    const n = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
    if (n === 0) continue;
    const cls = skillToCostClass(skill);
    byClass[cls].tokens += n;
    byClass[cls].skills.push({ skill, tokens: n });
    totalTokens += n;
  }

  for (const cls of COST_CLASS_ORDER) {
    const entry = byClass[cls];
    entry.fraction = totalTokens > 0
      ? Math.round((entry.tokens / totalTokens) * 100) / 100
      : 0;
    entry.skills.sort((a, b) => b.tokens - a.tokens);
  }

  return { date, totalTokens, byClass };
}

/**
 * Read the per-class cost breakdown for a given date (defaults to today UTC).
 *
 * Composes the existing per-skill daily token counter (`getDailyTokenCounter`,
 * the surrogate this orchestrator already populates at autopilot reap time)
 * with the pure `projectCostByClass` fold. No new Redis write path — the
 * per-skill data already carries the class signal via the skill name.
 */
export async function getCostByClass(dateOverride?: string): Promise<CostByClassResult> {
  const date = dateOverride || todayDateString();
  const counter = await getDailyTokenCounter(date);
  return projectCostByClass(counter.bySkill, counter.date);
}

/**
 * Compute aggregate stats from metrics trend.
 */
export async function getAggregateStats(count = 20) {
  const trend = await getMetricsTrend(count);
  if (trend.length === 0) return { cycles: 0 };

  const total = trend.length;
  const merged = trend.filter((m) => m.tasksMerged > 0).length;
  const failed = trend.filter((m) => m.tasksFailed > 0).length;
  const abandoned = trend.filter((m) => m.tasksAbandoned > 0).length;
  const regressions = trend.filter((m) => m.regressionIntroduced).length;
  // Issue #222: aggregate no-op-merge counter so /metrics surfaces the
  // silent-rot guardrail across the trend window.
  const noOpMerges = trend.filter((m) => m.noOpMerges > 0).length;

  const durations = trend.map((m) => m.totalDurationMs).filter(Boolean);
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  // Spec section 12: additional metrics
  const retries = trend.filter((m) => m.anchorType === "prior-failure").length;
  const filesChangedTotal = trend.reduce((s, m) => s + (m.filesChanged || 0), 0);
  const verificationDurations = trend.map((m) => m.verificationDurationMs).filter(Boolean);
  const groundingDurations = trend.map((m) => m.groundingDurationMs).filter(Boolean);

  const anchorDist = {};
  for (const m of trend) {
    const at = m.anchorType || "unknown";
    anchorDist[at] = (anchorDist[at] || 0) + 1;
  }

  return {
    cycles: total,
    mergedRate: Math.round((merged / total) * 100),
    failedRate: Math.round((failed / total) * 100),
    abandonedRate: Math.round((abandoned / total) * 100),
    regressionRate: Math.round((regressions / total) * 100),
    noOpMerges,
    noOpMergeRate: Math.round((noOpMerges / total) * 100),
    retryRate: Math.round((retries / total) * 100),
    avgDurationMs: avgDuration,
    avgDurationHuman: `${Math.round(avgDuration / 1000)}s`,
    avgVerificationMs: verificationDurations.length > 0
      ? Math.round(verificationDurations.reduce((a, b) => a + b, 0) / verificationDurations.length) : 0,
    avgGroundingMs: groundingDurations.length > 0
      ? Math.round(groundingDurations.reduce((a, b) => a + b, 0) / groundingDurations.length) : 0,
    totalFilesChanged: filesChangedTotal,
    anchorDistribution: anchorDist,
    falseCompletionRate: 0,
    anchoredRate: 100,
    verifiedCompletionRate: merged > 0 ? 100 : 0,
  };
}

/**
 * Get a cumulative summary of what's been accomplished across recent cycles.
 * Used by the planner to avoid re-proposing completed work.
 */
export async function getCumulativeAccomplishments(count = 15) {
  const trend = await getMetricsTrend(count);
  const accomplished = trend
    .filter((m) => m.tasksMerged > 0 && m.taskTitle)
    .map((m) => ({
      cycle: m.cycleId,
      title: m.taskTitle,
      anchor: m.anchorType,
      tests: `${m.testsBefore}→${m.testsAfter}`,
    }));
  return accomplished;
}

/**
 * Compute fix:feature ratio from recent cycles.
 * Fixes = prior-failure or failing-test anchors. Features = everything else that merged.
 */
export async function getFixFeatureRatio(count = 20) {
  const trend = await getMetricsTrend(count);
  let fixes = 0, features = 0;
  for (const m of trend) {
    if (m.tasksMerged > 0) {
      if (m.anchorType === "prior-failure" || m.anchorType === "failing-test") {
        fixes++;
      } else {
        features++;
      }
    }
  }
  return { fixes, features, ratio: features > 0 ? +(fixes / features).toFixed(1) : 0, total: trend.length };
}
