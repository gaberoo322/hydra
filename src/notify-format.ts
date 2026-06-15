/**
 * Notification Formatter (pure core) — issue #1512.
 *
 * The pure formatting grammar lifted out of `src/notify.ts`, following the
 * `digest.ts` / `digest-format.ts` precedent (#1181). `formatMessage` maps a
 * `NOTIFICATION_EVENT_TYPES` event to a Telegram-flavored Markdown string with
 * **no env reads, no `fetch`, and no module-level mutable state** — so every
 * arm of the switch (30+ event types, the dual-shape `cycle:completed` payload,
 * the `reescalation` branch in `cycle:operator_blocked`) is testable without a
 * network or a fake Telegram endpoint.
 *
 * The I/O transport (`sendToTelegram` / `sendNotification`) stays in
 * `src/notify.ts`, which imports this module one-directionally and re-exports
 * `formatMessage` so existing callers (`notification-consumer.ts`, `digest.ts`,
 * `scheduler/housekeeping.ts`, and the review-pickup test) need zero changes.
 *
 * The on-wire output is unchanged from the pre-extraction `notify.ts` — this
 * concentrates where the grammar lives, not the format itself.
 */

import { getTargetCommitUrl } from "./target-config.ts";
import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "./event-bus.ts";

/**
 * The event vocabulary the notification grammar reads (issue #1857; shared
 * source-of-truth derivation, issue #1915).
 *
 * `formatMessage` is fed loosely-typed `NOTIFICATION_EVENT_TYPES` events from
 * the bus (ultimately the same `NotificationEvent` shapes `notify.ts` and
 * `notification-consumer.ts` carry). The `payload` shape is DERIVED from the
 * shared `NotificationEventPayload` vocabulary in `event-bus.ts` — this
 * formatter `Pick`s exactly the subset of fields its switch touches via
 * `event.type` and the `event.payload?.…` paths below — so a renamed payload
 * field (e.g. `task.finalStatus` instead of `task.finalState`, or
 * `payload.cyclId` instead of `payload.cycleId`) is a one-file edit in the
 * shared vocabulary that becomes a compile error here, rather than a silent
 * runtime miss in the Telegram body.
 *
 * The shared vocabulary stays OPEN (`Record<string, unknown> & {…}`) at its
 * source, and `Pick` preserves that index signature, so the bus's full event
 * vocabulary still type-checks through; the picked fields are only the subset
 * this grammar narrows on. A producer renaming a read field is caught; a
 * producer adding an *unread* field is not constrained.
 *
 * - `type` is OPTIONAL because the formatter defaults it (`event.type ||
 *   "unknown"`) and the `default` arms are deliberately exercised with
 *   type-less events (`formatMessage({})`). Keeping it optional preserves
 *   assignment-compatibility for every existing caller.
 * - `payload` is OPTIONAL because the formatter defaults it
 *   (`event.payload || {}`).
 *
 * The `Pick` list below is the exhaustive read set of the switch — every
 * top-level `payload.<x>` and nested `payload.task?.…` / `payload.grounding?.…`
 * / `payload.drift?.…` path an arm dereferences. On-wire output is unchanged;
 * this concentrates the payload contract in the shared vocabulary, not the
 * format.
 */
export interface FormatMessageEvent {
  type?: string;
  payload?: Record<string, unknown> & Pick<
    NotificationEventPayload,
    // --- Cycle lifecycle ---
    | "cycleId"
    | "task"
    | "grounding"
    | "commitSha"
    | "filesChanged"
    | "rolledBack"
    | "rollbackRisk"
    | "durationMs"
    | "total"
    | "completed"
    | "failed"
    | "elapsed"
    | "inProgress"
    | "error"
    | "ttl"
    | "tasksTimedOut"
    | "message"
    // --- Task events ---
    | "taskId"
    | "title"
    | "reason"
    | "failedSteps"
    | "drift"
    // --- Rollback ---
    | "revertedCommit"
    | "testsBefore"
    | "testsAfter"
    // --- Scheduler ---
    | "cyclesRun"
    | "suggestion"
    | "recentTitles"
    // --- Research ---
    | "projectName"
    | "opportunityCount"
    | "autoQueued"
    | "duration"
    | "cost"
    | "topOpportunities"
    | "summary"
    | "researchCyclesReviewed"
    | "executionCyclesReviewed"
    | "updatesApplied"
    | "calibration"
    // --- DLQ ---
    | "originalStream"
    | "eventType"
    | "deliveryCount"
    // --- Review pickup ---
    | "count"
    | "firstTitle"
    | "firstUrl"
    // --- Operator blocked ---
    | "unblockCommands"
    | "blockedReason"
    | "reescalation"
    | "blockedDays"
  >;
}

/**
 * Format a notification event into a readable Telegram message.
 *
 * Every `case` references a `NOTIFICATION_EVENT_TYPES` member (aliased `E`) —
 * the typed vocabulary in `event-bus.ts` (issue #1182) — so a misspelled event
 * type is a compile error, and adding a new type surfaces here as a missing arm.
 * The `event` parameter is typed `FormatMessageEvent` (issue #1857) so the
 * payload fields the switch reads are contract-checked too, not just the case
 * labels.
 */
export function formatMessage(event: FormatMessageEvent): string {
  const type = event.type || "unknown";
  const payload = event.payload || {};

  switch (type) {
    // --- Cycle lifecycle ---

    case E.CYCLE_START:
      return `🔄 *Cycle Started*\n\`${payload.cycleId}\``;

    case E.CYCLE_COMPLETED: {
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
      // Fallback for the count-only cycle:completed payload shape
      const total = payload.total ?? "?";
      const completed = payload.completed ?? "?";
      const failed = payload.failed ?? 0;
      return `✅ *Cycle Complete*\n${completed}/${total} tasks succeeded${failed > 0 ? `, ${failed} failed` : ""}`;
    }

    case E.CYCLE_STALLED:
      return `🐢 *Cycle Stalled*\n\`${payload.cycleId}\`\nElapsed: ${payload.elapsed}\n${payload.inProgress} tasks still active`;

    case E.CYCLE_FAILED:
      return `❌ *Cycle Failed*\n\`${payload.cycleId}\`\nError: ${payload.error}`;

    case E.CYCLE_AUTO_KILLED:
      return `💀 *Cycle Auto-Killed*\n\`${payload.cycleId}\`\nExceeded TTL (${payload.elapsed} > ${payload.ttl})\n${payload.tasksTimedOut} tasks timed out`;

    case E.CYCLE_STALE_PRIORITIES:
      return `📝 *Stale Priorities*\n${payload.message}`;

    // --- Task events ---

    case E.TASK_REJECTED:
      return `🚫 *Task Rejected by Skeptic*\n\`${payload.taskId}\`\n"${payload.title}"\nReason: ${payload.reason}`;

    case E.TASK_VERIFICATION_FAILED:
      return `❌ *Verification Failed*\n\`${payload.taskId}\`\n"${payload.title}"\nFailed: ${(payload.failedSteps || []).join(", ")}`;

    case E.TASK_DRIFT_DETECTED:
      return `🔁 *Drift Detected*\n\`${payload.taskId}\`\n"${payload.title}"\n${payload.drift?.reason || "Duplicate of recent work"}`;

    case E.TASK_MERGE_FAILED:
      return `⚠️ *Merge Failed*\n\`${payload.taskId}\`\n"${payload.title}"\nError: ${payload.error}`;

    case E.TASK_SHELVED:
      return `📦 *Task Shelved*\n\`${payload.taskId}\`\nReason: ${payload.reason}`;

    // --- Rollback ---

    case E.CYCLE_ROLLBACK:
      return `⏪ *Auto-Rollback*\n\`${payload.cycleId}\`\nTask: ${payload.title}\nReverted: \`${payload.revertedCommit?.slice(0, 7)}\`\nTests: ${payload.testsBefore} → ${payload.testsAfter} passing`;

    case E.CYCLE_ROLLBACK_FAILED:
      return `🚨 *Rollback FAILED — Manual Fix Needed*\n\`${payload.cycleId}\`\nTask: ${payload.title}\nCommit: \`${payload.commitSha?.slice(0, 7)}\`\nError: ${payload.error}\nTests: ${payload.testsBefore} → ${payload.testsAfter}`;

    // --- Scheduler ---

    case E.SCHEDULER_STOPPED:
      return `⏹️ *Scheduler Stopped*\nReason: ${payload.reason}\nCycles run: ${payload.cyclesRun}`;

    case E.SCHEDULER_BACKLOG_EMPTY:
      return `📭 *Backlog Empty*\n${payload.message}\n\n${payload.suggestion}`;

    case E.SCHEDULER_PAUSED_REPETITION:
      return `🔁 *Scheduler Paused — Repetitive Work Detected*\n${payload.reason}\n\nRecent tasks:\n${(payload.recentTitles || []).map(t => `• ${t.slice(0, 70)}`).join("\n")}\n\n${payload.suggestion}`;

    // --- Research ---

    case E.RESEARCH_COMPLETED: {
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

    case E.ARCHITECT_REVIEW_COMPLETED:
      return `🏗️ *Architect Review*\n${payload.researchCyclesReviewed} research + ${payload.executionCyclesReviewed} execution cycles reviewed\n${payload.updatesApplied} methodology updates\nCalibration: ${payload.calibration}`;

    // --- Deploy ---

    case E.DEPLOY_COMPLETED:
      return `🚀 *Deployed*\n\`${payload.taskId}\``;

    case E.DEPLOY_FAILED:
      return `⚠️ *Deploy Failed*\n\`${payload.taskId}\`\nReason: ${payload.reason || "unknown"}`;

    // --- DLQ ---

    case E.DLQ_ALERT:
      return `🔴 *Dead Letter*\nStream: ${payload.originalStream}\nEvent: ${payload.eventType}\nError: ${payload.error}\nAttempts: ${payload.deliveryCount}`;

    // --- /hydra-review pickup set (issue #745) ---

    case E.REVIEW_PICKUP_READY: {
      const count = payload.count ?? 0;
      const lines = [
        `📥 *Review queue — ${count} item${count === 1 ? "" : "s"} need attention*`,
        "Run `/hydra-review` to triage.",
      ];
      if (payload.firstTitle) {
        const link = payload.firstUrl ? ` — ${payload.firstUrl}` : "";
        lines.push("", `First: ${payload.firstTitle}${link}`);
      }
      return lines.join("\n");
    }

    // --- Operator blocked ---

    case E.CYCLE_OPERATOR_BLOCKED: {
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
