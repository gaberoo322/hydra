/**
 * Digest Notifications
 *
 * Replaces per-event Telegram messages with periodic summaries.
 * Sends a digest every 4 hours during daytime (7am-10pm).
 *
 * Collects events in memory, then formats a summary covering:
 * - Cycles completed since last digest (merged, failed, abandoned)
 * - Research cycles run
 * - Test count changes
 * - Backlog/queue state
 * - Action items (empty backlog, stale priorities, errors needing attention)
 */

import { sendToTelegram } from "./notify.ts";
import { getTargetCommitUrl } from "./target-config.ts";
import { getCapacitySnapshot, DEFAULT_WINDOW_CYCLES, ORCHESTRATOR_FLOOR } from "./capacity-floor.ts";
import { getBuilderHealthScorecard } from "./aggregators/builder-health.ts";

const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIET_START_HOUR = 22; // 10pm
const QUIET_END_HOUR = 7; // 7am
const MAX_DIGEST_LENGTH = 4000; // Telegram's ~4096 char limit with margin

// Daily heartbeat: a guaranteed once-per-day proof-of-life push. Unlike the
// event-gated 4h alert digest above (which stays SILENT when nothing has gone
// wrong), the heartbeat ALWAYS sends — so a dark/AFK operator can distinguish
// "healthy and quiet" from "crashed and not reporting", and gets a daily
// rollup of liveness, subscription-usage %, throughput, and queue depth.
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Accumulated events since last digest
let pendingEvents = [];
let lastDigestAt = null;
let digestTimer = null;
let heartbeatTimer = null;

function isQuietHours() {
  const hour = new Date().getHours();
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * Record an event for the next digest. Does NOT send immediately.
 * Critical alerts (rollback failures, scheduler stops) still send immediately.
 */
export function recordEvent(event) {
  const type = event.type || "unknown";

  // Critical events bypass digest and send immediately
  const critical = [
    "cycle:rollback_failed",
    "scheduler:stopped",
    "scheduler:paused_repetition",
    "scheduler:backlog_empty",
  ];
  if (critical.includes(type)) {
    sendImmediate(formatCriticalAlert(event));
    return;
  }

  pendingEvents.push({
    type,
    payload: event.payload || {},
    timestamp: new Date().toISOString(),
  });
}

/**
 * Format and send the digest.
 */
async function sendDigest() {
  if (isQuietHours()) {
    console.log("[Digest] Quiet hours — skipping digest");
    return;
  }

  if (pendingEvents.length === 0) {
    console.log("[Digest] No events since last digest — skipping");
    return;
  }

  const events = [...pendingEvents];
  pendingEvents = [];
  lastDigestAt = new Date().toISOString();

  // Issue #245: capacity-split snapshot for the digest. Failures are
  // non-fatal — digest still ships if Redis is unavailable.
  let capacitySnapshot = null;
  try {
    capacitySnapshot = await getCapacitySnapshot(DEFAULT_WINDOW_CYCLES);
  } catch (err: any) {
    console.error(`[Digest] capacity-floor snapshot failed (non-fatal): ${err.message}`);
  }

  // Issue #732: Builder-Health Scorecard for the digest. The aggregator
  // never throws by contract; this try/catch is belt-and-braces so a
  // surprise still ships the digest.
  let builderHealth = null;
  try {
    builderHealth = await getBuilderHealthScorecard();
  } catch (err: any) {
    console.error(`[Digest] builder-health scorecard failed (non-fatal): ${err.message}`);
  }

  const message = buildDigestMessage(events, capacitySnapshot, builderHealth);
  await sendToTelegram(message);
  console.log(`[Digest] Sent digest (${events.length} events)`);
}

function buildDigestMessage(events, capacitySnapshot = null, builderHealth = null) {
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
        const link = sha ? getTargetCommitUrl(e.payload.commitSha) : "";
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
      const outs = Array.isArray(e.payload?.regressedOutcomes) ? e.payload.regressedOutcomes.join(", ") : "?";
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

function formatCriticalAlert(event) {
  const type = event.type || "unknown";
  const payload = event.payload || {};

  switch (type) {
    case "cycle:rollback_failed":
      return `🚨 *CRITICAL: Rollback Failed*\nTask: ${payload.title}\nCommit: \`${payload.commitSha?.slice(0, 7)}\`\nError: ${payload.error}\n\n⚠️ Manual intervention required immediately`;
    case "scheduler:stopped":
      return `🛑 *Scheduler Stopped*\nReason: ${payload.reason}\nCycles run: ${payload.cyclesRun}`;
    case "scheduler:paused_repetition":
      return `🔁 *Scheduler Paused — Repetitive Work*\n${payload.reason}\n\nRecent tasks:\n${(payload.recentTitles || []).map(t => `• ${t.slice(0, 70)}`).join("\n")}\n\n${payload.suggestion}`;
    case "scheduler:backlog_empty":
      return `📭 *Backlog Empty*\n${payload.message}\n\n${payload.suggestion}`;
    default:
      return `⚠️ *${type}*\n${JSON.stringify(payload).slice(0, 300)}`;
  }
}

async function sendImmediate(message) {
  if (isQuietHours()) {
    console.log("[Digest] Critical alert during quiet hours — sending anyway");
  }
  await sendToTelegram(message);
}

/**
 * Start the digest timer. Call once at startup.
 */
export function startDigest() {
  digestTimer = setInterval(() => sendDigest(), DIGEST_INTERVAL_MS);
  // Guaranteed daily proof-of-life. Fires unconditionally (no quiet-hours /
  // no empty-skip gate) so the operator always gets one push per day.
  heartbeatTimer = setInterval(() => {
    sendDailyHeartbeat().catch((err) =>
      console.error(`[Digest] daily heartbeat failed (non-fatal): ${err?.message || err}`),
    );
  }, HEARTBEAT_INTERVAL_MS);
  console.log(
    `[Digest] Started — summaries every ${DIGEST_INTERVAL_MS / 3600_000}h, quiet ${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00; ` +
      `daily heartbeat every ${HEARTBEAT_INTERVAL_MS / 3600_000}h`,
  );
}

export function stopDigest() {
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Force send a digest now (for manual trigger via API).
 */
export async function sendDigestNow() {
  await sendDigest();
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
 */
export async function buildDailyHeartbeat(): Promise<string> {
  const lines = ["💓 *Hydra Daily Heartbeat*", ""];

  // --- Liveness: latest autopilot run + age ---
  try {
    const { listRecentAutopilotRunIds, getAutopilotRun } = await import(
      "./redis/autopilot-runs.ts"
    );
    const [latestId] = await listRecentAutopilotRunIds(1);
    if (latestId) {
      const run = await getAutopilotRun(latestId);
      const startedEpoch = Number(run.started_epoch || 0);
      const ageMin = startedEpoch > 0 ? Math.round((Date.now() / 1000 - startedEpoch) / 60) : null;
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
    const { getUsage } = await import("./cost/usage-tracker.ts");
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
    const health = await getBuilderHealthScorecard();
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
    const { getBacklogCounts } = await import("./backlog/reads.ts");
    const counts = await getBacklogCounts();
    lines.push(
      `*Target backlog:* ${counts.queued || 0} queued, ${counts.blocked || 0} blocked, ${counts.triage || 0} triage`,
    );
  } catch (err: any) {
    lines.push(`*Target backlog:* n/a (${err?.message || err})`);
  }

  // --- Alerts: count recorded in the last 24h ---
  try {
    const { readRecentAlerts } = await import("./redis/alerts.ts");
    const raw = await readRecentAlerts(100);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    let count = 0;
    for (const a of raw) {
      try {
        const ts = JSON.parse(a)?.timestamp;
        if (!ts || new Date(ts).getTime() >= since) count++;
      } catch {
        count++; // unparseable → count it rather than hide it
      }
    }
    lines.push(`*Alerts (24h):* ${count}${count > 0 ? " — see the 4h alert digest" : ""}`);
  } catch (err: any) {
    lines.push(`*Alerts (24h):* n/a (${err?.message || err})`);
  }

  return lines.filter(Boolean).join("\n");
}

/**
 * Build and send the daily heartbeat. ALWAYS sends — no quiet-hours gate and
 * no empty-skip — because the whole point is a guaranteed daily proof-of-life.
 */
async function sendDailyHeartbeat() {
  const message = await buildDailyHeartbeat();
  await sendToTelegram(message);
  console.log("[Digest] Sent daily heartbeat");
}

/**
 * Force-send the daily heartbeat now (manual trigger via API). Lets the
 * operator verify Telegram delivery on demand without waiting 24h.
 */
export async function sendDailyHeartbeatNow() {
  await sendDailyHeartbeat();
}

/**
 * Build a weekly progress summary for the operator.
 */
export async function buildWeeklySummary() {
  const { getMetricsTrend } = await import("./metrics/trend.ts");
  const { getFixFeatureRatio } = await import("./metrics/aggregate.ts");
  const { getCurrentMilestoneProgress, getBacklogCounts } = await import("./backlog/reads.ts");

  const trend = await getMetricsTrend(50);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
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
