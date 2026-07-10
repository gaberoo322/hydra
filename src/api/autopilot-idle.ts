/**
 * Autopilot idle-diagnostics HTTP surface (issue #889, now-console-2 / PRD #887).
 *
 *   GET /api/autopilot/idle-diagnostics → AutopilotIdleDiagnosticsResponse
 *
 * The data behind an IDLE verdict on the Now Console: *why* is the Pace Gate
 * (ADR-0021) not launching a `hydra-autopilot` run right now? This route joins
 * the live facts the Gate's own admission check consults each ~15-min tick
 * (`scripts/autopilot/pace-gate.sh`) and projects them into one verdict
 * (`blockedBy`) plus the numeric reasons behind it.
 *
 * This file is now a THIN ADAPTER (issue #3116, arch-scan #788). The pure
 * multi-source composition — the `Promise.allSettled` fan-out, per-rejected
 * logging, `deriveBlockedBy` verdict, and response-body assembly — lives in the
 * `src/aggregators/autopilot-idle.ts` leaf as `getIdleDiagnostics(deps)`. This
 * file owns only the IO/wiring layer: the express Router, the all-optional
 * public `AutopilotIdleRouterDeps`, the default readers, and the `??`
 * default-resolution. The shrunk handler delegates through `aggregatorRoute`
 * (`route-helpers.ts`, issue #909), which owns the validate-or-400 envelope AND
 * the never-throw-500 isolation — no hand-rolled safeParse or try/catch here.
 *
 * The two pure functions `deriveBlockedBy` and `estimateNextPaceGateCheck` are
 * RE-EXPORTED from the leaf below (mirroring design-concept.ts re-exporting
 * design-concept-gate.ts, #3039) so `test/autopilot-idle.test.mts` and any
 * external caller keep a zero import-diff.
 *
 * The route is a thin adapter — like `now-page.ts`, every external read is an
 * overridable `deps` reader so tests stub the eligibility projection and the
 * autopilot lifecycle without a tracker scan, Redis, or the on-disk state file.
 */

import { Router } from "express";

import {
  AutopilotIdleDiagnosticsQuerySchema,
  type IdleAutopilotLiveness,
} from "../schemas/autopilot-idle.ts";

import {
  getUsage as defaultGetUsage,
  projectEligibilityView as defaultProjectEligibilityView,
  type EligibilityView,
} from "../cost/index.ts";
import { getAutopilotStatusSnapshot } from "../autopilot/status.ts";

import { getIdleDiagnostics } from "../aggregators/autopilot-idle.ts";
import { aggregatorRoute } from "./route-helpers.ts";

// Re-surface the canonical pacing-view type (issue #3108) so this route's own
// consumers (deps typing, tests) keep importing it from here — the type is
// OWNED by the Cost module now, no longer re-declared locally.
export type { EligibilityView } from "../cost/index.ts";

// Re-export the pure verdict + estimate functions from the aggregator leaf
// (issue #3116). The leaf OWNS the definitions; this file re-exports them so
// callers (test/autopilot-idle.test.mts, any future external consumer) keep a
// single-source import surface with a zero diff — the #3039 pattern.
export {
  deriveBlockedBy,
  estimateNextPaceGateCheck,
} from "../aggregators/autopilot-idle.ts";

// ---------------------------------------------------------------------------
// Sub-source readers (all overridable for tests)
// ---------------------------------------------------------------------------

interface EligibilityReader {
  (): Promise<EligibilityView>;
}

interface AutopilotLivenessReader {
  (): Promise<IdleAutopilotLiveness>;
}

export interface AutopilotIdleRouterDeps {
  /**
   * Reader for the usage-eligibility projection. Defaults to a thin call
   * into the Cost Module (`getUsage` → `projectEligibility`). A REJECTED
   * promise is treated as "endpoint-error" (the Gate's fail-safe state),
   * NOT a 500.
   */
  readEligibility?: EligibilityReader;
  /**
   * Reader for the dead-pid-swept autopilot lifecycle (issue #888). Defaults
   * to `autopilot/runs.getCurrentLifecycle()`. A REJECTED promise degrades to
   * the `idle` safe default.
   */
  readAutopilotLiveness?: AutopilotLivenessReader;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Pace Gate cadence in seconds (systemd `OnUnitActiveSec`, ~15 min). Used to
   * compute the coarse `nextPaceGateCheck` upper bound. Defaults to
   * `HYDRA_PACE_GATE_INTERVAL_SECONDS` env or 900s.
   */
  paceGateIntervalSeconds?: number;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAutopilotIdleRouter(deps: AutopilotIdleRouterDeps = {}) {
  const router = Router();
  const readEligibility = deps.readEligibility ?? defaultReadEligibility;
  const readAutopilotLiveness =
    deps.readAutopilotLiveness ?? defaultReadAutopilotLiveness;
  const clock = deps.now ?? (() => new Date());
  const paceGateIntervalSeconds =
    deps.paceGateIntervalSeconds ?? defaultPaceGateIntervalSeconds();

  // The shrunk handler: aggregatorRoute owns the safeParse → 400 envelope AND
  // the never-throw → 500 isolation; the RESOLVED deps bag is handed to the
  // pure aggregator. The query schema carries no fields the aggregator reads,
  // so the (data, req) args are ignored (matches now-page's no-field usage).
  router.get(
    "/autopilot/idle-diagnostics",
    aggregatorRoute(
      AutopilotIdleDiagnosticsQuerySchema,
      "autopilot/idle-diagnostics",
      async () =>
        getIdleDiagnostics({
          readEligibility,
          readAutopilotLiveness,
          now: clock,
          paceGateIntervalSeconds,
        }),
    ),
  );

  return router;
}

function defaultPaceGateIntervalSeconds(): number {
  const raw = process.env.HYDRA_PACE_GATE_INTERVAL_SECONDS;
  if (!raw) return 900; // OnUnitActiveSec=15min
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

async function defaultReadEligibility(): Promise<EligibilityView> {
  // Compose the snapshot read with the canonical pacing-view projection owned
  // by the Cost module (issue #3108) — the narrowing body no longer lives here.
  return defaultProjectEligibilityView(await defaultGetUsage());
}

/**
 * Default liveness reader — projects the shared AutopilotStatus snapshot's
 * lifecycle slice (issue #2673). `getCurrentLifecycle()` is the single source
 * of truth shared by all three autopilot read surfaces, so the liveness view is
 * derived through the seam (`getAutopilotStatusSnapshot()`), NOT a bespoke
 * `getCurrentLifecycle()` call. The idle route reads neither `eligibility` nor
 * `history` from the snapshot — eligibility stays its own reader (below), whose
 * REJECTION is load-bearing for the `endpoint-error` verdict; the seam's
 * never-throw eligibility slot would swallow that signal.
 */
async function defaultReadAutopilotLiveness(): Promise<IdleAutopilotLiveness> {
  const snap = await getAutopilotStatusSnapshot();
  const lc = snap.lifecycle;
  return {
    alive: lc.state === "running",
    state: lc.state,
    runId: lc.run_id,
    termReason: lc.term_reason,
    endedEpoch: lc.ended_epoch,
  };
}
