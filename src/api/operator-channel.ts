import { Router } from "express";
import { morningBriefScheduler, type BriefSendNowResult } from "../operator-channel/index.ts";
import { isolateAggregator } from "./route-helpers.ts";

/**
 * Operator Channel HTTP surface (ADR-0045, issue #5047).
 *
 * `POST /operator-channel/brief/send` sends the Morning Brief immediately and,
 * when the transport delivers it, stamps the Redis last-sent key — so a
 * send-now counts as today's brief and the 07:30 scheduled send is skipped
 * rather than near-duplicated (ADR-0045 Decision 7). It replaces the retired
 * `POST /digest/send` and `POST /digest/heartbeat` triggers. No request body.
 *
 * `sendNow` is injectable so the route is testable without Redis or Telegram;
 * production binds the process-wide scheduler. The read-only delivery-health
 * route (Decision 8) is #5048's addition to this router.
 */
export function createOperatorChannelRouter(
  deps: { sendBriefNow?: () => Promise<BriefSendNowResult> } = {},
) {
  const router = Router();
  const sendBriefNow = deps.sendBriefNow ?? (() => morningBriefScheduler.sendNow());

  // POST /operator-channel/brief/send — send the Morning Brief now.
  router.post("/operator-channel/brief/send", async (_req, res) =>
    isolateAggregator(res, "api/operator-channel/brief/send", async () => {
      const { sent, outcome, at } = await sendBriefNow();
      return { sent, outcome, at };
    }),
  );

  return router;
}
