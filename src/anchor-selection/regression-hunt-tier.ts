// ---------------------------------------------------------------------------
// Regression-hunt tier — every N merges, run self-play adversarial cycle
// ---------------------------------------------------------------------------
//
// Instead of building new work, test recent merges for edge cases. Returns
// null when the threshold hasn't been crossed yet or when a recent hunt is
// still in its cooldown window.

import {
  getString,
  setString,
  zRevRange,
  getCycleMetrics,
  getRealityReport,
  getRecentReportIds,
} from "../redis-adapter.ts";
import { METRICS_INDEX_KEY, REGRESSION_HUNT_LAST_KEY } from "./constants.ts";

export interface RegressionHuntAnchor {
  type: "regression-hunt";
  reference: string;
  whyNow: string;
  context: string;
  description: string;
}

const HUNT_INTERVAL = 10;
const HUNT_COOLDOWN_SECONDS = 86400 * 3; // 3 days

export async function selectRegressionHuntAnchor(): Promise<RegressionHuntAnchor | null> {
  try {
    const recentMetrics = await zRevRange(METRICS_INDEX_KEY, 0, 9);
    let recentMergeCount = 0;
    for (const id of recentMetrics) {
      const raw = await getCycleMetrics(id);
      if (parseInt(raw.tasksMerged || "0") > 0) recentMergeCount++;
    }
    const lastRegressionHunt = await getString(REGRESSION_HUNT_LAST_KEY);
    if (recentMergeCount >= HUNT_INTERVAL && !lastRegressionHunt) {
      // Time for a regression hunt
      console.log(`[ControlLoop] Regression hunt triggered (${recentMergeCount} merges since last hunt)`);

      // Get the last 10 merged task titles and files for context
      const mergedTasks: string[] = [];
      const reportIds = await getRecentReportIds(10);
      for (const rid of reportIds) {
        const raw = await getRealityReport(rid);
        if (!raw) continue;
        try {
          const report = JSON.parse(raw);
          if (report.task?.finalState === "merged") {
            mergedTasks.push(`- "${report.task.title}" (${report.filesChanged?.length || 0} files, commit ${report.commitSha?.slice(0, 7) || "?"})`);
          }
        } catch { /* intentional: skip unparseable reality report when scanning merged tasks */ }
      }

      await setString(REGRESSION_HUNT_LAST_KEY, new Date().toISOString(), HUNT_COOLDOWN_SECONDS);

      return {
        type: "regression-hunt",
        reference: "Periodic regression hunt — test recent merges for edge cases",
        whyNow: `${recentMergeCount} merges since last hunt. Time for self-play validation.`,
        context: `Test these recently merged features for edge cases, missed error handling, and integration issues:\n${mergedTasks.join("\n")}\n\nWrite FAILING tests for any real bugs found. Do not write tests that already pass — only tests that expose actual defects.`,
        description: "Run adversarial testing on recently merged features. Write failing tests for any real bugs found.",
      };
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Regression hunt check failed: ${err.message}`);
  }
  return null;
}
