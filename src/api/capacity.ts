import { Router } from "express";
import {
  getCapacitySnapshot,
  recordOrchestratorSideMerge,
  DEFAULT_WINDOW_CYCLES,
} from "../capacity-floor.ts";

/**
 * Capacity-floor routes (issue #245).
 *
 * Exposes the orchestrator self-improvement share — the share of recent
 * non-idle cycles whose merged work was orchestrator-side. Autopilot
 * consults this share to honor the 25% ADR-0003 floor.
 *
 * The POST endpoint lets out-of-process writers (e.g. `hydra-dev` after
 * landing an orchestrator PR, a future GitHub webhook) stamp an
 * orchestrator-side entry into the history. The control loop stamps
 * target-side entries itself in post-merge.
 */
export function createCapacityRouter() {
  const router = Router();

  // GET /capacity — Orchestrator self-improvement share + recent history
  router.get("/capacity", async (req, res) => {
    try {
      const rawWindow = parseInt(String(req.query.window || ""), 10);
      const window = Number.isFinite(rawWindow) && rawWindow > 0 && rawWindow <= 200
        ? rawWindow
        : DEFAULT_WINDOW_CYCLES;
      const snapshot = await getCapacitySnapshot(window);
      // Shape requested by issue #245.
      res.json({
        orchestrator: {
          share: snapshot.orchestrator.share,
          window: snapshot.orchestrator.window,
          floor: snapshot.orchestrator.floor,
          count: snapshot.orchestrator.count,
        },
        target: {
          share: snapshot.target.share,
          count: snapshot.target.count,
        },
        idle: snapshot.idle,
        floorMet: snapshot.floorMet,
        last20: snapshot.recent.map((e) => ({
          cycleId: e.cycleId,
          side: e.side,
          commitSha: e.commitSha,
          recordedAt: e.recordedAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /capacity/orchestrator-merge — Record an orchestrator-side PR merge
  // Body: { cycleId: string, commitSha?: string, filesChanged?: string[], source?: string }
  router.post("/capacity/orchestrator-merge", async (req, res) => {
    try {
      const body = req.body || {};
      const cycleId = typeof body.cycleId === "string" && body.cycleId.length > 0
        ? body.cycleId
        : `orch-${Date.now()}`;
      const commitSha = typeof body.commitSha === "string" ? body.commitSha : undefined;
      const filesChanged = Array.isArray(body.filesChanged)
        ? body.filesChanged.filter((f: any) => typeof f === "string")
        : undefined;
      const source = typeof body.source === "string" ? body.source : undefined;
      await recordOrchestratorSideMerge(cycleId, { commitSha, filesChanged, source });
      res.json({ ok: true, cycleId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
