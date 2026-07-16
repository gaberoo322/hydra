/**
 * Weekly-summary async fan-out assembler (issue #3394).
 *
 * Extracted from `src/digest-fanout.ts` so the once-a-week weekly narrative
 * assembler lives in its own named leaf, independent of the hourly
 * `buildDailyHeartbeat` path. The two assemblers shared no helpers, no types,
 * and no callers — they were co-located purely because both perform async
 * fan-out from multiple sub-sources. Splitting them concentrates each concern
 * in its own module (matching the `notify.ts` / `notify-format.ts` split, issue
 * #1512, and the `digest.ts` / `digest-format.ts` split, issue #1181), so the
 * weekly grammar can evolve without an engineer editing past the daily
 * heartbeat code.
 *
 * `buildWeeklySummary` is a mini fan-out orchestrator: it reads from four
 * independent sub-sources (metrics trend, fix:feature ratio, roadmap milestone
 * progress, target backlog counts), assembles the on-wire Telegram string, and
 * returns `null` when no metrics were recorded in the last 7 days.
 *
 * Each reader is injectable via `deps` (defaulting to the real import), the same
 * pattern as `src/aggregators/builder-health.ts`, so the assembler stays
 * unit-testable without Redis or GitHub. The on-wire output is byte-identical to
 * the pre-extraction `digest-fanout.ts` — this is a boundary realignment, not a
 * format change.
 */

import { getMetricsTrend as defaultGetMetricsTrend } from "./metrics/trend.ts";
import { getFixFeatureRatio as defaultGetFixFeatureRatio } from "./metrics/aggregate.ts";
import { getCurrentMilestoneProgress as defaultGetCurrentMilestoneProgress } from "./config/roadmap.ts";
import { getBacklogCounts as defaultGetBacklogCounts } from "./backlog/reads.ts";

/**
 * Injectable readers for `buildWeeklySummary`. Each defaults to the real
 * module import, so the production wrapper calls `buildWeeklySummary()` with
 * no args; tests pass stubs to exercise the grammar without Redis or GitHub.
 * Mirrors the `deps` pattern in `src/aggregators/builder-health.ts`.
 */
export interface WeeklySummaryDeps {
  getMetricsTrend?: (n: number) => Promise<any[]>;
  getFixFeatureRatio?: (n: number) => Promise<any>;
  getCurrentMilestoneProgress?: () => Promise<any>;
  getBacklogCounts?: () => Promise<any>;
  now?: () => number;
}

/**
 * Build a weekly progress summary for the operator (issue #1412 — moved out of
 * `src/digest.ts` into the pure-core seam, then into `src/digest-fanout.ts` in
 * #2215, then into this focused weekly leaf in #3394).
 *
 * Returns the assembled Telegram string, or `null` when no metrics were
 * recorded in the last 7 days. Readers are injectable via `deps` (defaulting
 * to the real imports) so the assembly grammar is testable without Redis or
 * GitHub — the production wrapper in `src/digest.ts` calls it with no args.
 *
 * The on-wire output is unchanged from the pre-extraction `digest.ts`.
 */
export async function buildWeeklySummary(deps: WeeklySummaryDeps = {}): Promise<string | null> {
  const now = deps.now ?? (() => Date.now());
  const getMetricsTrend = deps.getMetricsTrend ?? defaultGetMetricsTrend;
  const getFixFeatureRatio = deps.getFixFeatureRatio ?? defaultGetFixFeatureRatio;
  const getCurrentMilestoneProgress =
    deps.getCurrentMilestoneProgress ?? defaultGetCurrentMilestoneProgress;
  const getBacklogCounts = deps.getBacklogCounts ?? defaultGetBacklogCounts;

  const trend = await getMetricsTrend(50);
  const weekAgo = now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = trend.filter(m => {
    const t = m.recordedAt ? new Date(m.recordedAt).getTime() : 0;
    return t > weekAgo;
  });

  if (thisWeek.length === 0) return null;

  const merged = thisWeek.filter(m => parseInt(m.tasksMerged) > 0).length;
  const failed = thisWeek.filter(m => parseInt(m.tasksFailed) > 0).length;
  const rolledBack = thisWeek.filter(m => m.rolledBack === true || m.rolledBack === "true").length;
  const abandoned = thisWeek.filter(m => parseInt(m.tasksAbandoned) > 0).length;
  const ratio = await getFixFeatureRatio(thisWeek.length);
  const milestone = await getCurrentMilestoneProgress();
  const counts = await getBacklogCounts();

  const lines = [
    `📈 *Hydra Weekly Summary*`,
    ``,
    `*Cycles:* ${thisWeek.length} run — ${merged} merged, ${failed} failed, ${rolledBack} rolled back, ${abandoned} abandoned`,
    `*Fix:Feature ratio:* ${ratio.fixes}:${ratio.features} (${ratio.ratio}:1)`,
  ];

  if (milestone) {
    lines.push(`*Milestone:* ${milestone.name} — ${milestone.pctComplete}% (${milestone.done}/${milestone.total} epics)`);
    if (milestone.remainingTitles.length > 0) {
      lines.push(`*Remaining:* ${milestone.remainingTitles.slice(0, 3).join(", ")}${milestone.remainingTitles.length > 3 ? ` +${milestone.remainingTitles.length - 3} more` : ""}`);
    }
  }

  lines.push(`*Backlog:* ${counts.queued || 0} queued, ${counts.blocked || 0} blocked, ${counts.triage || 0} triage`);
  lines.push("");

  // Warnings
  if (ratio.ratio > 2) {
    lines.push(`⚠️ Fix ratio is ${ratio.ratio}:1 — most cycles are fixing previous work`);
  }
  if (rolledBack >= 3) {
    lines.push(`⚠️ ${rolledBack} rollbacks this week — executor quality needs attention`);
  }
  if ((counts.blocked || 0) > 0) {
    lines.push(`⚠️ ${counts.blocked} items blocked — check Telegram for unblock commands`);
  }
  if (milestone && milestone.pctComplete === 100) {
    lines.push(`🎉 Milestone "${milestone.name}" is 100% complete — ready for operator review`);
  }

  return lines.filter(Boolean).join("\n");
}
