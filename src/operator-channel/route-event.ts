/**
 * Notification event -> Operator Channel router (ADR-0045, issues #5047 / #5049 /
 * #5389).
 *
 * The one entry point the notification consumer (`src/notification-consumer.ts`)
 * calls per bus event. It is a thin fire-and-forget wrapper over
 * `channel.report()`: the per-kind table in `./page-list.ts` decides page vs
 * Morning Brief item and whether a dashboard alert is also written, so a bus
 * event's page and alert are one call. Nothing is buffered in memory — the
 * brief reads the bounded Redis list.
 *
 * This router is what survived of `src/digest.ts`, which used to own the
 * 4-hourly Telegram digest (`DigestAccumulator`, `shouldSendDigest`, the
 * quiet-hours gate, both `setInterval`s, the daily heartbeat). ADR-0045
 * Decision 7 replaced all of that with the once-daily Morning Brief
 * (`./brief*.ts`); issue #5049 retired the `digest` name with the file.
 */

import { logger } from "../logger.ts";
import { operatorChannel, type ChannelEventInput, type OperatorChannel } from "./channel.ts";

/**
 * Route one notification event through `channel.report()`. Fire-and-forget: a
 * channel failure is logged and never reaches the consumer, so alerting can
 * never break a cycle.
 */
export function routeNotificationEvent(
  event: ChannelEventInput,
  channel: Pick<OperatorChannel, "report"> = operatorChannel,
): void {
  const type = event.type || "unknown";
  try {
    channel
      .report(type, event.payload ?? {}, { id: event.id, timestamp: event.timestamp })
      .catch((err) => logger.error({ err, type }, "[OperatorChannel] report failed (non-fatal)"));
  } catch (err) {
    logger.error({ err, type }, "[OperatorChannel] report failed (non-fatal)");
  }
}
