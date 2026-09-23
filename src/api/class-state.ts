/**
 * Class-state HTTP surface (issue #4635, ADR-0034 §9.2 / PR #4617).
 *
 *   GET /api/autopilot/class-state
 *     → ClassStateResponse { header, classes, scanned, generatedAt }
 *
 * The READ-ONLY "what is every autopilot class doing right now, and why?"
 * surface: one row per Dispatch-Class Taxonomy class (kind, scope, cooldown,
 * last-fired, server-computed cooldown remaining, latest verdict + freshness,
 * slot occupant, starved, dead) plus a header of the global gates (run,
 * scope, usage allow/shed, burned classes, quota delta cap). Pure
 * observability — the route registers ONLY this GET, writes nothing, takes
 * no `eventBus`.
 *
 * Invariants (from the design concept for issue-4635): the composer is pure
 * with an injected `now` and injectable reader deps; every failed source
 * degrades to null / 'unknown' and is NAMED in `header.degraded` — never a
 * 0, [] or 'none' standing in for unknown (ADR-0034 §5 trust contract). The
 * handler therefore always answers 200 with the envelope; the
 * `isolateAggregator` catch is defensive only (readClassState never throws
 * by contract — same shape as the class-stats sibling).
 */

import { Router } from "express";
import { readClassState } from "../autopilot/class-state.ts";
import type { ClassStateReaderDeps } from "../autopilot/class-state.ts";
import { isolateAggregator } from "./route-helpers.ts";

/**
 * @param readState Optional reader override (tests inject a fake that returns
 *   a canned envelope without a live Redis — the class-stats convention).
 */
export function createAutopilotClassStateRouter(
  readState: (deps?: ClassStateReaderDeps) => ReturnType<typeof readClassState> = readClassState,
) {
  const router = Router();

  router.get("/autopilot/class-state", async (_req, res) =>
    // Defensive — readClassState degrades rather than throwing, so this
    // isolation just guarantees Express never returns a bodyless 500.
    isolateAggregator(res, "api/autopilot/class-state", async () => readState()),
  );

  return router;
}
