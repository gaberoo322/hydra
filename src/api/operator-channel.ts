import { Router } from "express";
import { sendBriefNow } from "../operator-channel/brief-scheduler.ts";
import { isolateAggregator } from "./route-helpers.ts";

/**
 * Operator Channel HTTP surface (ADR-0045, issue #5047).
 *
 * `POST /operator-channel/brief/send` builds and sends the Morning Brief
 * immediately AND stamps the Redis last-sent key (it counts as today's brief,
 * so the scheduled 07:30 send does not produce a near-duplicate). Replaces the
 * retired `POST /digest/send` and `POST /digest/heartbeat` triggers.
 */
export function createOperatorChannelRouter() {
  const router = Router();

  router.post("/operator-channel/brief/send", async (_req, res) =>
    isolateAggregator(res, "api/operator-channel/brief/send", async () => sendBriefNow()),
  );

  return router;
}
