import { Router } from "express";
import { getTracker } from "../task-tracker.ts";
import { getCycleStatus } from "../cycle.ts";

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
  router.get("/grounding/latest", async (req, res) => {
    try {
      const { groundProject } = await import("../grounding.ts");
      const projectDir = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";
      const report = await groundProject(projectDir);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /agents/status — Agent health and task assignments
  router.get("/agents/status", async (req, res) => {
    const cycle = await getCycleStatus();
    res.json({
    // @ts-expect-error — migrate to proper types
      cycle: cycle.id || null,
    // @ts-expect-error — migrate to proper types
      agents: cycle.agents || {},
    });
  });

  // POST /agents/:id/pause — Pause a specific agent
  router.post("/agents/:id/pause", async (req, res) => {
    const { id } = req.params;
    const cycle = await getCycleStatus();
    // @ts-expect-error — migrate to proper types
    if (cycle.agents?.[id]) {
    // @ts-expect-error — migrate to proper types
      cycle.agents[id].status = "paused";
      res.json({ paused: true, agent: id });
    } else {
      res.status(404).json({ error: `Agent '${id}' not found in current cycle` });
    }
  });

  return router;
}
