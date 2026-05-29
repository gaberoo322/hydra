import { Router } from "express";
import { getCycleStatus, getCycleHistory } from "../cycle.ts";
import { getTracker } from "../task-tracker.ts";
import { getRealityReport } from "../redis/reality-reports.ts";
import {
  registerCycleSource,
  releaseCycleSource,
  initCycleHash,
  updateCycleHash,
} from "../redis/cycle-tracking.ts";

export function createCyclesRouter(_eventBus: any) {
  const router = Router();

  // GET /cycle/status — Current cycle state
  router.get("/cycle/status", async (req, res) => {
    try {
      res.json(await getCycleStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/history — Recent cycle results
  router.get("/cycle/history", async (req, res) => {
    try {
    // @ts-expect-error — migrate to proper types
      const limit = parseInt(req.query.limit) || 10;
      res.json(await getCycleHistory(limit));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/report — Structured cycle report with agent runs and costs
  router.get("/cycle/report", async (req, res) => {
    try {
      res.json(await getTracker().getCycleReport());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/report/:cycleId — Report for a specific cycle (agents, costs, tasks)
  router.get("/cycle/report/:cycleId", async (req, res) => {
    try {
      res.json(await getTracker().getCycleReport(req.params.cycleId));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/:cycleId/reality — Reality report for a specific cycle
  router.get("/cycle/:cycleId/reality", async (req, res) => {
    try {
      const raw = await getRealityReport(req.params.cycleId);
      if (!raw) return res.status(404).json({ error: "Reality report not found" });
      res.json(JSON.parse(raw));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Register an external cycle (Claude Code)
  router.post("/cycle/register", async (req, res) => {
    try {
      const { cycleId, source } = req.body || {};
      if (!cycleId || !source) {
        return res.status(400).json({ error: "Missing cycleId or source" });
      }
      await registerCycleSource(source, cycleId, 900);
      await initCycleHash(cycleId, {
        status: "running",
        startedAt: new Date().toISOString(),
        source,
        total: "1",
        completed: "0",
        failed: "0",
        abandoned: "0",
      }, 604800); // 7 days
      res.json({ ok: true, cycleId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Complete an external cycle
  router.post("/cycle/complete", async (req, res) => {
    try {
      const { cycleId, source, status } = req.body || {};
      if (!cycleId) {
        return res.status(400).json({ error: "Missing cycleId" });
      }
      await releaseCycleSource(source || "claude");
      await updateCycleHash(cycleId, {
        status: status || "completed",
        completedAt: new Date().toISOString(),
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
