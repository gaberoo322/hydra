/**
 * The Operator Channel's Telegram transport (ADR-0045 Decisions 2 and 5;
 * issues #1512, #5040, #5045, #5049).
 *
 * The thin I/O layer over the Telegram Bot API: this module owns the ONE
 * `fetch` to `api.telegram.org` in the repo (enforced by
 * `scripts/ci/telegram-seam-check.ts`, whose single exemption is this file).
 * Credentials come lazily, per send, from the single loader in
 * `./credentials.ts` (Decision 8). Messages are Telegram HTML rendered by
 * `./render.ts`'s `escapeHtml`; on an entity-parse 400 the same text is resent
 * once as plain text, so a formatting bug can make a message ugly but never
 * make it disappear (Decision 5).
 *
 * Issue #5049 moved this module here from `src/notify.ts` and deleted the
 * legacy Markdown senders (`sendToTelegram`, `createTelegramSender`) and the
 * Markdown formatter (`src/notify-format.ts`): no Markdown reaches Telegram
 * any more, and no file outside `src/operator-channel/` imports a sender.
 */

import { loadTelegramCredentials } from "./credentials.ts";

/** The entity syntax every Operator Channel message is written in. */
export type TelegramParseMode = "HTML";

/** What a transport send achieved (issue #5045); the channel logs it. */
export type TelegramTransportResult =
  | { ok: true; mode: TelegramParseMode | "plain" }
  | { ok: false; reason?: "no-credentials"; status?: number; error: string };

/** The transport signature the channel and the brief inject as a dep. */
export type TelegramTransportFn = (
  message: string,
  target?: string,
) => Promise<TelegramTransportResult>;

/** Collaborators for {@link createTelegramTransport}; `fetchImpl` is the test seam. */
export interface TelegramTransportDeps {
  token: string;
  defaultTarget: string;
  fetchImpl?: typeof fetch;
}

/**
 * True when Telegram rejected a message because its entities did not parse (a
 * stray `<` in HTML). That failure is the transport's to recover from: the
 * text itself is still worth delivering, just without formatting (issue #5040).
 */
export function isEntityParseError(status: number, body: string): boolean {
  return status === 400 && /can't parse entities/i.test(body);
}

/**
 * Build a Telegram HTML transport. On an entity-parse 400 it resends the same
 * text once as plain text (no `parse_mode`), so a formatting bug in any
 * producer can make a message ugly but can never make it disappear (issues
 * #5040, #5045). Never throws: every failure comes back as `{ ok: false }`.
 */
export function createTelegramTransport(deps: TelegramTransportDeps): TelegramTransportFn {
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
      const response = await post("HTML");
      if (response.ok) return { ok: true, mode: "HTML" };
      const body = await response.text();
      if (!isEntityParseError(response.status, body)) {
        console.error(`[OperatorChannel] Telegram API error (${response.status}):`, body);
        return { ok: false, status: response.status, error: body };
      }
      console.error(`[OperatorChannel] Telegram rejected HTML entities — resending as plain text:`, body);
      const plain = await post(null);
      if (plain.ok) return { ok: true, mode: "plain" };
      const plainBody = await plain.text();
      console.error(`[OperatorChannel] Telegram plain-text resend failed (${plain.status}):`, plainBody);
      return { ok: false, status: plain.status, error: plainBody };
    } catch (err: any) {
      console.error(`[OperatorChannel] Telegram send failed:`, err.message);
      return { ok: false, error: String(err?.message ?? err) };
    }
  };
}

/**
 * The Operator Channel's transport: Telegram HTML with the plain-text
 * backstop. Credentials are read lazily, per send, from the single loader —
 * never at import time — so a missing variable logs where it matters and
 * tests can set the environment after import.
 */
export const sendHtmlToTelegram: TelegramTransportFn = async (message, target) => {
  const creds = loadTelegramCredentials();
  if (!creds) {
    return { ok: false, reason: "no-credentials", error: "telegram credentials missing" };
  }
  return createTelegramTransport({ token: creds.token, defaultTarget: creds.chatId })(message, target);
};
