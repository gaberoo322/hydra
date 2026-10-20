/**
 * Notification Bridge (Telegram transport) — issue #1512.
 *
 * The thin I/O layer over the Telegram Bot API. The pure formatting grammar
 * lives in `./notify-format.ts` (`formatMessage`). Credentials come lazily,
 * per send, from the single loader in `./operator-channel/credentials.ts`
 * (issue #5045); this module owns the one `fetch` to the Bot API, and the
 * Operator Channel (ADR-0045) reaches Telegram only through
 * {@link sendHtmlToTelegram} / {@link createTelegramTransport}.
 *
 * `formatMessage` is re-exported here so existing callers
 * (`scheduler/housekeeping.ts` and the review-pickup test) keep importing from
 * `./notify.ts` unchanged.
 */

import { formatMessage } from "./notify-format.ts";
import { loadTelegramCredentials } from "./operator-channel/credentials.ts";

/**
 * The Telegram transport signature (issue #1881).
 *
 * Names the contract `sendToTelegram` implements so callers that inject the
 * sender as a dep (e.g. `DigestAccumulatorDeps.send` in `digest.ts`) derive
 * their annotation from this canonical type instead of re-declaring it inline.
 */
export type TelegramSendFn = (message: string, target?: string) => Promise<void>;

export type TelegramParseMode = "Markdown" | "HTML";

/** What a transport send achieved (issue #5045); the channel logs it. */
export type TelegramTransportResult =
  | { ok: true; mode: TelegramParseMode | "plain" }
  | { ok: false; reason?: "no-credentials"; status?: number; error: string };

/** Like {@link TelegramSendFn} but reports delivery instead of returning void. */
export type TelegramTransportFn = (
  message: string,
  target?: string,
) => Promise<TelegramTransportResult>;

/** Collaborators for {@link createTelegramSender}; `fetchImpl` is the test seam. */
export interface TelegramSenderDeps {
  token: string;
  defaultTarget: string;
  fetchImpl?: typeof fetch;
  /** Entity syntax the message is written in. Defaults to legacy `Markdown`. */
  parseMode?: TelegramParseMode;
}

/**
 * True when Telegram rejected a message because its entities did not parse (an
 * unpaired `_` or `*` in Markdown, a stray `<` in HTML). That failure is the
 * sender's to recover from: the text itself is still worth delivering, just
 * without formatting (issue #5040).
 */
export function isEntityParseError(status: number, body: string): boolean {
  return status === 400 && /can't parse entities/i.test(body);
}

/**
 * Build a Telegram transport. On an entity-parse 400 it resends the same text
 * once as plain text (no `parse_mode`), so a formatting bug in any producer can
 * make an alert ugly but can never make it disappear (issues #5040, #5045).
 * Never throws: every failure comes back as `{ ok: false }`.
 */
export function createTelegramTransport(deps: TelegramSenderDeps): TelegramTransportFn {
  const parseMode: TelegramParseMode = deps.parseMode ?? "Markdown";
  return async function sendViaTelegram(message, target = deps.defaultTarget) {
    if (!deps.token) {
      return { ok: false, reason: "no-credentials", error: "bot token not set" };
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const post = (mode: TelegramParseMode | null) =>
      fetchImpl(`https://api.telegram.org/bot${deps.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target,
          text: message,
          ...(mode ? { parse_mode: mode } : {}),
          disable_web_page_preview: true,
        }),
      });

    try {
      const response = await post(parseMode);
      if (response.ok) return { ok: true, mode: parseMode };
      const body = await response.text();
      if (!isEntityParseError(response.status, body)) {
        console.error(`[Notify] Telegram API error (${response.status}):`, body);
        return { ok: false, status: response.status, error: body };
      }
      console.error(`[Notify] Telegram rejected ${parseMode} entities — resending as plain text:`, body);
      const plain = await post(null);
      if (plain.ok) return { ok: true, mode: "plain" };
      const plainBody = await plain.text();
      console.error(`[Notify] Telegram plain-text resend failed (${plain.status}):`, plainBody);
      return { ok: false, status: plain.status, error: plainBody };
    } catch (err: any) {
      console.error(`[Notify] Telegram send failed:`, err.message);
      return { ok: false, error: String(err?.message ?? err) };
    }
  };
}

/** Build a void-returning Telegram sender over {@link createTelegramTransport}. */
export function createTelegramSender(deps: TelegramSenderDeps): TelegramSendFn {
  const transport = createTelegramTransport(deps);
  return async function sendToTelegram(message, target) {
    await transport(message, target);
  };
}

/**
 * Credentials are read lazily, per send, from the single loader — never at
 * import time — so a missing variable logs where it matters and tests can set
 * the environment after import.
 */
function transportFromEnv(parseMode: TelegramParseMode): TelegramTransportFn {
  return async (message, target) => {
    const creds = loadTelegramCredentials();
    if (!creds) {
      return { ok: false, reason: "no-credentials", error: "telegram credentials missing" };
    }
    return createTelegramTransport({
      token: creds.token,
      defaultTarget: creds.chatId,
      parseMode,
    })(message, target);
  };
}

/** The Operator Channel's transport: Telegram HTML with the plain-text backstop. */
export const sendHtmlToTelegram: TelegramTransportFn = transportFromEnv("HTML");

const sendMarkdownToTelegram = transportFromEnv("Markdown");

/**
 * Send a message to Telegram via the Bot API (legacy Markdown), with the
 * plain-text fallback.
 */
const sendToTelegram: TelegramSendFn = async (message, target) => {
  await sendMarkdownToTelegram(message, target);
};

export { formatMessage, sendToTelegram };
