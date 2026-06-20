/**
 * Digest async fan-out assemblers (issue #2215).
 *
 * These are the two side-effecting siblings of the pure grammar in
 * `src/digest-format.ts`. Each is a mini fan-out orchestrator: it reads from
 * five-to-six independent sub-sources (Redis run index, the usage tracker, the
 * builder-health scorecard, the target backlog, the alert ring, metrics trends,
 * roadmap progress …), assembles the on-wire Telegram string, and degrades each
 * section best-effort (a failing reader → an `n/a` line, never a thrown error)
 * so the heartbeat / weekly summary ALWAYS ships.
 *
 * They were lifted out of `digest-format.ts` so that file's documented contract
 * — pure assembly grammar, no timers, no Telegram calls, no dynamic imports,
 * no Redis / usage-tracker / GitHub I/O — becomes literally true. This module is
 * named after its body (the async fan-out), mirroring the `notify.ts` /
 * `notify-format.ts` split (issue #1512) and the health `fan-out.ts` precedent
 * (issues #2039 / #2089).
 *
 * Each reader is injectable via `deps` (defaulting to the real import), the same
 * pattern as `src/aggregators/builder-health.ts`, so both assemblers stay
 * unit-testable without Redis, the usage tracker, or GitHub. The on-wire output
 * is byte-identical to the pre-extraction `digest-format.ts` — this is a
 * boundary realignment, not a format change.
 */

import { getBuilderHealthScorecard } from "./aggregators/builder-health.ts";

/**
 * Injectable readers for `buildDailyHeartbeat`. Each defaults to the real
 * module import, so the production wrapper calls `buildDailyHeartbeat()` with
 * no args; tests pass stubs to exercise the grammar without Redis, the usage
 * tracker, or GitHub. Mirrors the `deps` pattern in
 * `src/aggregators/builder-health.ts`.
 */
export interface DailyHeartbeatDeps {
  listRecentAutopilotRunIds?: (n: number) => Promise<string[]>;
  getAutopilotRun?: (id: string) => Promise<any>;
  getUsage?: () => Promise<any>;
  getBuilderHealthScorecard?: () => Promise<any>;
  getBacklogCounts?: () => Promise<any>;
  readRecentAlerts?: (n: number) => Promise<string[]>;
  now?: () => number;
}

/**
 * Build the daily heartbeat message (always returns a string — never null).
 *
 * Each section is best-effort: a failing reader degrades that one line to a
 * "n/a" marker rather than throwing, so the heartbeat ALWAYS ships even when
 * Redis / the usage tracker hiccups. Sections, in operator-priority order:
 *   - Liveness   — most recent autopilot run + its age (a wedged loop shows up)
 *   - Usage      — 5h % and weekly since-reset %, against the 90% hard-stops
 *   - Throughput — autonomous merge rate over the builder-health window
 *   - Queue      — target backlog lanes (queued / blocked / triage)
 *   - Alerts     — count of alert events recorded in the last 24h
 *
 * Readers are injectable via `deps` (defaulting to the real imports) so the
 * grammar is testable without side effects.
 */
export async function buildDailyHeartbeat(deps: DailyHeartbeatDeps = {}): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  const lines = ["💓 *Hydra Daily Heartbeat*", ""];

  // --- Liveness: latest autopilot run + age ---
  try {
    const listRecentAutopilotRunIds =
      deps.listRecentAutopilotRunIds ??
      (await import("./redis/autopilot-runs.ts")).listRecentAutopilotRunIds;
    const getAutopilotRun =
      deps.getAutopilotRun ??
      (await import("./redis/autopilot-runs.ts")).getAutopilotRun;
    const [latestId] = await listRecentAutopilotRunIds(1);
    if (latestId) {
      const run = await getAutopilotRun(latestId);
      const startedEpoch = Number(run.started_epoch || 0);
      const ageMin = startedEpoch > 0 ? Math.round((now() / 1000 - startedEpoch) / 60) : null;
      const status = run.status || run.ended ? run.status || "ended" : "running";
      const ageStr = ageMin === null ? "?" : ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
      lines.push(`*Autopilot:* last run ${status} — started ${ageStr}`);
    } else {
      lines.push(`*Autopilot:* ⚠️ no recent run indexed`);
    }
  } catch (err: any) {
    lines.push(`*Autopilot:* n/a (${err?.message || err})`);
  }

  // --- Usage: 5h + weekly since-reset, with the 90% hard-stops in view ---
  try {
    const getUsage =
      deps.getUsage ?? (await import("./cost/usage-tracker.ts")).getUsage;
    const u = await getUsage();
    if (!u.calibrated) {
      lines.push(`*Usage:* uncalibrated (quota env vars unset)`);
    } else {
      const stop5h = u.emergencyStop ? " 🛑" : "";
      const stopWk = u.weeklyEmergencyStop ? " 🛑" : "";
      lines.push(
        `*Usage:* 5h ${u.percentLast5h.toFixed(0)}%${stop5h} · weekly ${u.percentSinceReset.toFixed(0)}%${stopWk} (caps at 90%)`,
      );
    }
  } catch (err: any) {
    lines.push(`*Usage:* n/a (${err?.message || err})`);
  }

  // --- Throughput: autonomous merge rate over the builder-health window ---
  try {
    const scorecardReader = deps.getBuilderHealthScorecard ?? getBuilderHealthScorecard;
    const health = await scorecardReader();
    const autonomy = health?.autonomyRate;
    if (autonomy && autonomy.total > 0) {
      lines.push(
        `*Throughput:* ${autonomy.autonomous}/${autonomy.total} PRs auto-merged (last ${autonomy.window})`,
      );
    } else {
      lines.push(`*Throughput:* no merges in window`);
    }
  } catch (err: any) {
    lines.push(`*Throughput:* n/a (${err?.message || err})`);
  }

  // --- Queue: target backlog lanes ---
  try {
    const getBacklogCounts =
      deps.getBacklogCounts ?? (await import("./backlog/reads.ts")).getBacklogCounts;
    const counts = await getBacklogCounts();
    lines.push(
      `*Target backlog:* ${counts.queued || 0} queued, ${counts.blocked || 0} blocked, ${counts.triage || 0} triage`,
    );
  } catch (err: any) {
    lines.push(`*Target backlog:* n/a (${err?.message || err})`);
  }

  // --- Alerts: count recorded in the last 24h ---
  try {
    const readRecentAlerts =
      deps.readRecentAlerts ?? (await import("./redis/alerts.ts")).readRecentAlerts;
    const raw = await readRecentAlerts(100);
    const since = now() - 24 * 60 * 60 * 1000;
    let count = 0;
    for (const a of raw) {
      try {
        const ts = JSON.parse(a)?.timestamp;
        if (!ts || new Date(ts).getTime() >= since) count++;
      } catch {
        /* intentional: unparseable alert → count it rather than hide it */
        count++;
      }
    }
    lines.push(`*Alerts (24h):* ${count}${count > 0 ? " — see the 4h alert digest" : ""}`);
  } catch (err: any) {
    lines.push(`*Alerts (24h):* n/a (${err?.message || err})`);
  }

  return lines.filter(Boolean).join("\n");
}

/**
 * Injectable readers for `buildWeeklySummary`. Each defaults to the real
 * module import, so the production wrapper calls `buildWeeklySummary()` with
 * no args; tests pass stubs to exercise the grammar without Redis or GitHub.
 * Mirrors the `DailyHeartbeatDeps` pattern above (and
 * `src/aggregators/builder-health.ts`).
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
 * `src/digest.ts` into the pure-core seam, then into this async fan-out module
 * in #2215).
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
  const getMetricsTrend =
    deps.getMetricsTrend ?? (await import("./metrics/trend.ts")).getMetricsTrend;
  const getFixFeatureRatio =
    deps.getFixFeatureRatio ?? (await import("./metrics/aggregate.ts")).getFixFeatureRatio;
  const getCurrentMilestoneProgress =
    deps.getCurrentMilestoneProgress ??
    (await import("./config/roadmap.ts")).getCurrentMilestoneProgress;
  const getBacklogCounts =
    deps.getBacklogCounts ?? (await import("./backlog/reads.ts")).getBacklogCounts;

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
