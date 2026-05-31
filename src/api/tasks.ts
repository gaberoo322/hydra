import { Router } from "express";
import { getCycleStatus } from "../cycle.ts";
import { getTargetWorkspace } from "../target-config.ts";

export function createTasksRouter() {
  const router = Router();

  // The /tasks, /tasks/:id, and /tasks/:id/evidence routes were retired with
  // the in-process task tracker (issue #792 / ADR-0016). They read the
  // per-task cycle hashes the old control loop wrote; nothing populates those
  // keys under the autopilot recorder, so the routes always returned empty.
  // Cycle progress is served by /cycle/status + /cycle/history (cycle.ts).

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
