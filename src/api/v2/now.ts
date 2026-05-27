/**
 * Dashboard v2 — Now page HTTP surface (issue #618, PRD #615).
 *
 * Five endpoints, each a thin adapter over a dedicated aggregator or
 * existing data source:
 *
 *   GET /api/v2/now/service-strip      — health strip pinned to the top
 *   GET /api/v2/now/autopilot-tick     — current autopilot tick + run
 *   GET /api/v2/now/active-dispatches  — every live Claude Code session
 *   GET /api/v2/now/cost-burn          — burn-rate spark + budget headroom
 *   GET /api/v2/now/alerts             — recent alerts within a window
 *
 * Each route follows the slice-1/slice-2 pattern: parse the query through
 * a zod schema (where queries exist), return `schema-validation-failed`
 * on bad input, delegate to a pure aggregator otherwise. Every aggregator
 * is overridable via the `deps` factory parameter so tests can stub
 * without subprocesses or Redis.
 */

import { Router } from "express";

import {
  AlertsNowQuerySchema,
  type ServiceStripResponse,
  type AutopilotTickResponse,
  type ActiveDispatchesResponse,
  type CostBurnResponse,
  type AlertsNowResponse,
  type AutopilotCurrentRunSchema,
} from "../../schemas/v2/now.ts";
import { z } from "zod";

import {
  getServiceStrip,
  type ServiceStripDeps,
  type ServiceRow,
} from "../../aggregators/service-strip.ts";
import {
  getActiveDispatches,
  type ActiveDispatchesDeps,
  type Dispatch,
} from "../../aggregators/active-dispatches.ts";
import {
  getCostBurn,
  type CostBurnDeps,
  type CostBurn,
} from "../../aggregators/cost-burn.ts";

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

export interface AlertsReader {
  (limit: number): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface V2NowRouterDeps {
  /** Service-strip aggregator override. */
  getServiceStrip?: (deps?: ServiceStripDeps) => Promise<ServiceRow[]>;
  /** Active-dispatches aggregator override. */
  getActiveDispatches?: (deps?: ActiveDispatchesDeps) => Promise<Dispatch[]>;
  /** Cost-burn aggregator override. */
  getCostBurn?: (deps?: CostBurnDeps) => Promise<CostBurn>;
  /**
   * Reader for the scheduler status — projected to the shape the
   * autopilot-tick endpoint needs. Tests stub this; production wiring
   * defaults to `scheduler/loop.getStatus()`.
   */
  readSchedulerStatus?: SchedulerStatusReader;
  /**
   * Reader for the current autopilot run, projected into the
   * `AutopilotCurrentRun` shape. Returns `null` when no run is in
   * `status: running`.
   */
  readCurrentAutopilotRun?: CurrentAutopilotRunReader;
  /** Reader for raw alert JSON strings, newest first. */
  readRecentAlertsJson?: AlertsReader;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export function createV2NowRouter(deps: V2NowRouterDeps = {}) {
  const router = Router();
  const aggregateServiceStrip = deps.getServiceStrip ?? getServiceStrip;
  const aggregateDispatches = deps.getActiveDispatches ?? getActiveDispatches;
  const aggregateCostBurn = deps.getCostBurn ?? getCostBurn;
  const readSchedStatus = deps.readSchedulerStatus ?? defaultReadSchedulerStatus;
  const readCurrentRun = deps.readCurrentAutopilotRun ?? defaultReadCurrentRun;
  const readAlertsJson = deps.readRecentAlertsJson ?? defaultReadAlertsJson;
  const clock = deps.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // GET /v2/now/service-strip
  // -------------------------------------------------------------------------
  router.get("/v2/now/service-strip", async (_req, res) => {
    try {
      const rows = await aggregateServiceStrip();
      const body: ServiceStripResponse = {
        rows,
        generatedAt: clock().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/now/service-strip] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/now/autopilot-tick — thin wrapper over scheduler/autopilot data
  // -------------------------------------------------------------------------
  router.get("/v2/now/autopilot-tick", async (_req, res) => {
    try {
      const [schedSettled, runSettled] = await Promise.allSettled([
        readSchedStatus(),
        readCurrentRun(),
      ]);
      const sched =
        schedSettled.status === "fulfilled"
          ? schedSettled.value
          : { running: false, lastTickAt: null };
      const currentRun =
        runSettled.status === "fulfilled" ? runSettled.value : null;

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

      const body: AutopilotTickResponse = {
        running: sched.running,
        lastTickAt: sched.lastTickAt,
        currentRun,
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
  router.get("/v2/now/active-dispatches", async (_req, res) => {
    try {
      const items = await aggregateDispatches();
      const body: ActiveDispatchesResponse = {
        items,
        generatedAt: clock().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/now/active-dispatches] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/now/cost-burn
  // -------------------------------------------------------------------------
  router.get("/v2/now/cost-burn", async (_req, res) => {
    try {
      const burn = await aggregateCostBurn();
      const body: CostBurnResponse = {
        ...burn,
        generatedAt: clock().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/now/cost-burn] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/now/alerts — thin wrapper over /api/alerts
  // -------------------------------------------------------------------------
  router.get("/v2/now/alerts", async (req, res) => {
    const parsed = AlertsNowQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const raw = await readAlertsJson(parsed.data.limit);
      const items = parseAlertsWindow({
        raw,
        sinceMinutes: parsed.data.sinceMinutes,
        now: clock(),
      });
      // `items` is the projected `Record<string, unknown>[]` shape — the
      // schema's `passthrough()` row type accepts the same data at runtime
      // but TS doesn't see the required-field intersection until parse-time.
      // The shape is enforced via the schema; the cast here is local.
      const body: AlertsNowResponse = {
        items: items as AlertsNowResponse["items"],
        windowMinutes: parsed.data.sinceMinutes,
        generatedAt: clock().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[v2/now/alerts] reader threw: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

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
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
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

async function defaultReadSchedulerStatus(): Promise<{ running: boolean; lastTickAt: string | null }> {
  const { getStatus } = await import("../../scheduler/loop.ts");
  const status = await getStatus();
  return {
    running: !!status.running,
    lastTickAt: typeof status.lastTickAt === "string" ? status.lastTickAt : null,
  };
}

async function defaultReadCurrentRun(): Promise<AutopilotCurrentRun | null> {
  const { getCurrentRun } = await import("../../autopilot/runs.ts");
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

async function defaultReadAlertsJson(limit: number): Promise<string[]> {
  const { readRecentAlerts } = await import("../../redis/alerts.ts");
  return readRecentAlerts(limit);
}
