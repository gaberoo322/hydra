/**
 * Outcomes API (issue #241).
 *
 * GET /api/outcomes — returns the parsed outcomes contract plus the current
 * value (and timestamp) for each declared outcome via the source adapters.
 *
 * Surfaces the contract that #242 (stuckness detector), #244 (Tier-2
 * holdback), and the dashboard consume. `lastMovedAt` is intentionally
 * placeholder-only at this issue's scope — populated for real once the
 * stuckness history (#242) writes per-outcome time series.
 */

import { Router } from "express";
import { loadOutcomes, getOutcomeValue, type Outcome } from "../outcomes.ts";
import { getAllStuckness } from "../stuckness.ts";

interface OutcomeRow {
  name: string;
  kind: string;
  direction: string;
  source: string;
  baseline: number;
  target: number;
  stuckness_threshold_cycles: number;
  noise_epsilon: number;
  current: number | null;
  ts: string | null;
  lastMovedAt: string | null;
}

function rowFor(outcome: Outcome, reading: { value: number; ts: string } | null): OutcomeRow {
  return {
    name: outcome.name,
    kind: outcome.kind,
    direction: outcome.direction,
    source: outcome.source,
    baseline: outcome.baseline,
    target: outcome.target,
    stuckness_threshold_cycles: outcome.stuckness_threshold_cycles,
    noise_epsilon: outcome.noise_epsilon,
    current: reading?.value ?? null,
    ts: reading?.ts ?? null,
    // Populated by #242 (stuckness detector) once it writes per-outcome
    // time series. For #241 we surface the field shape but leave it null.
    lastMovedAt: null,
  };
}

/**
 * @param outcomesFile  Optional explicit path (used by tests). When omitted,
 *                      defaults to `config/direction/outcomes.yaml` resolved
 *                      from `HYDRA_CONFIG_PATH` at call-time.
 */
export function createOutcomesRouter(outcomesFile?: string) {
  const router = Router();

  // GET /outcomes — list declared outcomes + their current values.
  router.get("/outcomes", async (_req, res) => {
    try {
      const result = await loadOutcomes(outcomesFile);
      if (result.ok === false) {
        return res.status(500).json({ outcomes: [], errors: (result as { ok: false; errors: string[] }).errors });
      }

      const outcomes = (result as { ok: true; outcomes: Outcome[] }).outcomes;
      const rows: OutcomeRow[] = await Promise.all(
        outcomes.map(async (o) => rowFor(o, await getOutcomeValue(o))),
      );

      res.json({ outcomes: rows });
    } catch (err: any) {
      // Defensive — loader/adapter both don't throw, but Express demands
      // a final guard so we never hand a 500 with no body to the dashboard.
      console.error(`[outcomes-api] unexpected error: ${err?.message || String(err)}`);
      res.status(500).json({ outcomes: [], errors: [err?.message || String(err)] });
    }
  });

  // GET /stuckness — return cycles-since-favorable-movement for each outcome
  // (issue #242). Surfaces the diagnostic that drives autopilot's
  // "don't pull from the backlog" decision per ADR-0003.
  router.get("/stuckness", async (_req, res) => {
    try {
      const rows = await getAllStuckness();
      res.json({ outcomes: rows });
    } catch (err: any) {
      // getAllStuckness never throws, but defend the Express handler boundary.
      console.error(`[stuckness-api] unexpected error: ${err?.message || String(err)}`);
      res.status(500).json({ outcomes: [], errors: [err?.message || String(err)] });
    }
  });

  return router;
}
