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

import { formatMessage } from "./notify-format.ts";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_TARGET = process.env.TELEGRAM_CHAT_ID || "8291726150";

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
