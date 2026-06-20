import { Router } from "express";
import { sendDigestNow, sendDailyHeartbeatNow } from "../digest.ts";

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
  router.post("/digest/send", async (req, res) => {
    try {
      await sendDigestNow();
      res.json({ sent: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /digest/heartbeat — Manually trigger the daily heartbeat now. Lets the
  // operator verify Telegram delivery on demand (and is the endpoint a daily
  // systemd timer can hit if wall-clock-aligned delivery is wanted).
  router.post("/digest/heartbeat", async (req, res) => {
    try {
      await sendDailyHeartbeatNow();
      res.json({ sent: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
