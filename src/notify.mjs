/**
 * Notification Bridge
 *
 * Consumes events from hydra:notifications Redis stream
 * and sends them to Telegram via the OpenClaw CLI.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TELEGRAM_TARGET = process.env.OPENCLAW_TELEGRAM_TARGET || "8291726150";
const CONFIG_PATH = resolve(process.env.HOME, ".openclaw", "openclaw.json");

let gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

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

/**
 * Format a notification event into a readable Telegram message.
 */
function formatMessage(event) {
  const type = event.type || "unknown";
  const payload = event.payload || {};

  switch (type) {
    // --- Cycle lifecycle ---

    case "cycle:start":
      return `🔄 *Cycle Started*\n\`${payload.cycleId}\``;

    case "cycle:completed": {
      // V2 control loop sends the full reality report as payload
      const task = payload.task;
      const g = payload.grounding;
      if (task) {
        const icon = task.finalState === "merged" ? "✅" : task.finalState === "rolled-back" ? "⏪" : "📋";
        const lines = [
          `${icon} *Cycle Complete — ${task.finalState}*`,
          `\`${payload.cycleId}\``,
          `Task: ${task.title}`,
        ];
        if (g) lines.push(`Tests: ${g.before?.passed ?? "?"} → ${g.after?.passed ?? "?"} passing`);
        if (payload.commitSha) lines.push(`Commit: \`${payload.commitSha.slice(0, 7)}\``);
        if (payload.filesChanged?.length > 0) lines.push(`Files: ${payload.filesChanged.length} changed`);
        if (payload.rolledBack) lines.push(`⚠️ Regression detected — auto-reverted`);
        if (payload.rollbackRisk === "high") lines.push(`Risk: HIGH`);
        const dur = payload.durationMs ? `${Math.round(payload.durationMs / 1000)}s` : "?";
        lines.push(`Duration: ${dur}`);
        return lines.join("\n");
      }
      // Fallback for task-tracker format
      const total = payload.total ?? "?";
      const completed = payload.completed ?? "?";
      const failed = payload.failed ?? 0;
      return `✅ *Cycle Complete*\n${completed}/${total} tasks succeeded${failed > 0 ? `, ${failed} failed` : ""}`;
    }

    case "cycle:stalled":
      return `🐢 *Cycle Stalled*\n\`${payload.cycleId}\`\nElapsed: ${payload.elapsed}\n${payload.inProgress} tasks still active`;

    case "cycle:failed":
      return `❌ *Cycle Failed*\n\`${payload.cycleId}\`\nError: ${payload.error}`;

    case "cycle:auto_killed":
      return `💀 *Cycle Auto-Killed*\n\`${payload.cycleId}\`\nExceeded TTL (${payload.elapsed} > ${payload.ttl})\n${payload.tasksTimedOut} tasks timed out`;

    case "cycle:stale_priorities":
      return `📝 *Stale Priorities*\n${payload.message}`;

    // --- Task events ---

    case "task:rejected":
      return `🚫 *Task Rejected by Skeptic*\n\`${payload.taskId}\`\n"${payload.title}"\nReason: ${payload.reason}`;

    case "task:verification_failed":
      return `❌ *Verification Failed*\n\`${payload.taskId}\`\n"${payload.title}"\nFailed: ${(payload.failedSteps || []).join(", ")}`;

    case "task:drift_detected":
      return `🔁 *Drift Detected*\n\`${payload.taskId}\`\n"${payload.title}"\n${payload.drift?.reason || "Duplicate of recent work"}`;

    case "task:merge_failed":
      return `⚠️ *Merge Failed*\n\`${payload.taskId}\`\n"${payload.title}"\nError: ${payload.error}`;

    case "task:shelved":
      return `📦 *Task Shelved*\n\`${payload.taskId}\`\nReason: ${payload.reason}`;

    // --- Rollback ---

    case "cycle:rollback":
      return `⏪ *Auto-Rollback*\n\`${payload.cycleId}\`\nTask: ${payload.title}\nReverted: \`${payload.revertedCommit?.slice(0, 7)}\`\nTests: ${payload.testsBefore} → ${payload.testsAfter} passing`;

    case "cycle:rollback_failed":
      return `🚨 *Rollback FAILED — Manual Fix Needed*\n\`${payload.cycleId}\`\nTask: ${payload.title}\nCommit: \`${payload.commitSha?.slice(0, 7)}\`\nError: ${payload.error}\nTests: ${payload.testsBefore} → ${payload.testsAfter}`;

    // --- Scheduler ---

    case "scheduler:stopped":
      return `⏹️ *Scheduler Stopped*\nReason: ${payload.reason}\nCycles run: ${payload.cyclesRun}`;

    // --- Research ---

    case "research:completed": {
      const lines = [
        `🔬 *Research Complete*`,
        `Project: ${payload.projectName}`,
        `${payload.opportunityCount} opportunities found, ${payload.autoQueued} auto-queued`,
        `Duration: ${payload.duration} | Cost: ${payload.cost}`,
      ];
      if (payload.topOpportunities?.length > 0) {
        lines.push("", "Top picks:");
        for (const opp of payload.topOpportunities) lines.push(`• ${opp}`);
      }
      if (payload.summary) lines.push("", payload.summary);
      return lines.join("\n");
    }

    case "architect:review_completed":
      return `🏗️ *Architect Review*\n${payload.researchCyclesReviewed} research + ${payload.executionCyclesReviewed} execution cycles reviewed\n${payload.updatesApplied} methodology updates\nCalibration: ${payload.calibration}`;

    // --- Proposals ---

    case "proposal:created":
      return `💡 *New Proposal*\n${payload.proposalId || `#${payload.id}`}\nTitle: ${payload.title}\nType: ${payload.type} | Risk: ${payload.risk}`;

    case "proposal:approved":
      return `✅ *Proposal Approved*\n${payload.proposalId || `#${payload.id}`}: ${payload.title}`;

    // --- Deploy ---

    case "deploy:completed":
      return `🚀 *Deployed*\n\`${payload.taskId}\``;

    case "deploy:failed":
      return `⚠️ *Deploy Failed*\n\`${payload.taskId}\`\nReason: ${payload.reason || "unknown"}`;

    // --- DLQ ---

    case "dlq:alert":
      return `🔴 *Dead Letter*\nStream: ${payload.originalStream}\nEvent: ${payload.eventType}\nError: ${payload.error}\nAttempts: ${payload.deliveryCount}`;

    default:
      if (type.includes("failed")) {
        return `⚠️ *${type}*\n${payload.reason || payload.summary || JSON.stringify(payload).slice(0, 300)}`;
      }
      return `📋 *${type}*\n${payload.summary || payload.title || JSON.stringify(payload).slice(0, 300)}`;
  }
}

/**
 * Send a notification to Telegram via OpenClaw CLI.
 */
async function sendNotification(event) {
  const token = await getGatewayToken();
  if (!token) {
    console.error("[Notify] No gateway token — skipping notification");
    return;
  }

  const message = formatMessage(event);

  try {
    await execFileAsync(
      "openclaw",
      ["message", "send", "--channel", "telegram", "--target", TELEGRAM_TARGET, "--message", message],
      {
        timeout: 15000,
        env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: token },
      }
    );
    console.log(`[Notify] Sent ${event.type} to Telegram`);
  } catch (err) {
    console.error(`[Notify] Failed to send ${event.type}:`, err.message);
  }
}

export { sendNotification, formatMessage };
