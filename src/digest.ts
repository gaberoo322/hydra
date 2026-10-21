/**
 * Notification event -> Operator Channel router (ADR-0045, issue #5047).
 *
 * This module used to own the 4-hourly Telegram digest (`DigestAccumulator`,
 * `shouldSendDigest`, the quiet-hours gate, both `setInterval`s, the daily
 * heartbeat). All of that is retired: ADR-0045 Decision 7 replaces the
 * batched digest, the heartbeat and the weekly digest chore with the once-
 * daily Morning Brief (`src/operator-channel/brief*.ts`), timed by a Redis
 * last-sent key and ticked by the scheduler heartbeat.
 *
 * What survives is the thin {@link recordEvent} router the notification
 * consumer (`src/notification-consumer.ts`) still imports: a page-kind event
 * (the closed list in `operator-channel/page-list.ts`) goes to
 * `channel.page()`; every other event is appended as a Morning Brief item via
 * `channel.brief()`. Nothing is buffered in memory any more — the brief reads
 * the bounded Redis list. The consumer's import path is deliberately
 * unchanged; its rename/retirement is #5049's contract.
 */

import {
  operatorChannel,
  messageFromEvent,
  isPageEvent,
  type OperatorChannel,
} from "./operator-channel/index.ts";
import { logger } from "./logger.ts";

/**
 * An inbound event handed to `recordEvent`. `type` discriminates page routing
 * vs. brief append; `payload` rides along into the message facts.
 */
export interface DigestEvent {
  type?: string;
  payload?: Record<string, unknown>;
}

/**
 * Route one notification event to the Operator Channel. Page-kind events go
 * straight to `channel.page()` (edge-triggered, deduped); everything else is
 * appended as a brief item. Fire-and-forget: a channel failure is logged and
 * never reaches the consumer, so alerting can never break a cycle.
 */
export function recordEvent(
  event: DigestEvent,
  channel: Pick<OperatorChannel, "page" | "brief"> = operatorChannel,
): void {
  const type = event.type || "unknown";
  if (isPageEvent(type, event.payload)) {
    channel.page(messageFromEvent(event)).catch((err) =>
      logger.error({ err, type }, "[Digest] operator-channel page failed (non-fatal)"),
    );
    return;
  }
  channel.brief(messageFromEvent(event)).catch((err) =>
    logger.error({ err, type }, "[Digest] operator-channel brief append failed (non-fatal)"),
  );
}
