/**
 * Notification event -> Operator Channel router (ADR-0045, issues #5047 / #5049).
 *
 * The one entry point the notification consumer (`src/notification-consumer.ts`)
 * calls per bus event: a page-kind event (the closed list in `./page-list.ts`)
 * goes to `channel.page()`; every other event is appended as a Morning Brief
 * item via `channel.brief()`. Nothing is buffered in memory — the brief reads
 * the bounded Redis list.
 *
 * This router is what survived of `src/digest.ts`, which used to own the
 * 4-hourly Telegram digest (`DigestAccumulator`, `shouldSendDigest`, the
 * quiet-hours gate, both `setInterval`s, the daily heartbeat). ADR-0045
 * Decision 7 replaced all of that with the once-daily Morning Brief
 * (`./brief*.ts`); issue #5049 retired the `digest` name with the file.
 */

import { logger } from "../logger.ts";
import { operatorChannel, messageFromEvent, type ChannelEventInput, type OperatorChannel } from "./channel.ts";
import { isPageEvent } from "./page-list.ts";

/**
 * Route one notification event to the Operator Channel. Page-kind events go
 * straight to `channel.page()` (edge-triggered, deduped); everything else is
 * appended as a brief item. Fire-and-forget: a channel failure is logged and
 * never reaches the consumer, so alerting can never break a cycle.
 */
export function routeNotificationEvent(
  event: ChannelEventInput,
  channel: Pick<OperatorChannel, "page" | "brief"> = operatorChannel,
): void {
  const type = event.type || "unknown";
  if (isPageEvent(type, event.payload)) {
    channel.page(messageFromEvent(event)).catch((err) =>
      logger.error({ err, type }, "[OperatorChannel] page failed (non-fatal)"),
    );
    return;
  }
  channel.brief(messageFromEvent(event)).catch((err) =>
    logger.error({ err, type }, "[OperatorChannel] brief append failed (non-fatal)"),
  );
}
