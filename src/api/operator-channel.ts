import { Router } from "express";
import {
  morningBriefScheduler,
  readDeliveryHealth,
  type BriefSendNowResult,
  type DeliveryHealth,
} from "../operator-channel/index.ts";
import { isolateAggregator } from "./route-helpers.ts";

/**
 * Operator Channel HTTP surface (ADR-0045, issues #5047 / #5048).
 *
 * `POST /operator-channel/brief/send` sends the Morning Brief immediately and,
 * when the transport delivers it, stamps the Redis last-sent key — so a
 * send-now counts as today's brief and the 07:30 scheduled send is skipped
 * rather than near-duplicated (ADR-0045 Decision 7). It replaces the retired
 * `POST /digest/send` and `POST /digest/heartbeat` triggers. No request body.
 *
 * `GET /operator-channel/delivery-health` is the ONE read-only delivery-health
 * route Decision 8 names: last page, last brief, 24h failed / suppressed
 * counts (`src/operator-channel/delivery-health.ts`), rendered by the
 * Operator channel card on the existing /health page — no new dashboard page
 * (ADR-0034). Best-effort by contract: with Redis down it answers 200 with
 * `{available:false, reason}`, never a 500, so the card degrades to UNKNOWN.
 *
 * Both producers are injectable so the routes are testable without Redis or
 * Telegram; production binds the process-wide scheduler and the Redis reads.
 */
export function createOperatorChannelRouter(
  deps: {
    sendBriefNow?: () => Promise<BriefSendNowResult>;
    readDeliveryHealth?: () => Promise<DeliveryHealth>;
  } = {},
) {
  const router = Router();
  const sendBriefNow = deps.sendBriefNow ?? (() => morningBriefScheduler.sendNow());
  const deliveryHealth = deps.readDeliveryHealth ?? (() => readDeliveryHealth());

  // POST /operator-channel/brief/send — send the Morning Brief now.
  router.post("/operator-channel/brief/send", async (_req, res) =>
    isolateAggregator(res, "api/operator-channel/brief/send", async () => {
      const { sent, outcome, at } = await sendBriefNow();
      // `ok: sent` (issue #5164 INV-8): a 200 with sent:false must render as a
      // refusal through the dashboard affordance, never a generic "accepted".
      // Existing fields keep their names and meanings.
      return sent
        ? { ok: true, sent, outcome, at }
        : { ok: false, reason: "send-failed", detail: outcome, sent, outcome, at };
    }),
  );

  // GET /operator-channel/delivery-health — the Decision 8 delivery summary.
  // readDeliveryHealth never rejects (it folds every failure into
  // available:false); isolateAggregator stays as the belt-and-braces so a
  // contract violation is a logged 500, never a hung request.
  router.get("/operator-channel/delivery-health", async (_req, res) =>
    isolateAggregator(res, "api/operator-channel/delivery-health", () => deliveryHealth()),
  );

  return router;
}
