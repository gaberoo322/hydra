import { Router } from "express";
import { start as startScheduler, stop as stopScheduler, getStatus as getSchedulerStatus } from "../scheduler/heartbeat.ts";
import type { PingableBus } from "../event-bus-seams.ts";
import { SchedulerStartBodySchema } from "../schemas/scheduler.ts";
import { schemaValidationError } from "./route-helpers.ts";

// The scheduler router only forwards the bus to `heartbeat.start()` (whose
// `eventBus` param is still implicit-any); it never publishes itself. The seam
// is therefore sized to what its tests construct — `{ publisher: redis }` —
// i.e. PingableBus. Typing the deeper `start()` consumer is an out-of-scope
// follow-up (issue #1897 design-concept: deferred src/scheduler/ seams).
export function createSchedulerRouter(eventBus: PingableBus) {
  const router = Router();

  // POST /scheduler/start — Start automatic cycle scheduling
  //
  // Body validated through the Schemas seam (ADR-0011 / issue #3171): `intervalMs`
  // is an optional positive integer; a failure returns the shared 400
  // `{ code: "schema-validation-failed", issues }` envelope.
  router.post("/scheduler/start", async (req, res) => {
    const parsed = SchedulerStartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { intervalMs } = parsed.data;
    const result = await startScheduler(eventBus, { intervalMs });
    if (result.error) {
      res.status(409).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /scheduler/stop — Stop automatic cycle scheduling
  // Issue #388: a stop initiated through this API is treated as a deliberate
  // operator action. The scheduler writes a Redis marker that the watchdog
  // reads before issuing its auto-restart, so the operator's intent survives
  // both a service bounce and the next watchdog tick.
  router.post("/scheduler/stop", async (req, res) => {
    const result = await stopScheduler({ reason: "deliberate" });
    if (result.error) {
      res.status(409).json(result);
    } else {
      res.json(result);
    }
  });

  // GET /scheduler/status — Scheduler state and stats
  router.get("/scheduler/status", async (req, res) => {
    res.json(await getSchedulerStatus());
  });

  return router;
}
