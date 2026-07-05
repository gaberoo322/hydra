/**
 * Health-signal heuristic 3: idle streak (issue #2866 — extracted from the
 * combined `autopilot/run-health.ts` heuristic bag).
 *
 * A run is "idle/no-op" when it produced zero dispatches. We count the leading
 * streak of such runs from the newest end of the window (history is
 * newest-first). term_reason "idle" is the normal clean idle-drain exit (a
 * termination cause, not a productivity measure), so it must NOT gate idle-ness
 * (the #2864/#2865 false-positive fix — idle is defined SOLELY by
 * `dispatches === 0`). This leaf owns that heuristic; it evolves with
 * run-termination accounting independently of the other three evaluators.
 */

import {
  type AutopilotHealthThresholds,
  type RunDigest,
  type StuckSignal,
  type StuckSignalSeverity,
  toNum,
} from "./common.ts";

export function detectIdleStreak(
  history: RunDigest[],
  thresholds: AutopilotHealthThresholds,
): StuckSignal[] {
  let streak = 0;
  for (const run of history) {
    const idle = toNum(run.dispatches) === 0;
    if (!idle) break;
    streak += 1;
  }

  if (streak < thresholds.idleStreakMin) return [];

  const severity: StuckSignalSeverity =
    streak >= thresholds.idleStreakCritical ? "critical" : "warn";

  return [
    {
      type: "idle-streak",
      severity,
      summary: `The last ${streak} consecutive autopilot run(s) were idle / produced no dispatch.`,
      evidence: {
        streak,
        windowRuns: history.length,
        thresholdRuns: thresholds.idleStreakMin,
      },
    },
  ];
}
