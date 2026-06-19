/**
 * Autopilot run READ-projection routes — the dashboard/observability read path.
 *
 *   GET /autopilot/runs                 — paginated history table + term health
 *   GET /autopilot/inflight-slots       — in-flight pipeline-slot seed (#1352)
 *   GET /autopilot/runs/current         — header strip
 *   GET /autopilot/runs/:runId          — full per-run detail (hash + turns)
 *   GET /autopilot/runs/:runId/retro    — run-tree retro bundle (#918)
 *   GET /autopilot/retros               — recent PERSISTED retro artifacts (#921)
 *
 * Split out of the combined `autopilot.ts` router (#2034). These reads project
 * the lifecycle's stored state for consumers (the dashboard, hydra-doctor,
 * bootstrap.sh's slot-seed curl) and touch the read-projection Module
 * (`src/autopilot/run-projections.ts`) plus the lifecycle Module's read
 * helpers. No state mutation, no direct Redis access — every read flows through
 * a domain Module.
 */

import { Router } from "express";
import { z } from "zod";
import {
  getCurrentRun,
  getRun,
  listRuns,
  readInflightSlotSeed,
} from "../autopilot/runs.ts";
import { summarizeTerminationHealth } from "../autopilot/run-projections.ts";
import { assembleRetroBundle } from "../autopilot/retro-bundle.ts";
import { RetroBundleParamsSchema, RecentRetrosQuerySchema } from "../schemas/retro.ts";
import { listRecentRetroArtifacts } from "../redis/retro-artifacts.ts";
import { aggregatorRoute } from "./route-helpers.ts";

/**
 * Query schema for `GET /autopilot/runs?limit=N` (ADR-0022). Coerces the wire
 * string to an integer, clamps to [1, 50], and collapses bad/absent/out-of-range
 * input to the default 14 — preserving the prior `clampInt(.., 1, 50, 14)`
 * leniency without a behaviour-changing 400. Non-strict so it ignores any other
 * query params.
 */
const RunsLimitQuerySchema = z.object({
  // Mirror clampInt(n, 1, 50, 14) exactly: a non-finite / non-integer value
  // (absent param, "abc", "1.5") falls back to 14; an in-range or out-of-range
  // INTEGER clamps into [1, 50] (so limit=0 → 1, limit=999 → 50) rather than
  // collapsing to the default.
  limit: z
    .unknown()
    .transform((raw) => {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (raw === undefined || raw === null || raw === "") return 14;
      if (!Number.isFinite(n) || !Number.isInteger(n)) return 14;
      if (n < 1) return 1;
      if (n > 50) return 50;
      return n;
    }),
});

export function createAutopilotRunsRouter() {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /autopilot/runs — history table.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs", async (req, res) => {
    // ADR-0022: read `limit` through the Schemas seam. This mirrors the prior
    // clampInt(.., 1, 50, 14) — bad/absent/out-of-range input collapses to the
    // default 14, valid input clamps into [1, 50].
    const limit = RunsLimitQuerySchema.safeParse(req.query).data?.limit ?? 14;
    const result = await listRuns(limit);
    if (!result.ok) {
      return res.status(500).json({ error: result.detail || result.code });
    }
    // Issue #1352: surface the clean-termination-rate observability rollup
    // alongside the history table. The retro learning loop is structurally
    // starved when this rate sits at ~0 over dispatch-bearing runs (every run
    // dies `interrupted` before its dispatches' terminal cycle records
    // materialise), so a consumer (hydra-doctor / the dashboard) can alarm on
    // it. Pure + read-only over the digests already fetched — no extra reads.
    const terminationHealth = summarizeTerminationHealth(result.runs);
    return res.json({ runs: result.runs, terminationHealth });
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/inflight-slots — in-flight pipeline-slot seed (issue #1352).
  //
  // `bootstrap.sh` curls this on every pace-gate relaunch to seed
  // `state.json.slots` with the subagents the PRIOR session left running (the
  // subagent dispatch ledger survives the relaunch; `state.json` does not).
  // Without the seed, `decide.py:_rule_idle_fallback` sees `occupied == 0`
  // while real subagents are still running and prematurely
  // `terminate(cause=idle)`s the fresh run — the root of the 100%-interrupted /
  // 0-drillable-dispatch starvation. Always 200 with a (possibly empty) seed;
  // the helper never throws (a Redis failure degrades to `{}` so a bootstrap is
  // never blocked by this read).
  // -------------------------------------------------------------------------
  router.get("/autopilot/inflight-slots", async (_req, res) => {
    const slots = await readInflightSlotSeed();
    return res.json({ slots });
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/current — header strip.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/current", async (_req, res) => {
    const result = await getCurrentRun();
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json(result.view);
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId/retro — run-tree retro bundle (issue #918).
  //
  // Read-only, never-throw assembler over the run's lifecycle data. The
  // domain library (`autopilot/retro-bundle.ts`) returns a partial bundle
  // with a populated `errors[]` rather than throwing on a sub-source
  // failure, so this route always answers 200 with the (possibly partial)
  // bundle once the run_id validates. A bad run_id is a 400.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/retro", async (req, res) => {
    const parsed = RetroBundleParamsSchema.safeParse({ run_id: req.params.runId });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const bundle = await assembleRetroBundle(parsed.data.run_id);
    return res.json(bundle);
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/retros — recent PERSISTED retro artifacts (issue #921).
  //
  // The durable, auditable record of what each retrospective concluded and
  // acted on, newest-first. Feeds the dashboard Retro panel. The accessor
  // (`redis/retro-artifacts.listRecentRetroArtifacts`) honours the never-throw contract
  // — a Redis failure yields `[]`, never a throw — so this route always
  // answers 200 with the (possibly empty) list once the query validates. A bad
  // `limit` is a 400 via the schema seam.
  //
  // Issue #1863: folded onto the `aggregatorRoute` seam (#909) — the
  // `schema-validation-failed` 400 envelope and the never-throw-500 isolation
  // now come from route-helpers.ts. The accessor is already never-throw (a
  // Redis failure yields `[]`), so the isolation is belt-and-braces; the
  // validate-half is the substantive win (one home for the error envelope).
  // -------------------------------------------------------------------------
  router.get(
    "/autopilot/retros",
    aggregatorRoute(RecentRetrosQuerySchema, "api/autopilot/retros", async (data) => {
      const artifacts = await listRecentRetroArtifacts(data.limit);
      return { artifacts };
    }),
  );

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId — full detail.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId", async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      return res.status(400).json({ error: "Missing runId" });
    }
    // Express has already routed `/runs/current` to its handler; this only
    // catches truly malformed paths.
    if (runId === "current") {
      return res.status(400).json({ error: "use GET /autopilot/runs/current" });
    }

    const result = await getRun(runId);
    if (!result.ok) {
      const status = result.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: result.detail || result.code });
    }
    return res.json({ run: result.run, turns: result.turns });
  });

  return router;
}
