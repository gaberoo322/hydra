import { Router } from "express";
import { start as startScheduler, stop as stopScheduler, getStatus as getSchedulerStatus } from "../scheduler/heartbeat.ts";
import type { PingableBus } from "../event-bus-seams.ts";
import { SchedulerStartBodySchema } from "../schemas/scheduler.ts";

// The scheduler router only forwards the bus to `heartbeat.start()` (whose
// `eventBus` param is still implicit-any); it never publishes itself. The seam
// is therefore sized to what its tests construct — `{ publisher: redis }` —
// i.e. PingableBus. Typing the deeper `start()` consumer is an out-of-scope
// follow-up (issue #1897 design-concept: deferred src/scheduler/ seams).
export function createSchedulerRouter(eventBus: PingableBus) {
  const router = Router();

  // POST /scheduler/start — Start automatic cycle scheduling
  router.post("/scheduler/start", async (req, res) => {
    // Zod boundary parse (issue #3171, ADR-0011). `intervalMs` is an optional
    // positive integer; the 30000ms MIN_INTERVAL_MS floor stays a 409 in
    // startScheduler (single source of truth — schema does not duplicate it).
    const parsed = SchedulerStartBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
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
  //
  // Issue #4630 (ADR-0034 §9.4): homed on /health, which needs a
  // machine-readable as-of to key the trust seam's stale/unknown split.
  // `SchedulerStatus` (src/scheduler/status-projection.ts) itself carries no
  // `generatedAt` field — it is a projection over in-memory lifecycle state,
  // not a fetched-and-cached read — so the route stamps the wall-clock time
  // of THIS response here rather than widening the shared type for every
  // other caller (src/api/now-page.ts, src/autopilot/status.ts,
  // src/api/recommendations.ts, src/health/fan-out.ts). Additive: every
  // existing field survives unchanged.
  router.get("/scheduler/status", async (req, res) => {
    const status = await getSchedulerStatus();
    res.json({ ...status, generatedAt: new Date().toISOString() });
  });

  return router;
}
