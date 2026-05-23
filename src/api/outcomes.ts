/**
 * Outcomes API (issue #241).
 *
 * GET /api/outcomes — returns the parsed outcomes contract plus the current
 * value (and timestamp) for each declared outcome via the source adapters.
 *
 * The stuckness detector and its `/api/outcomes/stuckness` companion route
 * were retired in ADR-0010 — the recorder had no production caller, so the
 * route reported all-zero state regardless of actual outcome movement.
 */

import { Router } from "express";
import { loadOutcomes, getOutcomeValue, type Outcome } from "../outcomes.ts";

interface OutcomeRow {
  name: string;
  kind: string;
  direction: string;
  source: string;
  baseline: number;
  target: number;
  noise_epsilon: number;
  current: number | null;
  ts: string | null;
}

function rowFor(outcome: Outcome, reading: { value: number; ts: string } | null): OutcomeRow {
  return {
    name: outcome.name,
    kind: outcome.kind,
    direction: outcome.direction,
    source: outcome.source,
    baseline: outcome.baseline,
    target: outcome.target,
    noise_epsilon: outcome.noise_epsilon,
    current: reading?.value ?? null,
    ts: reading?.ts ?? null,
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

  return router;
}
