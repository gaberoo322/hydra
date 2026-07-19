/**
 * Weekly Telegram digest chore.
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

import { setDigestLastWeekly } from "../../redis/housekeeping.ts";
import { buildWeeklySummary as buildWeeklySummaryImpl } from "../../digest.ts";
import { sendToTelegram as sendToTelegramImpl } from "../../notify.ts";
import { logger } from "../../logger.ts";

/** External touchpoints of the weekly-digest chore. */
export interface WeeklyDigestDeps {
  buildWeeklySummary?: () => Promise<string | null>;
  sendToTelegram?: (message: string) => Promise<void> | void;
  setLastWeekly?: typeof setDigestLastWeekly;
}

/**
 * Build and send the weekly Telegram summary, stamping the weekly guard key on
 * success. The weekly cadence guard is applied by `runHousekeeping` before this
 * runs; this body sends at most one summary per call.
 */
export async function runWeeklyDigest(deps: WeeklyDigestDeps = {}): Promise<void> {
  const buildWeeklySummary = deps.buildWeeklySummary ?? buildWeeklySummaryImpl;
  const setLastWeekly = deps.setLastWeekly ?? setDigestLastWeekly;
  const summary = await buildWeeklySummary();
  if (summary) {
    const sendToTelegram = deps.sendToTelegram ?? sendToTelegramImpl;
    await sendToTelegram(summary);
    await setLastWeekly(Date.now().toString());
    logger.info({}, "weekly-digest: sent weekly summary");
  }
}
