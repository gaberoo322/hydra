import { Router } from "express";
import {
  getCapacitySnapshot,
  recordOrchestratorSideMerge,
  DEFAULT_WINDOW_CYCLES,
} from "../capacity-floor.ts";
import { publishOrchestratorShareMetric } from "../metrics/publish.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { isolateAggregator } from "./route-helpers.ts";

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
  router.get("/capacity", async (req, res) =>
    isolateAggregator(res, "api/capacity", async () => {
      // ADR-0022: read `window` through the Schemas seam via the shared
      // count factory. Absent/non-numeric collapses to DEFAULT_WINDOW_CYCLES;
      // any value is clamped to 1..200, the legacy upper bound. `count` is the
      // factory's field name (renamed to `window` here).
      const { count: window } = countQuerySchema(DEFAULT_WINDOW_CYCLES, 200).parse(
        req.query,
      );
      const snapshot = await getCapacitySnapshot(window);
      // Shape requested by issue #245.
      return {
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
      };
    }),
  );

  // POST /capacity/orchestrator-merge — Record an orchestrator-side PR merge
  // Body: { cycleId: string, commitSha?: string, filesChanged?: string[], source?: string }
  router.post("/capacity/orchestrator-merge", async (req, res) =>
    isolateAggregator(res, "api/capacity/orchestrator-merge", async () => {
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
      // Issue #4299: every capacity-history write republishes the share metric
      // file, so `metrics/orchestrator-share.txt` (the declared
      // `orchestrator-self-improvement-share` outcome) tracks the window instead
      // of going stale between `cycle:completed` events. Best-effort — the
      // publisher logs its own failures and never throws.
      await publishOrchestratorShareMetric();
      return { ok: true, cycleId };
    }),
  );

  return router;
}
