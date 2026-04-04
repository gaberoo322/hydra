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

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TELEGRAM_TARGET = process.env.OPENCLAW_TELEGRAM_TARGET || "8291726150";
const CONFIG_PATH = resolve(process.env.HOME, ".openclaw", "openclaw.json");
const DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIET_START_HOUR = 22; // 10pm
const QUIET_END_HOUR = 7; // 7am

let gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

// Accumulated events since last digest
let pendingEvents = [];
let lastDigestAt = null;
let digestTimer = null;

async function getGatewayToken() {
  if (gatewayToken) return gatewayToken;
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    gatewayToken = cfg.gateway?.auth?.token;
    return gatewayToken;
  } catch {
    return null;
  }
}

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

    // List merged tasks
    if (merged.length > 0) {
      lines.push("*Merged:*");
      for (const e of merged) {
        const task = e.payload?.task;
        const sha = e.payload?.commitSha?.slice(0, 7);
        const link = sha ? `https://github.com/gaberoo322/hydra-betting/commit/${e.payload.commitSha}` : "";
        lines.push(`• ${task?.title || "?"}${sha ? ` (${link})` : ""}`);
      }
      lines.push("");
    }

    // List failures
    if (failed.length > 0) {
      lines.push("*Failed:*");
      for (const e of failed) {
        const task = e.payload?.task;
        lines.push(`• ${task?.title || "?"} — ${task?.finalState || "failed"}`);
      }
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

  // Backlog/queue state (from the most recent cycle)
  const lastCycle = cycleCompletes[cycleCompletes.length - 1];
  if (lastCycle) {
    lines.push("*Queue state at end of period — check with:*");
    lines.push("`curl http://localhost:4000/backlog/counts`");
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

  return lines.join("\n");
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

async function sendToTelegram(message) {
  const token = await getGatewayToken();
  if (!token) {
    console.error("[Digest] No gateway token — skipping");
    return;
  }

  try {
    await execFileAsync(
      "openclaw",
      ["message", "send", "--channel", "telegram", "--target", TELEGRAM_TARGET, "--message", message],
      {
        timeout: 15000,
        env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: token },
      },
    );
  } catch (err) {
    console.error(`[Digest] Failed to send:`, err.message);
  }
}

/**
 * Start the digest timer. Call once at startup.
 */
export function startDigest() {
  // Send first digest after 4 hours (or at the next non-quiet window)
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

export { sendToTelegram };
