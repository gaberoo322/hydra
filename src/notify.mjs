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
    case "cycle:tasks_created":
      return `🔄 *Hydra Cycle Started*\nCycle: \`${payload.cycleId}\`${payload.goal ? `\nGoal: ${payload.goal}` : ""}\nTasks: ${payload.taskCount}\n${(payload.tasks || []).map(t => `• ${t}`).join("\n")}`;

    case "cycle:constraint_warning":
      return `⚠️ *Constraint Warning*\n${payload.taskCount} tasks created, but ${(payload.flagged || []).length} may violate constraints:\n${(payload.flagged || []).map(f => `• "${f.task}" → ${f.constraint}`).join("\n")}`;

    case "cycle:completed":
      return `✅ *Cycle Complete*\nTasks: ${payload.total} total, ${payload.completed} succeeded, ${payload.failed} failed`;

    case "cycle:stalled":
      return `🐢 *Cycle Stalled*\nCycle: \`${payload.cycleId}\`\nElapsed: ${payload.elapsed}\nTasks still in progress: ${payload.inProgress}`;

    case "cycle:failed":
      return `❌ *Cycle Failed*\nCycle: \`${payload.cycleId}\`\nError: ${payload.error}`;

    case "proposal:created":
      return `💡 *New Proposal #${payload.id}*\nTitle: ${payload.title}\nType: ${payload.type} | Risk: ${payload.risk}\nImpact: ${payload.impact || "unspecified"}`;

    case "proposal:approved":
      return `✅ *Proposal #${payload.id} Approved*\n${payload.title}`;

    case "task:shelved":
      return `📦 *Task Shelved*\n\`${payload.taskId}\`\nReason: ${payload.reason}`;

    case "fix:created":
      return `🔧 *Fix Task Created*\n\`${payload.fixTaskId}\`\nFailure: ${payload.failureType}\nAttempt: ${payload.attempt}/${payload.maxAttempts}`;

    case "cycle:rollback":
      return `⏪ *Auto-Rollback*\nCycle: \`${payload.cycleId}\`\nTask: ${payload.title}\nReverted: \`${payload.revertedCommit?.slice(0, 7)}\`\nTests: ${payload.testsBefore} → ${payload.testsAfter} passing`;

    case "cycle:rollback_failed":
      return `🚨 *Rollback FAILED*\nCycle: \`${payload.cycleId}\`\nTask: ${payload.title}\nCommit: \`${payload.commitSha?.slice(0, 7)}\`\nError: ${payload.error}\nTests: ${payload.testsBefore} → ${payload.testsAfter}\n⚠️ Manual intervention required`;

    case "scheduler:stopped":
      return `⏹️ *Scheduler Stopped*\nReason: ${payload.reason}\nCycles run: ${payload.cyclesRun}`;

    case "deploy:completed":
      return `🚀 *Deployed*\n\`${payload.taskId}\``;

    case "deploy:failed":
      return `⚠️ *Deploy Failed*\n\`${payload.taskId}\`\nReason: ${payload.reason || "unknown"}`;

    default:
      // Generic format for unhandled types
      if (type.includes("failed")) {
        return `⚠️ *${type}*\n${payload.reason || payload.summary || JSON.stringify(payload).slice(0, 200)}`;
      }
      return `📋 *${type}*\n${payload.summary || payload.title || JSON.stringify(payload).slice(0, 200)}`;
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
