/**
 * Notification Bridge
 *
 * Consumes events from hydra:notifications Redis stream
 * and sends them to Telegram via the Bot API.
 */

import { getTargetCommitUrl } from "./target-config.ts";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_TARGET = process.env.TELEGRAM_CHAT_ID || "8291726150";

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
        if (payload.commitSha) lines.push(`Commit: \`${payload.commitSha.slice(0, 7)}\` — ${getTargetCommitUrl(payload.commitSha)}`);
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

    case "scheduler:backlog_empty":
      return `📭 *Backlog Empty*\n${payload.message}\n\n${payload.suggestion}`;

    case "scheduler:paused_repetition":
      return `🔁 *Scheduler Paused — Repetitive Work Detected*\n${payload.reason}\n\nRecent tasks:\n${(payload.recentTitles || []).map(t => `• ${t.slice(0, 70)}`).join("\n")}\n\n${payload.suggestion}`;

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

    // --- Operator blocked ---

    case "cycle:operator_blocked": {
      const cmds = (payload.unblockCommands || []).map(c => `\`${c}\``).join("\n");
      const lines = [
        `🚧 *BLOCKED — Operator Action Required*`,
        `Task: "${payload.title}"`,
        `Reason: ${payload.blockedReason || "unknown"}`,
      ];
      if (cmds) {
        lines.push("", "*To unblock, run:*", cmds);
      }
      if (payload.reescalation) {
        lines.push("", `_Re-alert — blocked for ${payload.blockedDays || "?"}+ days_`);
      }
      return lines.join("\n");
    }

    default:
      if (type.includes("failed")) {
        return `⚠️ *${type}*\n${payload.reason || payload.summary || JSON.stringify(payload).slice(0, 300)}`;
      }
      return `📋 *${type}*\n${payload.summary || payload.title || JSON.stringify(payload).slice(0, 300)}`;
  }
}

/**
 * Send a message to Telegram via the Bot API.
 */
async function sendToTelegram(message, target = TELEGRAM_TARGET) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("[Notify] TELEGRAM_BOT_TOKEN not set — skipping");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      console.error(`[Notify] Telegram API error (${response.status}):`, body);
    }
  } catch (err) {
    console.error(`[Notify] Telegram send failed:`, err.message);
  }
}

/**
 * Send a notification to Telegram.
 */
async function sendNotification(event) {
  const message = formatMessage(event);

  try {
    await sendToTelegram(message);
    console.log(`[Notify] Sent ${event.type} to Telegram`);
  } catch (err) {
    console.error(`[Notify] Failed to send ${event.type}:`, err.message);
  }
}

export { sendNotification, formatMessage, sendToTelegram };
