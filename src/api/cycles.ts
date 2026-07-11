import { Router } from "express";
import { getCycleStatus, getCycleHistory } from "../cycle.ts";
import {
  registerCycleSource,
  releaseCycleSource,
  initCycleHash,
  updateCycleHash,
  getCycleHash,
} from "../redis/cycle-tracking.ts";
import { countQuerySchema } from "../schemas/common.ts";
import {
  CycleRegisterBodySchema,
  CycleCompleteBodySchema,
} from "../schemas/cycles.ts";
import { aggregatorRouteNoQuery, schemaValidationError } from "./route-helpers.ts";

export function createCyclesRouter() {
  const router = Router();

  // GET /cycle/status — Current cycle state
  //
  // Issue #1863: the never-throw-500 isolation comes from the
  // `aggregatorRouteNoQuery` seam (route-helpers.ts, #909). No query to parse;
  // the route is now just "this aggregator, this body".
  router.get(
    "/cycle/status",
    aggregatorRouteNoQuery("api/cycle/status", () => getCycleStatus()),
  );

  // GET /cycle/history — Recent cycle results
  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  // `limit` keeps its soft-parse (default-on-garbage, no 400) inside `produce`.
  router.get(
    "/cycle/history",
    aggregatorRouteNoQuery("api/cycle/history", (req) => {
      // ADR-0022: read `limit` through the Schemas seam; bad/absent input
      // collapses to the default, preserving the legacy `|| 10` semantics.
      const limit = countQuerySchema(10).safeParse(req.query).data?.count ?? 10;
      return getCycleHistory(limit);
    }),
  );

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

  // Register an external cycle (Claude Code)
  //
  // Body validated through the Schemas seam (ADR-0011 / issue #3170): both
  // `cycleId` and `source` are required non-empty strings; a failure returns the
  // shared 400 `{ code: "schema-validation-failed", issues }` envelope.
  router.post("/cycle/register", async (req, res) => {
    const parsed = CycleRegisterBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { cycleId, source } = parsed.data;
    try {
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
  //
  // Body validated through the Schemas seam (ADR-0011 / issue #3170): `cycleId`
  // is required non-empty; `source` and `status` stay optional and keep their
  // handler defaults (`source || "claude"`, `status || "completed"`).
  router.post("/cycle/complete", async (req, res) => {
    const parsed = CycleCompleteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { cycleId, source, status } = parsed.data;
    try {
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
