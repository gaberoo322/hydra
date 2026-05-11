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

const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIET_START_HOUR = 22; // 10pm
const QUIET_END_HOUR = 7; // 7am
const MAX_DIGEST_LENGTH = 4000; // Telegram's ~4096 char limit with margin

// Accumulated events since last digest
let pendingEvents = [];
let lastDigestAt = null;
let digestTimer = null;

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

  const message = buildDigestMessage(events);
  await sendToTelegram(message);
  console.log(`[Digest] Sent digest (${events.length} events)`);
}

function buildDigestMessage(events) {
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

  // Stuckness (issue #242) — surface outcomes that transitioned into stuck
  // since the last digest. The detector only emits one event per transition,
  // so each appearance here is a meaningful signal (not noise). When no
  // outcomes fired we still print the heading so the operator can see the
  // detector is alive — per CONTEXT.md "the bar is that the digest surfaces
  // it before the operator has to ask".
  const stucknessFired = events.filter(e => e.type === "outcomes.stuckness.fired");
  lines.push("*Stuckness:*");
  if (stucknessFired.length === 0) {
    lines.push("• No outcomes stuck");
  } else {
    for (const e of stucknessFired) {
      const name = e.payload?.outcome || "?";
      const cycles = e.payload?.cyclesStuck ?? "?";
      const threshold = e.payload?.threshold ?? "?";
      lines.push(`• ${name} — stuck for ${cycles} cycles (threshold: ${threshold})`);
    }
  }
  lines.push("");

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
  console.log(`[Digest] Started — summaries every ${DIGEST_INTERVAL_MS / 3600_000}h, quiet ${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00`);
}

export function stopDigest() {
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}

/**
 * Force send a digest now (for manual trigger via API).
 */
export async function sendDigestNow() {
  await sendDigest();
}

/**
 * Build a weekly progress summary for the operator.
 */
export async function buildWeeklySummary() {
  const { getMetricsTrend, getFixFeatureRatio } = await import("./metrics.ts");
  const { _admin: backlogAdmin } = await import("./backlog.ts");
  const { getCurrentMilestoneProgress, getBacklogCounts } = backlogAdmin;

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
