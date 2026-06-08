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
 *
 * # Pure core vs. orchestration (issue #1181)
 *
 * The pure assembly grammar (`buildDigestMessage`, `buildDailyHeartbeat`,
 * `formatCriticalAlert`, `formatBuilderHealthLines`) lives in
 * `./digest-format.ts` — no timers, no Telegram calls, no module state, and
 * fully testable. THIS module keeps the side-effecting wrappers (`startDigest`,
 * `stopDigest`, `sendDigestNow`, `sendDailyHeartbeatNow`) and the only mutable
 * state (`pendingEvents`, `lastDigestAt`, the timer handles) as thin
 * orchestrators over that core. The formatters are re-exported here so existing
 * importers of `./digest.ts` are unaffected.
 */

import { sendToTelegram } from "./notify.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "./event-bus.ts";
import { getCapacitySnapshot, DEFAULT_WINDOW_CYCLES } from "./capacity-floor.ts";
import { getBuilderHealthScorecard } from "./aggregators/builder-health.ts";
import {
  buildDigestMessage,
  buildDailyHeartbeat,
  formatCriticalAlert,
  formatBuilderHealthLines,
} from "./digest-format.ts";

// Re-export the pure-core formatters so existing importers of ./digest.ts that
// reach for these (e.g. formatBuilderHealthLines, previously exported here)
// keep working without churn.
export { formatBuilderHealthLines };

const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIET_START_HOUR = 22; // 10pm
const QUIET_END_HOUR = 7; // 7am

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

  // Critical events bypass digest and send immediately. Members reference the
  // typed NOTIFICATION_EVENT_TYPES vocabulary (issue #1182) so a misspelled
  // event type here is a compile error.
  const critical: string[] = [
    E.CYCLE_ROLLBACK_FAILED,
    E.SCHEDULER_STOPPED,
    E.SCHEDULER_PAUSED_REPETITION,
    E.SCHEDULER_BACKLOG_EMPTY,
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
