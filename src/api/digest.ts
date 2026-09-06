import { Router } from "express";
import { sendDigestNow, sendDailyHeartbeatNow } from "../digest.ts";
import { aggregatorRouteNoQuery } from "./route-helpers.ts";

/**
 * Digest-trigger HTTP surface (issue #2183).
 *
 * `POST /digest/send` and `POST /digest/heartbeat` are the on-demand triggers
 * for the `DigestAccumulator` domain (`src/digest.ts`). They were previously
 * "orphan operational" routes in `src/api/misc.ts`; issue #2183 moved them next
 * to their domain. The HTTP paths are unchanged; only the owning Module moved.
 *
 * Issue #4402: both triggers ride the `aggregatorRouteNoQuery` seam
 * (route-helpers.ts, #909) — the never-throw 500 `{ error }` envelope and its
 * pino `err`-field log line live there once instead of in a per-route catch.
 */
export function createDigestRouter() {
  const router = Router();

  // POST /digest/send — Manually trigger a digest summary now
  router.post(
    "/digest/send",
    aggregatorRouteNoQuery("api/digest/send", async () => {
      await sendDigestNow();
      return { sent: true };
    }),
  );

  // POST /digest/heartbeat — Manually trigger the daily heartbeat now. Lets the
  // operator verify Telegram delivery on demand (and is the endpoint a daily
  // systemd timer can hit if wall-clock-aligned delivery is wanted).
  router.post(
    "/digest/heartbeat",
    aggregatorRouteNoQuery("api/digest/heartbeat", async () => {
      await sendDailyHeartbeatNow();
      return { sent: true };
    }),
  );

  return router;
}
