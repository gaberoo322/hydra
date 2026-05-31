import { Router } from "express";
import { getCycleStatus, getCycleHistory } from "../cycle.ts";
import { getRealityReport } from "../redis/reality-reports.ts";
import {
  registerCycleSource,
  releaseCycleSource,
  initCycleHash,
  updateCycleHash,
  getCycleHash,
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

  // GET /cycle/report/:cycleId — Structured report for a specific cycle.
  //
  // Reads the autopilot-written cycle hash (the blessed write path —
  // redis/cycle-tracking.ts) rather than the retired in-process tracker's raw
  // seam (issue #792 / ADR-0016). The hash carries real task counts; per-agent
  // runs and per-cycle cost hashes were always-empty under the autopilot
  // recorder, so they are no longer surfaced here.
  router.get("/cycle/report/:cycleId", async (req, res) => {
    try {
      const hash = await getCycleHash(req.params.cycleId);
      if (!hash || Object.keys(hash).length === 0) {
        return res.status(404).json({ error: "Cycle not found" });
      }
      const total = parseInt(hash.total || "0");
      const completed = parseInt(hash.completed || "0");
      const failed = parseInt(hash.failed || "0");
      const abandoned = parseInt(hash.abandoned || "0");
      const timedOut = parseInt(hash.timedOut || "0");
      res.json({
        cycleId: req.params.cycleId,
        status: hash.status,
        startedAt: hash.startedAt,
        completedAt: hash.completedAt,
        source: hash.source,
        tasks: {
          total,
          completed,
          failed,
          abandoned,
          timedOut,
          inProgress: Math.max(0, total - completed - failed - abandoned - timedOut),
        },
      });
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
