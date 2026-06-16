/**
 * Digest pure-core formatters (issue #1181).
 *
 * The pure assembly grammar lifted out of `src/digest.ts`. These functions are
 * the "where the grammar lives" — they take already-fetched data and produce
 * the exact on-wire Telegram strings, with **no timers, no Telegram calls, and
 * no module-level mutable state**. The side-effecting wrappers (`startDigest`,
 * `stopDigest`, `sendDigestNow`, `sendDailyHeartbeatNow`) and the accumulator
 * state (`pendingEvents`, `lastDigestAt`, timer handles) remain in
 * `src/digest.ts` as thin orchestrators over this core.
 *
 * `buildDailyHeartbeat` is injectable — it accepts its readers as `deps` (same
 * pattern as `src/aggregators/builder-health.ts`) so it can be exercised
 * without Redis, the usage tracker, or GitHub. Every reader defaults to the
 * real import, so the production wrapper calls it with no args.
 *
 * The on-wire output is unchanged from the pre-extraction `digest.ts` — this
 * concentrates where the grammar lives, not the format itself.
 */

import { getTargetCommitUrl } from "./target-config.ts";
import { ORCHESTRATOR_FLOOR, type CapacitySnapshot } from "./capacity-floor.ts";
import {
  getBuilderHealthScorecard,
  type BuilderHealthScorecard,
} from "./aggregators/builder-health.ts";
import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "./event-bus-vocabulary.ts";

const MAX_DIGEST_LENGTH = 4000; // Telegram's ~4096 char limit with margin

/**
 * The event vocabulary the digest grammar reads (issue #1835; shared
 * source-of-truth derivation, issue #1915).
 *
 * `buildDigestMessage` is fed accumulated events (`PendingEvent` in
 * `digest.ts`, ultimately the loosely-typed `NotificationEvent` shapes from the
 * bus). The `payload` shape is DERIVED from the shared `NotificationEventPayload`
 * vocabulary in `event-bus.ts` — this formatter `Pick`s exactly the fields the
 * grammar touches via the `e.payload?.…` optional chains below — so a renamed
 * payload field (e.g. `task.finalStatus` instead of `task.finalState`) is a
 * one-file edit in the shared vocabulary that becomes a compile error here
 * rather than a silent runtime miss.
 *
 * `payload` stays open (`Record<string, unknown> & Pick<…>`) because the bus
 * carries the full event vocabulary; the picked fields are the subset this
 * grammar narrows on. `type`/`timestamp` are required because the grammar reads
 * them unconditionally (`events[0].timestamp.split(…)`).
 */
export interface DigestGrammarEvent {
  type: string;
  timestamp: string;
  payload?: Record<string, unknown> &
    Pick<
      NotificationEventPayload,
      | "task"
      | "commitSha"
      | "grounding"
      | "opportunityCount"
      | "autoQueued"
      | "updatesApplied"
      | "regressedOutcomes"
    >;
}

export function buildDigestMessage(
  events: DigestGrammarEvent[],
  capacitySnapshot: CapacitySnapshot | null = null,
  builderHealth: BuilderHealthScorecard | null = null,
): string {
  const lines = ["📊 *Hydra Digest*", ""];

  // Cycle summary
  const cycleCompletes = events.filter(e => e.type === "cycle:completed");
  const merged = cycleCompletes.filter(e => e.payload?.task?.finalState === "merged");
  const failed = cycleCompletes.filter(e => e.payload?.task?.finalState === "failed" || e.payload?.task?.finalState === "rolled-back");
  const abandoned = events.filter(e => e.type === "task:rejected" || e.type === "task:drift_detected");

  if (cycleCompletes.length > 0) {
    lines.push(`*Cycles:* ${cycleCompletes.length} completed — ${merged.length} merged, ${failed.length} failed, ${abandoned.length} abandoned`);
    lines.push("");

    // List merged tasks (truncate to top 10 to avoid message-too-long)
    if (merged.length > 0) {
      lines.push("*Merged:*");
      const shown = merged.slice(0, 10);
      for (const e of shown) {
        const task = e.payload?.task;
        const sha = e.payload?.commitSha?.slice(0, 7);
        const link = sha ? getTargetCommitUrl(e.payload?.commitSha ?? "") : "";
        lines.push(`• ${task?.title || "?"}${sha ? ` (${link})` : ""}`);
      }
      if (merged.length > 10) lines.push(`• ... and ${merged.length - 10} more`);
      lines.push("");
    }

    // List failures
    if (failed.length > 0) {
      lines.push("*Failed:*");
      for (const e of failed.slice(0, 5)) {
        const task = e.payload?.task;
        lines.push(`• ${task?.title || "?"} — ${task?.finalState || "failed"}`);
      }
      if (failed.length > 5) lines.push(`• ... and ${failed.length - 5} more`);
      lines.push("");
    }

    // Test count change
    const firstGrounding = cycleCompletes[0]?.payload?.grounding;
    const lastGrounding = cycleCompletes[cycleCompletes.length - 1]?.payload?.grounding;
    if (firstGrounding && lastGrounding) {
      const testsBefore = firstGrounding.before?.passed ?? "?";
      const testsAfter = lastGrounding.after?.passed ?? "?";
      if (testsBefore !== testsAfter) {
        lines.push(`*Tests:* ${testsBefore} → ${testsAfter}`);
        lines.push("");
      }
    }
  } else {
    lines.push("*Cycles:* None completed in this period");
    lines.push("");
  }

  // Capacity split (issue #245) — show orchestrator self-improvement share
  // against the 25% floor. Always render so the operator can see the floor
  // is being tracked even when the system is healthy.
  lines.push("*Capacity split:*");
  if (capacitySnapshot && (capacitySnapshot.orchestrator.window > 0 || capacitySnapshot.idle.count > 0)) {
    const orchPct = Math.round((capacitySnapshot.orchestrator.share || 0) * 100);
    const tgtPct = Math.round((capacitySnapshot.target.share || 0) * 100);
    const floorPct = Math.round(ORCHESTRATOR_FLOOR * 100);
    const floorMark = capacitySnapshot.floorMet ? "✅" : "⚠️";
    lines.push(`• Orchestrator: ${orchPct}% (${capacitySnapshot.orchestrator.count}/${capacitySnapshot.orchestrator.window}) ${floorMark} floor ${floorPct}%`);
    lines.push(`• Target: ${tgtPct}% (${capacitySnapshot.target.count}/${capacitySnapshot.orchestrator.window})`);
    if (capacitySnapshot.idle.count > 0) {
      lines.push(`• Idle (excluded): ${capacitySnapshot.idle.count}`);
    }
  } else {
    lines.push("• No cycle history yet — capacity floor not enforceable");
  }
  lines.push("");

  // Builder Health (issue #732) — the builder-side scorecard. Degrades to a
  // single "no data yet" line when every sub-source is empty.
  for (const l of formatBuilderHealthLines(builderHealth)) lines.push(l);

  // Research
  const researchCompletes = events.filter(e => e.type === "research:completed");
  if (researchCompletes.length > 0) {
    for (const e of researchCompletes) {
      lines.push(`*Research:* ${e.payload?.opportunityCount || 0} opportunities found, ${e.payload?.autoQueued || 0} auto-queued`);
    }
    lines.push("");
  }

  // Architect reviews
  const architectReviews = events.filter(e => e.type === "architect:review_completed");
  if (architectReviews.length > 0) {
    for (const e of architectReviews) {
      lines.push(`*Architect Review:* ${e.payload?.updatesApplied || 0} methodology updates`);
    }
    lines.push("");
  }

  // Action items
  const actionItems = [];
  const stalePriorities = events.filter(e => e.type === "cycle:stale_priorities");
  if (stalePriorities.length > 0) {
    actionItems.push("⚠️ Priorities doc is stale — update direction/priorities.md");
  }
  const verificationFailures = events.filter(e => e.type === "task:verification_failed");
  if (verificationFailures.length >= 3) {
    actionItems.push(`⚠️ ${verificationFailures.length} verification failures — check agent feedback or priorities`);
  }
  const rollbacks = events.filter(e => e.type === "cycle:rollback");
  if (rollbacks.length > 0) {
    actionItems.push(`⚠️ ${rollbacks.length} auto-rollback(s) — regressions detected and reverted`);
  }
  // Outcome Holdback events (issue #244, ADR-0004 step 4; #741 carry-up).
  // These are self-modification reverts driven by leading-outcome regression,
  // distinct from the test-regression rollbacks above. The holdback now carries
  // up the ladder (T2/T3/T4 enroll; T1 exempt — #741), so the label is
  // tier-neutral rather than implying Tier-2 only.
  const holdbackReverts = events.filter(e => e.type === "holdback.reverted");
  if (holdbackReverts.length > 0) {
    actionItems.push(`⚠️ ${holdbackReverts.length} Outcome Holdback auto-revert(s) — leading outcomes regressed after self-mod`);
    for (const e of holdbackReverts.slice(0, 3)) {
      const sha = (e.payload?.commitSha || "?").toString().slice(0, 7);
      const regressed = e.payload?.regressedOutcomes;
      const outs = Array.isArray(regressed) ? regressed.join(", ") : "?";
      actionItems.push(`  • ${sha} — ${outs}`);
    }
  }
  const holdbackCapReached = events.filter(e => e.type === "holdback.cap-reached");
  if (holdbackCapReached.length > 0) {
    actionItems.push(`⚠️ Per-day Outcome Holdback revert cap reached — additional regressions suppressed (${holdbackCapReached.length} event(s))`);
  }
  const holdbackRevertFailed = events.filter(e => e.type === "holdback.revert_failed");
  if (holdbackRevertFailed.length > 0) {
    actionItems.push(`⚠️ ${holdbackRevertFailed.length} Outcome Holdback revert attempt(s) failed — manual intervention needed`);
  }

  if (actionItems.length > 0) {
    lines.push("*Action items:*");
    for (const item of actionItems) lines.push(item);
    lines.push("");
  }

  const period = events.length > 0
    ? `${events[0].timestamp.split("T")[1]?.slice(0, 5) || "?"} — ${events[events.length - 1].timestamp.split("T")[1]?.slice(0, 5) || "?"}`
    : "no events";
  lines.push(`_Period: ${period}_`);

  // Truncate if too long for Telegram
  let message = lines.join("\n");
  if (message.length > MAX_DIGEST_LENGTH) {
    message = message.slice(0, MAX_DIGEST_LENGTH - 20) + "\n\n_(truncated)_";
  }

  return message;
}

/**
 * Pure helper — exported for tests. Render the Builder-Health Scorecard block
 * for the digest. Always emits the `*Builder health:*` header; degrades to a
 * single "no data yet" line when the scorecard is null or every metric slot
 * is empty. Mirrors the Capacity-split block's always-render contract so the
 * operator can see the scorecard is being tracked even when quiet.
 */
export function formatBuilderHealthLines(builderHealth) {
  const lines = ["*Builder health:*"];
  const bh = builderHealth;
  const auto = bh?.autonomyRate;
  const ttm = bh?.timeToMerge;
  const rework = bh?.reworkRate;
  const share = bh?.selfImprovementShare;
  const scope = bh?.scopeViolations;
  const learning = bh?.learningThroughput;

  const hasData =
    (auto && auto.total > 0) ||
    (ttm && ttm.samples > 0) ||
    (rework && rework.window > 0) ||
    (share && share.window > 0) ||
    (scope && scope.total > 0) ||
    (learning && (learning.metaFrictionOpened > 0 || (learning.promotionRate?.length ?? 0) > 0));

  if (!hasData) {
    lines.push("• No builder-health data yet — scorecard tracking enabled");
    lines.push("");
    return lines;
  }

  if (auto && auto.total > 0) {
    const pct = Math.round((auto.rate || 0) * 100);
    lines.push(`• Autonomy: ${pct}% (${auto.autonomous}/${auto.total} merged PRs zero-intervention)`);
  }
  if (ttm && ttm.samples > 0 && ttm.medianMinutes != null) {
    const med = formatMinutes(ttm.medianMinutes);
    const p90 = ttm.p90Minutes != null ? formatMinutes(ttm.p90Minutes) : "—";
    lines.push(`• Time-to-merge: median ${med}, p90 ${p90} (${ttm.samples} merges)`);
  }
  if (share && share.window > 0) {
    const pct = Math.round((share.share || 0) * 100);
    const mark = share.floorMet ? "✅" : "⚠️";
    lines.push(`• Self-improvement share: ${pct}% ${mark} floor ${Math.round((share.floor || 0.25) * 100)}%`);
  }
  if (rework && rework.window > 0) {
    lines.push(`• Rework: ${rework.regressionRate}% regressions, ${rework.noOpMergeRate}% no-op merges`);
  }
  if (scope) {
    lines.push(`• Scope violations: ${scope.total} in last ${scope.windowDays}d`);
  }
  if (learning) {
    lines.push(`• Learning: ${learning.metaFrictionOpened} meta-friction opened, ${learning.designConceptsProducedToday} design-concepts today`);
  }
  lines.push("");
  return lines;
}

function formatMinutes(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m)) return "—";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 24 * 60) return `${(m / 60).toFixed(1)}h`;
  return `${(m / (24 * 60)).toFixed(1)}d`;
}

/**
 * Format a critical alert event into its Telegram string.
 *
 * Every `case` references a `NOTIFICATION_EVENT_TYPES` member (aliased `E`) —
 * the typed vocabulary in `event-bus.ts` (issue #1182), satisfying the
 * design-concept invariant that the digest critical-alert switch is typed
 * against the source-of-truth map — so a misspelled event type is a compile
 * error, and adding a new type surfaces here as a non-exhaustive switch.
 */
export function formatCriticalAlert(event) {
  const type = event.type || "unknown";
  const payload = event.payload || {};

  switch (type) {
    case E.CYCLE_ROLLBACK_FAILED:
      return `🚨 *CRITICAL: Rollback Failed*\nTask: ${payload.title}\nCommit: \`${payload.commitSha?.slice(0, 7)}\`\nError: ${payload.error}\n\n⚠️ Manual intervention required immediately`;
    case E.SCHEDULER_STOPPED:
      return `🛑 *Scheduler Stopped*\nReason: ${payload.reason}\nCycles run: ${payload.cyclesRun}`;
    case E.SCHEDULER_PAUSED_REPETITION:
      return `🔁 *Scheduler Paused — Repetitive Work*\n${payload.reason}\n\nRecent tasks:\n${(payload.recentTitles || []).map(t => `• ${t.slice(0, 70)}`).join("\n")}\n\n${payload.suggestion}`;
    case E.SCHEDULER_BACKLOG_EMPTY:
      return `📭 *Backlog Empty*\n${payload.message}\n\n${payload.suggestion}`;
    default:
      return `⚠️ *${type}*\n${JSON.stringify(payload).slice(0, 300)}`;
  }
}

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
 * `src/digest.ts` into this pure-core seam).
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
