/**
 * Dashboard v2 — Now page HTTP surface (issue #618, PRD #615).
 *
 * Five endpoints, each a thin adapter over a dedicated aggregator or
 * existing data source:
 *
 *   GET /api/v2/now/service-strip      — health strip pinned to the top
 *   GET /api/v2/now/autopilot-tick     — current autopilot tick + run
 *   GET /api/v2/now/active-dispatches  — every live Claude Code session
 *   GET /api/v2/now/cost-burn          — token-denominated burn rate (USD interface honest-deleted in #1413)
 *   GET /api/v2/now/alerts             — recent alerts within a window
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
  AlertsNowQuerySchema,
  AutopilotHealthQuerySchema,
  type ServiceStripResponse,
  type AutopilotTickResponse,
  type ActiveDispatchesResponse,
  type CostBurnResponse,
  type AlertsNowResponse,
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

// ---------------------------------------------------------------------------
// Sub-source types for the thin wrappers (autopilot-tick, alerts)
// ---------------------------------------------------------------------------

type AutopilotCurrentRun = z.infer<typeof AutopilotCurrentRunSchema>;

export interface SchedulerStatusReader {
  (): Promise<{ running: boolean; lastTickAt: string | null }>;
}

export interface CurrentAutopilotRunReader {
  (): Promise<AutopilotCurrentRun | null>;
}

export interface AutopilotLifecycleReader {
  (): Promise<AutopilotLifecyclePayload>;
}

export interface AlertsReader {
  (limit: number): Promise<string[]>;
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
  /** Reader for raw alert JSON strings, newest first. */
  readRecentAlertsJson?: AlertsReader;
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
  const readSchedStatus =
    deps.readSchedulerStatus ?? defaultReadSchedulerStatus;
  const readCurrentRun = deps.readCurrentAutopilotRun ?? defaultReadCurrentRun;
  const readLifecycle =
    deps.readAutopilotLifecycle ?? defaultReadAutopilotLifecycle;
  const readAlertsJson = deps.readRecentAlertsJson ?? defaultReadAlertsJson;
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
  // GET /v2/now/autopilot-tick — thin wrapper over scheduler/autopilot data
  // -------------------------------------------------------------------------
  router.get("/now/autopilot-tick", async (_req, res) => {
    try {
      const [schedSettled, runSettled, lifecycleSettled] =
        await Promise.allSettled([
          readSchedStatus(),
          readCurrentRun(),
          readLifecycle(),
        ]);
      const sched =
        schedSettled.status === "fulfilled"
          ? schedSettled.value
          : { running: false, lastTickAt: null };
      const currentRun =
        runSettled.status === "fulfilled" ? runSettled.value : null;
      const lifecycle: AutopilotLifecyclePayload =
        lifecycleSettled.status === "fulfilled"
          ? lifecycleSettled.value
          : { state: "idle", runId: null, termReason: null, endedEpoch: null };

      if (schedSettled.status === "rejected") {
        console.error(
          `[v2/now/autopilot-tick] scheduler-status read failed: ${schedSettled.reason?.message || schedSettled.reason}`,
        );
      }
      if (runSettled.status === "rejected") {
        console.error(
          `[v2/now/autopilot-tick] current-run read failed: ${runSettled.reason?.message || runSettled.reason}`,
        );
      }
      if (lifecycleSettled.status === "rejected") {
        console.error(
          `[v2/now/autopilot-tick] lifecycle read failed: ${lifecycleSettled.reason?.message || lifecycleSettled.reason}`,
        );
      }

      // `running` is autopilot lifecycle truth (issue #888) — NOT the
      // scheduler housekeeping heartbeat (`sched.running`). The heartbeat
      // is still surfaced as `lastTickAt`.
      const body: AutopilotTickResponse = {
        running: lifecycle.state === "running",
        lastTickAt: sched.lastTickAt,
        currentRun,
        lifecycle,
        generatedAt: clock().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/now/autopilot-tick] handler threw: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

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

  // -------------------------------------------------------------------------
  // GET /v2/now/alerts — thin wrapper over /api/alerts
  // -------------------------------------------------------------------------
  router.get(
    "/now/alerts",
    aggregatorRoute(
      AlertsNowQuerySchema,
      "v2/now/alerts",
      async (data): Promise<AlertsNowResponse> => {
        const raw = await readAlertsJson(data.limit);
        const items = parseAlertsWindow({
          raw,
          sinceMinutes: data.sinceMinutes,
          now: clock(),
        });
        // `items` is the projected `Record<string, unknown>[]` shape — the
        // schema's `passthrough()` row type accepts the same data at runtime
        // but TS doesn't see the required-field intersection until parse-time.
        // The shape is enforced via the schema; the cast here is local.
        return {
          items: items as AlertsNowResponse["items"],
          windowMinutes: data.sinceMinutes,
          generatedAt: clock().toISOString(),
        };
      },
    ),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Pure helper — exported for tests
// ---------------------------------------------------------------------------

/**
 * Parse raw alert JSON strings into objects, filter by the time window,
 * and tolerate parse failures (an unparseable row is logged once and
 * dropped — it must not poison the whole response). Window-edge:
 * alerts are included when `timestamp >= now - sinceMinutes`.
 */
export function parseAlertsWindow(input: {
  raw: string[];
  sinceMinutes: number;
  now: Date;
}): Record<string, unknown>[] {
  const cutoffMs = input.now.getTime() - input.sinceMinutes * 60 * 1000;
  const out: Record<string, unknown>[] = [];
  for (const json of input.raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      // Best-effort: skip malformed rows; the alerts list shouldn't have any.
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const ts =
      typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (ts < cutoffMs) continue;
    if (typeof obj.id !== "string") continue;
    if (typeof obj.message !== "string") continue;
    if (typeof obj.severity !== "string") continue;
    out.push(obj);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

async function defaultReadSchedulerStatus(): Promise<{
  running: boolean;
  lastTickAt: string | null;
}> {
  const { getStatus } = await import("../scheduler/heartbeat.ts");
  const status = await getStatus();
  return {
    running: !!status.running,
    lastTickAt:
      typeof status.lastTickAt === "string" ? status.lastTickAt : null,
  };
}

async function defaultReadCurrentRun(): Promise<AutopilotCurrentRun | null> {
  const { getCurrentRun } = await import("../autopilot/runs.ts");
  const result = await getCurrentRun();
  if (!result.ok) return null;
  const view = result.view as Record<string, unknown>;
  const id = typeof view.run_id === "string" ? view.run_id : "";
  const startedAt = typeof view.started === "string" ? view.started : "";
  if (!id || !startedAt) return null;
  return {
    id,
    startedAt,
    trigger: typeof view.trigger === "string" ? view.trigger : "manual",
    turns: typeof view.turns === "number" ? view.turns : 0,
    dispatches: typeof view.dispatches === "number" ? view.dispatches : 0,
    elapsedSeconds: typeof view.elapsed_s === "number" ? view.elapsed_s : 0,
    ageSeconds: typeof view.age_s === "number" ? view.age_s : 0,
  };
}

async function defaultReadAutopilotLifecycle(): Promise<AutopilotLifecyclePayload> {
  const { getCurrentLifecycle } = await import("../autopilot/runs.ts");
  const result = await getCurrentLifecycle();
  if (!result.ok) {
    return { state: "idle", runId: null, termReason: null, endedEpoch: null };
  }
  const lc = result.lifecycle;
  return {
    state: lc.state,
    runId: lc.run_id,
    termReason: lc.term_reason,
    endedEpoch: lc.ended_epoch,
  };
}

async function defaultReadAlertsJson(limit: number): Promise<string[]> {
  const { readRecentAlerts } = await import("../redis/alerts.ts");
  return readRecentAlerts(limit);
}
