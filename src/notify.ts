/**
 * Notification Bridge (Telegram transport) — issue #1512.
 *
 * Consumes events from the hydra:notifications Redis stream and sends them to
 * Telegram via the Bot API. The pure formatting grammar lives in
 * `./notify-format.ts` (`formatMessage`) — this module is the thin I/O layer:
 * it reads `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` from env, calls the
 * formatter, then performs the `fetch` to the Bot API.
 *
 * `formatMessage` is re-exported here so existing callers
 * (`notification-consumer.ts`, `digest.ts`, `scheduler/housekeeping.ts`, and
 * the review-pickup test) keep importing from `./notify.ts` unchanged.
 */

import { formatMessage, type FormatMessageEvent } from "./notify-format.ts";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_TARGET = process.env.TELEGRAM_CHAT_ID || "8291726150";

/**
 * The Telegram transport signature (issue #1881).
 *
 * Names the contract `sendToTelegram` implements so callers that inject the
 * sender as a dep (e.g. `DigestAccumulatorDeps.send` in `digest.ts`) derive
 * their annotation from this canonical type instead of re-declaring it inline.
 * A change to `sendToTelegram`'s signature (e.g. a future `parseMode` option)
 * then propagates to every dep declaration as a compile error rather than
 * silently diverging.
 */
export type TelegramSendFn = (message: string, target?: string) => Promise<void>;

/** Collaborators for {@link createTelegramSender}; `fetchImpl` is the test seam. */
export interface TelegramSenderDeps {
  token: string;
  defaultTarget: string;
  fetchImpl?: typeof fetch;
}

/**
 * True when Telegram rejected a message because its Markdown entities did not
 * parse (an unpaired `_` or `*`, e.g. `node_modules` in an alert body). That
 * failure is the sender's to recover from: the text itself is still worth
 * delivering, just without formatting (issue #5040).
 */
export function isEntityParseError(status: number, body: string): boolean {
  return status === 400 && /can't parse entities/i.test(body);
}

/**
 * Build a Telegram sender. On an entity-parse 400 it resends the same text
 * once as plain text (no `parse_mode`), so a formatting bug in any producer can
 * make an alert ugly but can never make it disappear (issue #5040). Any other
 * failure is logged and dropped, as before.
 */
export function createTelegramSender(deps: TelegramSenderDeps): TelegramSendFn {
  return async function sendToTelegram(message, target = deps.defaultTarget) {
    if (!deps.token) {
      console.error("[Notify] TELEGRAM_BOT_TOKEN not set — skipping");
      return;
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const post = (parseMode: "Markdown" | null) =>
      fetchImpl(`https://api.telegram.org/bot${deps.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target,
          text: message,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          disable_web_page_preview: true,
        }),
      });

    try {
      const response = await post("Markdown");
      if (response.ok) return;
      const body = await response.text();
      if (!isEntityParseError(response.status, body)) {
        console.error(`[Notify] Telegram API error (${response.status}):`, body);
        return;
      }
      console.error(`[Notify] Telegram rejected Markdown entities — resending as plain text:`, body);
      const plain = await post(null);
      if (!plain.ok) {
        console.error(`[Notify] Telegram plain-text resend failed (${plain.status}):`, await plain.text());
      }
    } catch (err) {
      console.error(`[Notify] Telegram send failed:`, err.message);
    }
  };
}

/**
 * Send a message to Telegram via the Bot API, with the plain-text fallback.
 */
const sendToTelegram: TelegramSendFn = createTelegramSender({
  token: TELEGRAM_BOT_TOKEN,
  defaultTarget: TELEGRAM_TARGET,
});

/**
 * Send a notification to Telegram.
 *
 * `event` is typed `FormatMessageEvent` (issue #1881) — the same vocabulary the
 * pure formatter already narrows on (`notify-format.ts`, issue #1857) — so a
 * caller passing a mis-shaped event is a compile error at the call site rather
 * than a silent default-arm Telegram message at runtime.
 */
async function sendNotification(event: FormatMessageEvent): Promise<void> {
  const message = formatMessage(event);

  try {
    await sendToTelegram(message);
    console.log(`[Notify] Sent ${event.type} to Telegram`);
  } catch (err) {
    console.error(`[Notify] Failed to send ${event.type}:`, err.message);
  }
}

export { sendNotification, formatMessage, sendToTelegram };
