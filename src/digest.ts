/**
 * Event -> Operator Channel router (ADR-0045, issue #5047).
 *
 * The 4h batched digest, the 24h heartbeat, quiet hours and the weekly digest
 * chore are retired: the Morning Brief (`src/operator-channel/brief-*.ts`)
 * replaces them. What survives here is the thin router `src/notification-
 * consumer.ts` calls for every bus event — a page-kind event (the closed list
 * in `operator-channel/page-list.ts`) goes to `OperatorChannel.page`, every
 * other event is appended as a Morning Brief item. Its rename/retirement is
 * #5049's contract, so the consumer's import stays stable.
 */

import {
  operatorChannel,
  messageFromEvent,
  isPageKind,
  type OperatorChannel,
} from "./operator-channel/index.ts";
import { logger } from "./logger.ts";

/** An inbound bus event handed to {@link recordEvent}. */
interface DigestEvent {
  type?: string;
  payload?: Record<string, unknown>;
}

/**
 * Route one bus event: page kinds page immediately (deduped by the channel),
 * everything else becomes a Morning Brief item. Never throws and never blocks —
 * channel failures are logged.
 */
export function recordEvent(
  event: DigestEvent,
  channel: Pick<OperatorChannel, "page" | "brief"> = operatorChannel,
): void {
  const type = event.type || "unknown";
  if (isPageKind(type)) {
    channel.page(messageFromEvent(event)).catch((err) =>
      logger.error({ err, type }, "[Digest] operator-channel page failed (non-fatal)"),
    );
    return;
  }
  channel.brief(messageFromEvent(event)).catch((err) =>
    logger.error({ err, type }, "[Digest] operator-channel brief append failed (non-fatal)"),
  );
}
