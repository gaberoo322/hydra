/**
 * Dashboard v2 — Now page HTTP surface (issue #618, PRD #615).
 *
 * Endpoints, each a thin adapter over a dedicated aggregator or existing
 * data source:
 *
 *   GET /api/v2/now/service-strip      — health strip pinned to the top
 *   GET /api/v2/now/autopilot-tick     — current autopilot tick + run
 *   GET /api/v2/now/active-dispatches  — every live Claude Code session
 *   GET /api/v2/now/cost-burn          — token-denominated burn rate (USD interface honest-deleted in #1413)
 *
 * `GET /now/alerts` (a thin wrapper over /api/alerts) was retired under
 * ADR-0024 §3 (issue #4638): zero callers — /health reads /api/alerts.
 *
 * Each route follows the slice-1/slice-2 pattern: parse the query through
 * a zod schema (where queries exist), return `schema-validation-failed`
 * on bad input, delegate to a pure aggregator otherwise. Every aggregator
 * is overridable via the `deps` factory parameter so tests can stub
 * without subprocesses or Redis.
 */

import { Router } from "express";
import { aggregatorRoute, aggregatorRouteNoQuery } from "./route-helpers.ts";

import {
  AutopilotHealthQuerySchema,
  type ServiceStripResponse,
  type ActiveDispatchesResponse,
  type CostBurnResponse,
  type AutopilotHealthResponse,
  type StuckSignal,
  type AutopilotCurrentRunSchema,
  type AutopilotLifecyclePayload,
} from "../schemas/now-page.ts";
import { z } from "zod";

import {
  getServiceStrip,
  type ServiceStripDeps,
  type ServiceRow,
} from "../aggregators/service-strip.ts";
import {
  getActiveDispatches,
  type ActiveDispatchesDeps,
  type Dispatch,
} from "../aggregators/active-dispatches.ts";
import {
  getCostBurn,
  type CostBurnDeps,
  type CostBurn,
} from "../aggregators/cost-burn.ts";
import {
  getAutopilotHealth,
  type AutopilotHealthDeps,
} from "../aggregators/autopilot-health.ts";
import {
  getAutopilotTick,
  defaultReadSchedulerStatus,
  defaultReadCurrentRun,
  defaultReadAutopilotLifecycle,
} from "../aggregators/autopilot-tick.ts";

import {
  getAutopilotStatusSnapshot,
  type AutopilotStatusSnapshot,
} from "../autopilot/status.ts";

// ---------------------------------------------------------------------------
// Sub-source types for the autopilot-tick thin wrapper
// ---------------------------------------------------------------------------

type AutopilotCurrentRun = z.infer<typeof AutopilotCurrentRunSchema>;

interface SchedulerStatusReader {
  (): Promise<{ running: boolean; lastTickAt: string | null }>;
}

interface CurrentAutopilotRunReader {
  (): Promise<AutopilotCurrentRun | null>;
}

interface AutopilotLifecycleReader {
  (): Promise<AutopilotLifecyclePayload>;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface NowPageRouterDeps {
  /** Service-strip aggregator override. */
  getServiceStrip?: (deps?: ServiceStripDeps) => Promise<ServiceRow[]>;
  /** Active-dispatches aggregator override. */
  getActiveDispatches?: (deps?: ActiveDispatchesDeps) => Promise<Dispatch[]>;
  /** Cost-burn aggregator override. */
  getCostBurn?: (deps?: CostBurnDeps) => Promise<CostBurn>;
  /** Autopilot-health (stuck-signals) aggregator override (issue #890). */
  getAutopilotHealth?: (deps?: AutopilotHealthDeps) => Promise<StuckSignal[]>;
  /**
   * Reader for the scheduler status — projected to the shape the
   * autopilot-tick endpoint needs. Tests stub this; production wiring
   * defaults to `scheduler/heartbeat.getStatus()`.
   */
  readSchedulerStatus?: SchedulerStatusReader;
  /**
   * Reader for the current autopilot run, projected into the
   * `AutopilotCurrentRun` shape. Returns `null` when no run is in
   * `status: running`.
   */
  readCurrentAutopilotRun?: CurrentAutopilotRunReader;
  /**
   * Reader for the discriminated autopilot lifecycle state (issue #888).
   * This — NOT the scheduler heartbeat — is the source of truth for the
   * `running` indicator on the autopilot-tick response. Defaults to a
   * thin call into `autopilot/runs.getCurrentLifecycle()`.
   */
  readAutopilotLifecycle?: AutopilotLifecycleReader;
  /**
   * Builder for the shared AutopilotStatus snapshot (issue #2673). When a
   * per-slice reader above is overridden, that reader wins for its slice;
   * otherwise the slice is projected off this snapshot. Defaults to
   * `getAutopilotStatusSnapshot()` (no `eligibility`/`history` — the tick route
   * needs neither, so it issues no extra read). Overridable so a test can
   * exercise the shared-read projection path directly.
   */
  snapshot?: () => Promise<AutopilotStatusSnapshot>;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export function createNowPageRouter(deps: NowPageRouterDeps = {}) {
  const router = Router();
  const aggregateServiceStrip = deps.getServiceStrip ?? getServiceStrip;
  const aggregateDispatches = deps.getActiveDispatches ?? getActiveDispatches;
  const aggregateCostBurn = deps.getCostBurn ?? getCostBurn;
  const aggregateAutopilotHealth =
    deps.getAutopilotHealth ?? getAutopilotHealth;
  // Autopilot-tick readers. When a caller (a test) overrides one, that reader
  // wins; otherwise the slice is projected off a single shared snapshot the
  // handler builds once per request (issue #2673). `snapshot` overrides the
  // snapshot builder for tests exercising the shared-read path directly.
  const overrideSchedStatus = deps.readSchedulerStatus;
  const overrideCurrentRun = deps.readCurrentAutopilotRun;
  const overrideLifecycle = deps.readAutopilotLifecycle;
  const buildSnapshot = deps.snapshot ?? (() => getAutopilotStatusSnapshot());
  const clock = deps.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // GET /v2/now/service-strip
  // -------------------------------------------------------------------------
  router.get(
    "/now/service-strip",
    aggregatorRouteNoQuery(
      "v2/now/service-strip",
      async (): Promise<ServiceStripResponse> => ({
        rows: await aggregateServiceStrip(),
        generatedAt: clock().toISOString(),
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/now/autopilot-tick — thin adapter over the autopilot-tick aggregator
  // -------------------------------------------------------------------------
  //
  // The composition (settled fan-out, per-source degradation, body assembly)
  // lives in `src/aggregators/autopilot-tick.ts` (issue #3114). The route owns
  // only the IO wiring: which-reader-wins (override vs snapshot projection) and
  // the shared-snapshot memoization (issue #2673) — it hands the aggregator
  // three resolved zero-arg reader thunks that share one memoized snapshot by
  // reference, so a single request issues one `getAutopilotStatusSnapshot()`
  // read. `aggregatorRouteNoQuery` supplies the never-throw 500 isolation, so
  // no per-route try/catch is needed (the aggregator itself never throws).
  router.get(
    "/now/autopilot-tick",
    aggregatorRouteNoQuery("v2/now/autopilot-tick", async () => {
      // One composed read per request (issue #2673). Each slice honours its
      // explicit override (tests) if present, else projects off the shared
      // snapshot. The snapshot is read once and lazily — a slice that is
      // overridden never touches it.
      let snapPromise: ReturnType<typeof buildSnapshot> | null = null;
      const snapshot = () => (snapPromise ??= buildSnapshot());

      const readSchedulerStatus = overrideSchedStatus
        ? overrideSchedStatus
        : async () => defaultReadSchedulerStatus(await snapshot());
      const readCurrentRun = overrideCurrentRun
        ? overrideCurrentRun
        : async () => defaultReadCurrentRun(await snapshot());
      const readLifecycle = overrideLifecycle
        ? overrideLifecycle
        : async () => defaultReadAutopilotLifecycle(await snapshot());

      return getAutopilotTick({
        readSchedulerStatus,
        readCurrentRun,
        readLifecycle,
        now: clock,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /v2/now/active-dispatches
  // -------------------------------------------------------------------------
  router.get(
    "/now/active-dispatches",
    aggregatorRouteNoQuery(
      "v2/now/active-dispatches",
      async (): Promise<ActiveDispatchesResponse> => ({
        items: await aggregateDispatches(),
        generatedAt: clock().toISOString(),
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /v2/now/cost-burn
  // -------------------------------------------------------------------------
  router.get(
    "/now/cost-burn",
    aggregatorRouteNoQuery(
      "v2/now/cost-burn",
      async (): Promise<CostBurnResponse> => ({
        ...(await aggregateCostBurn()),
        generatedAt: clock().toISOString(),
      }),
    ),
  );

  // -------------------------------------------------------------------------
  // GET /now/autopilot-health — ranked stuck signals (issue #890)
  // -------------------------------------------------------------------------
  router.get(
    "/now/autopilot-health",
    aggregatorRoute(
      AutopilotHealthQuerySchema,
      "now/autopilot-health",
      async (data): Promise<AutopilotHealthResponse> => ({
        signals: await aggregateAutopilotHealth({
          historyWindow: data.historyWindow,
          now: clock(),
        }),
        historyWindow: data.historyWindow,
        generatedAt: clock().toISOString(),
      }),
    ),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Default wiring — projected off the shared AutopilotStatus seam (issue #2673).
//
// The three autopilot-tick default snapshot projections
// (`defaultReadSchedulerStatus`, `defaultReadCurrentRun`,
// `defaultReadAutopilotLifecycle`) were lifted out of this route file into
// `aggregators/autopilot-tick.ts` (issue #3181), the aggregator they feed —
// they are pure, zero-IO projections over `AutopilotStatusSnapshot` and belong
// next to the composition, where the normalization is independently
// unit-testable. They are imported back above and passed as the default `deps`
// thunks, projected off the memoized shared snapshot: each reader takes the
// snapshot the handler already built, so a single request issues one
// `getAutopilotStatusSnapshot()` read. The tick route requests neither
// `eligibility` nor `history`, so it issues no `getUsage()` / `listRuns()` read
// it did not do before (issue #2673 invariant). A test that stubs any of the
// three per-slice `deps` readers keeps overriding exactly the slice it did
// before; the memoized-snapshot wiring (`snapPromise ??= buildSnapshot()`) stays
// in the route as the IO-wiring layer it already is.
// ---------------------------------------------------------------------------

