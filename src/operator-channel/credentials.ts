/**
 * The single Telegram credential loader (ADR-0045 Decision 8, issue #5045).
 *
 * The only file in `src/` that reads the bot token / chat id from the
 * environment. Returns `null` (and names the missing variable) when either is
 * absent, so callers degrade to "skipped, no credentials" rather than throw.
 */

import { logger } from "../logger.ts";

export interface TelegramCredentials {
  token: string;
  chatId: string;
}

export function loadTelegramCredentials(
  env: Record<string, string | undefined> = process.env,
): TelegramCredentials | null {
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) {
    const missing = [!token && "TELEGRAM_BOT_TOKEN", !chatId && "TELEGRAM_CHAT_ID"]
      .filter(Boolean)
      .join(", ");
    logger.error({ missing }, "[OperatorChannel] Telegram credentials missing — message skipped");
    return null;
  }
  return { token, chatId };
}
