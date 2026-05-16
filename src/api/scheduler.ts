import { Router } from "express";
import { start as startScheduler, stop as stopScheduler, getStatus as getSchedulerStatus } from "../scheduler.ts";

export function createSchedulerRouter(eventBus: any) {
  const router = Router();

  // POST /scheduler/start — Start automatic cycle scheduling
  // Issue #222: `forceClearNoOpHalt` lets the operator acknowledge a no-op-merge
  // halt and resume cycles. Without this flag, start() returns 409 if the
  // scheduler is halted for consecutive no-op merges.
  router.post("/scheduler/start", async (req, res) => {
    const intervalMs = req.body?.intervalMs;
    const forceClearNoOpHalt = req.body?.forceClearNoOpHalt === true;
    const result = await startScheduler(eventBus, { intervalMs, forceClearNoOpHalt });
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
