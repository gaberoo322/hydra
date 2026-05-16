import { Router } from "express";
import { getTracker } from "../task-tracker.ts";
import { getCycleStatus } from "../cycle.ts";
import { getTargetWorkspace } from "../target-config.ts";

export function createTasksRouter() {
  const router = Router();

  // GET /tasks — Per-task state from Redis
  router.get("/tasks", async (req, res) => {
    try {
      const state = await getTracker().getCycleState();
      res.json(state.tasks || []);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/:id — Single task detail
  router.get("/tasks/:id", async (req, res) => {
    try {
      const task = await getTracker().getTaskState(req.params.id);
      if (!task || !task.cycleId) {
        res.status(404).json({ error: "Task not found" });
      } else {
        res.json({ taskId: req.params.id, ...task });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/:id/evidence — Full evidence chain for a task
  router.get("/tasks/:id/evidence", async (req, res) => {
    try {
      const evidence = await getTracker().getTaskEvidence(req.params.id);
      if (!evidence || Object.keys(evidence).length === 0) {
        res.status(404).json({ error: "No evidence found for task" });
      } else {
        res.json({ taskId: req.params.id, evidence });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /grounding/latest — Most recent grounding report
  //
  // Includes a `testParseStatus` field (mirrored from `report.testReport.parseStatus`)
  // so dashboard/API consumers can distinguish the silent-no-op shape
  // ("ran 0 tests" vs "couldn't read the result") without reaching into
  // nested fields. See issue #456 — the parser used to silently return
  // `{passed:0, failed:0, total:0}` on unrecognised output and downstream
  // metrics treated that as ground truth.
  router.get("/grounding/latest", async (req, res) => {
    try {
      const { groundProject } = await import("../grounding.ts");
      const projectDir = getTargetWorkspace();
      const report = await groundProject(projectDir);
      const testParseStatus = report?.testReport?.parseStatus ?? null;
      res.json({ ...report, testParseStatus });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /agents/status — Agent health and task assignments
  router.get("/agents/status", async (req, res) => {
    const cycle = await getCycleStatus() as any;
    res.json({
      cycle: cycle.id || null,
      agents: cycle.agents || {},
    });
  });

  // POST /agents/:id/pause — Pause a specific agent
  router.post("/agents/:id/pause", async (req, res) => {
    const { id } = req.params;
    const cycle = await getCycleStatus() as any;
    if (cycle.agents?.[id]) {
      cycle.agents[id].status = "paused";
      res.json({ paused: true, agent: id });
    } else {
      res.status(404).json({ error: `Agent '${id}' not found in current cycle` });
    }
  });

  return router;
}
