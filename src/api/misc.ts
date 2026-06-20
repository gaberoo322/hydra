import { Router } from "express";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sendDigestNow, sendDailyHeartbeatNow } from "../digest.ts";
import { classifyChange } from "../tier-classifier.ts";
// Pattern Memory write routes (POST /memory/:agent/pattern, GET /memory/:agent,
// POST /memory/subagent-lesson, POST /memory/subagent-friction) have been
// migrated to src/api/learning.ts with schema validation (issue #2181).

/**
 * Query schema for `GET /tier?files=a,b,c` (ADR-0022).
 *
 * `files` must be PRESENT (string or repeated-param array) but may be empty —
 * the legacy read only 400s when the param is absent (undefined/null), and an
 * empty value classifies the empty change set. The schema requires presence
 * (any string or string[]) and the handler splits/trims the CSV into the file
 * list, exactly mirroring the legacy `Array.isArray(raw) ? raw.flatMap(...) :
 * String(raw).split(",")` normalisation. The route owns its bespoke 400 via an
 * inline safeParse. Non-strict — ignores unknown params.
 */
const TierQuerySchema = z.object({
  files: z.union([z.string(), z.array(z.string())]),
});

/**
 * Residual "misc" routes that don't fit elsewhere.
 *
 * Issue #268 split this file — see api/openviking.ts, api/goals.ts,
 * api/events.ts, api/config.ts, api/alerts.ts,
 * api/reflections.ts, api/merge-lock.ts. Issue #2181 migrated the
 * Pattern Memory write routes to api/learning.ts. What remains here are
 * operational routes without a natural domain home: kill switch, digest
 * trigger, and tier classifier.
 *
 * New routes should prefer a domain-specific sub-router. Only land here if
 * the route is genuinely orphan-operational.
 */
export function createMiscRouter() {
  const router = Router();

  const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
  const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

  // POST /kill — Emergency stop. Writes the kill file that health.ts and
  // service-strip.ts poll (~/hydra/.kill). The in-process control loop was
  // removed in #383; the dead killCycle() call was stripped in #701.
  router.post("/kill", async (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    res.json({ killed: true, killFile: KILL_FILE });
  });

  // GET /tier?files=a,b,c — Modification tier classification (issue #243,
  // ADR-0004 work-order step 3). Used by autopilot/dashboard to know
  // which merge policy applies to a proposed change.
  router.get("/tier", (req, res) => {
    // ADR-0022: read `files` through the Schemas seam. Required-present (string
    // or array) but may be empty; the route owns its bespoke 400 on absence.
    const parsed = TierQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Missing query parameter 'files' (comma-separated)" });
    }
    const raw = parsed.data.files;
    const list = Array.isArray(raw) ? raw.flatMap(s => String(s).split(",")) : String(raw).split(",");
    const files = list.map(s => s.trim()).filter(s => s.length > 0);
    const result = classifyChange(files);
    res.json(result);
  });

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
