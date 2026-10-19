/**
 * Notification Formatter (pure core) — issue #1512.
 *
 * The pure formatting grammar lifted out of `src/notify.ts`, following the
 * `digest.ts` / `digest-format.ts` precedent (#1181). `formatMessage` maps a
 * `NOTIFICATION_EVENT_TYPES` event to a Telegram-flavored Markdown string with
 * **no env reads, no `fetch`, and no module-level mutable state** — so every
 * arm of the switch (the 3 live types with a dedicated arm — the dual-shape
 * `cycle:completed` payload, `dlq:alert`, `review:pickup_ready` — plus the two
 * generic `default` fallbacks) is testable without a network or a fake
 * Telegram endpoint. The codex-era arms whose types had no live producer were
 * deleted in issue #5044.
 *
 * The I/O transport (`sendToTelegram` / `sendNotification`) stays in
 * `src/notify.ts`, which imports this module one-directionally and re-exports
 * `formatMessage`; its only production caller is `notification-consumer.ts`
 * (via `sendNotification`).
 *
 * The on-wire output is unchanged from the pre-extraction `notify.ts` — this
 * concentrates where the grammar lives, not the format itself.
 */

import { getTargetCommitUrl } from "./target-config.ts";
import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "./event-bus-vocabulary.ts";

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
 * path an arm dereferences. On-wire output is unchanged;
 * this concentrates the payload contract in the shared vocabulary, not the
 * format.
 */
export interface FormatMessageEvent {
  type?: string;
  payload?: Record<string, unknown> & Pick<
    NotificationEventPayload,
    // --- Cycle lifecycle (cycle:completed) ---
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
    // --- DLQ ---
    | "originalStream"
    | "eventType"
    | "deliveryCount"
    | "error"
    // --- Review pickup ---
    | "count"
    | "firstTitle"
    | "firstUrl"
    // --- default arms ---
    | "reason"
    | "summary"
    | "title"
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

    default:
      if (type.includes("failed")) {
        return `⚠️ *${type}*\n${payload.reason || payload.summary || JSON.stringify(payload).slice(0, 300)}`;
      }
      return `📋 *${type}*\n${payload.summary || payload.title || JSON.stringify(payload).slice(0, 300)}`;
  }
}
