/**
 * Weekly-summary async fan-out assembler (issue #3394; plain-lines contract
 * since issue #5047).
 *
 * `buildWeeklySummary` is a mini fan-out orchestrator: it reads from several
 * independent sub-sources (metrics trend, fix:feature ratio, roadmap milestone
 * progress) and returns PLAIN structured lines — no Telegram markup of any
 * kind — or `null` when no metrics were recorded in the last 7 days. The
 * Morning Brief (`src/operator-channel/brief.ts`) appends these lines as its
 * Monday "Weekly summary" section and renders them as Telegram HTML through
 * the single `escapeHtml` escaper (ADR-0045 Decisions 5 and 7). The former
 * standalone weekly Telegram digest and its `weekly-summary` housekeeping
 * chore are gone; Monday membership plus the once-per-day brief bound the
 * summary to one per week, so no separate weekly Redis guard is needed.
 *
 * Each reader is injectable via `deps` (defaulting to the real import), the
 * same pattern as `src/aggregators/builder-health.ts`, so the assembler stays
 * unit-testable without Redis or GitHub.
 */

import { getMetricsTrend as defaultGetMetricsTrend } from "./metrics/trend.ts";
import { countsAsMerge } from "./metrics/merge-predicate.ts";
import { getFixFeatureRatio as defaultGetFixFeatureRatio } from "./metrics/aggregate.ts";
import { getCurrentMilestoneProgress as defaultGetCurrentMilestoneProgress } from "./config/roadmap.ts";

/**
 * Injectable readers for `buildWeeklySummary`. Each defaults to the real
 * module import, so the production caller passes no args; tests pass stubs to
 * exercise the grammar without Redis or GitHub.
 */
export interface WeeklySummaryDeps {
  getMetricsTrend?: (n: number) => Promise<any[]>;
  getFixFeatureRatio?: (n: number) => Promise<any>;
  getCurrentMilestoneProgress?: () => Promise<any>;
  now?: () => number;
}

/** Plain-text weekly lines: facts first, then any warnings. */
export interface WeeklySummary {
  lines: string[];
}

/**
 * Build the weekly progress summary for the operator (issue #1412 lineage).
 *
 * Returns `{ lines }` of plain text, or `null` when no metrics were recorded in
 * the last 7 days. No `*…*` / `_…_` markup: the brief renderer escapes and
 * formats.
 */
export async function buildWeeklySummary(deps: WeeklySummaryDeps = {}): Promise<WeeklySummary | null> {
  const now = deps.now ?? (() => Date.now());
  const getMetricsTrend = deps.getMetricsTrend ?? defaultGetMetricsTrend;
  const getFixFeatureRatio = deps.getFixFeatureRatio ?? defaultGetFixFeatureRatio;
  const getCurrentMilestoneProgress =
    deps.getCurrentMilestoneProgress ?? defaultGetCurrentMilestoneProgress;

  const trend = await getMetricsTrend(50);
  const weekAgo = now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = trend.filter(m => {
    const t = m.recordedAt ? new Date(m.recordedAt).getTime() : 0;
    return t > weekAgo;
  });

  if (thisWeek.length === 0) return null;

  const merged = thisWeek.filter(countsAsMerge).length;
  const failed = thisWeek.filter(m => parseInt(m.tasksFailed) > 0).length;
  const rolledBack = thisWeek.filter(m => m.rolledBack === true || m.rolledBack === "true").length;
  const abandoned = thisWeek.filter(m => parseInt(m.tasksAbandoned) > 0).length;
  const ratio = await getFixFeatureRatio(thisWeek.length);
  const milestone = await getCurrentMilestoneProgress();

  const lines = [
    `Cycles: ${thisWeek.length} run — ${merged} merged, ${failed} failed, ${rolledBack} rolled back, ${abandoned} abandoned`,
    `Fix:Feature ratio: ${ratio.fixes}:${ratio.features} (${ratio.ratio}:1)`,
  ];

  if (milestone) {
    lines.push(`Milestone: ${milestone.name} — ${milestone.pctComplete}% (${milestone.done}/${milestone.total} epics)`);
    if (milestone.remainingTitles.length > 0) {
      lines.push(`Remaining: ${milestone.remainingTitles.slice(0, 3).join(", ")}${milestone.remainingTitles.length > 3 ? ` +${milestone.remainingTitles.length - 3} more` : ""}`);
    }
  }

  // Warnings
  if (ratio.ratio > 2) {
    lines.push(`⚠️ Fix ratio is ${ratio.ratio}:1 — most cycles are fixing previous work`);
  }
  if (rolledBack >= 3) {
    lines.push(`⚠️ ${rolledBack} rollbacks this week — executor quality needs attention`);
  }
  if (milestone && milestone.pctComplete === 100) {
    lines.push(`🎉 Milestone "${milestone.name}" is 100% complete — ready for operator review`);
  }

  return { lines };
}
