import { Router } from "express";
import { sendDigestNow, sendDailyHeartbeatNow } from "../digest.ts";
import { isolateAggregator } from "./route-helpers.ts";

/**
 * Digest-trigger HTTP surface (issue #2183).
 *
 * `POST /digest/send` and `POST /digest/heartbeat` are the on-demand triggers
 * for the `DigestAccumulator` domain (`src/digest.ts`). They were previously
 * "orphan operational" routes in `src/api/misc.ts`; issue #2183 moved them next
 * to their domain. The HTTP paths are unchanged; only the owning Module moved.
 */
export function createDigestRouter() {
  const router = Router();

  // POST /digest/send — Manually trigger a digest summary now
  router.post("/digest/send", async (_req, res) =>
    isolateAggregator(res, "api/digest/send", async () => {
      await sendDigestNow();
      return { sent: true };
    }),
  );

  // POST /digest/heartbeat — Manually trigger the daily heartbeat now. Lets the
  // operator verify Telegram delivery on demand (and is the endpoint a daily
  // systemd timer can hit if wall-clock-aligned delivery is wanted).
  router.post("/digest/heartbeat", async (_req, res) =>
    isolateAggregator(res, "api/digest/heartbeat", async () => {
      await sendDailyHeartbeatNow();
      return { sent: true };
    }),
  );

  return router;
}
