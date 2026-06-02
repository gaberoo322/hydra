/**
 * Dashboard v2 — Now page HTTP surface (issue #618, PRD #615).
 *
 * Five endpoints, each a thin adapter over a dedicated aggregator or
 * existing data source:
 *
 *   GET /api/v2/now/service-strip      — health strip pinned to the top
 *   GET /api/v2/now/autopilot-tick     — current autopilot tick + run
 *   GET /api/v2/now/active-dispatches  — every live Claude Code session
 *   GET /api/v2/now/cost-burn          — burn-rate spark (USD budget fields retired in #885)
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
import * as defaultRecsRedis from "../redis/recommendations.ts";
import { RUN_TTL_SECONDS } from "../autopilot/runs.ts";

// ---------------------------------------------------------------------------
// Recommendations sub-router schemas (issue #674)
// ---------------------------------------------------------------------------

const RecListQuerySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
  })
  .strict();

const RecMuteClassBodySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
    severity: z.enum(["info", "warn", "critical"], {
      message: "severity must be one of info|warn|critical",
    }),
  })
  .strict();

const RecDismissBodySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
  })
  .strict();

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

export interface RecommendationsReaderDeps {
  getAllRecommendations(runId: string): Promise<Record<string, string>>;
  getDismissedSet(runId: string): Promise<string[]>;
  getMutedClassesSet(runId: string): Promise<string[]>;
  dismissRecommendation(runId: string, recId: string, ttlSeconds: number): Promise<void>;
  muteSeverityClass(runId: string, severity: string, ttlSeconds: number): Promise<void>;
}

export interface CurrentRunIdReader {
  (): Promise<string | null>;
}

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
  /**
   * Reader returning the current run_id (most-recent run), for
   * `?run_id=current` resolution. Defaults to a thin call into
   * autopilot/runs.ts.
   */
  readCurrentRunId?: CurrentRunIdReader;
  /**
   * Recommendations Redis facade — defaults to the typed accessor
   * module. Tests inject an in-memory stub.
   */
  recsRedis?: RecommendationsReaderDeps;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export function createNowPageRouter(deps: NowPageRouterDeps = {}) {
  const router = Router();
  const aggregateServiceStrip = deps.getServiceStrip ?? getServiceStrip;
  const aggregateDispatches = deps.getActiveDispatches ?? getActiveDispatches;
  const aggregateCostBurn = deps.getCostBurn ?? getCostBurn;
  const aggregateAutopilotHealth = deps.getAutopilotHealth ?? getAutopilotHealth;
  const readSchedStatus = deps.readSchedulerStatus ?? defaultReadSchedulerStatus;
  const readCurrentRun = deps.readCurrentAutopilotRun ?? defaultReadCurrentRun;
  const readLifecycle = deps.readAutopilotLifecycle ?? defaultReadAutopilotLifecycle;
  const readAlertsJson = deps.readRecentAlertsJson ?? defaultReadAlertsJson;
  const readCurrentRunId = deps.readCurrentRunId ?? defaultReadCurrentRunId;
  const recsRedis: RecommendationsReaderDeps = deps.recsRedis ?? defaultRecsRedis;
  const clock = deps.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // GET /v2/now/service-strip
  // -------------------------------------------------------------------------
  router.get("/now/service-strip", async (_req, res) => {
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
  router.get("/now/autopilot-tick", async (_req, res) => {
    try {
      const [schedSettled, runSettled, lifecycleSettled] = await Promise.allSettled([
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
  router.get("/now/active-dispatches", async (_req, res) => {
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
  router.get("/now/cost-burn", async (_req, res) => {
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
  // GET /now/autopilot-health — ranked stuck signals (issue #890)
  // -------------------------------------------------------------------------
  router.get("/now/autopilot-health", async (req, res) => {
    const parsed = AutopilotHealthQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const signals = await aggregateAutopilotHealth({
        historyWindow: parsed.data.historyWindow,
        now: clock(),
      });
      const body: AutopilotHealthResponse = {
        signals,
        historyWindow: parsed.data.historyWindow,
        generatedAt: clock().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      console.error(
        `[now/autopilot-health] aggregator threw despite never-throw contract: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v2/now/alerts — thin wrapper over /api/alerts
  // -------------------------------------------------------------------------
  router.get("/now/alerts", async (req, res) => {
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

  // -------------------------------------------------------------------------
  // GET /now/recommendations — active (non-dismissed, non-muted-class) recs
  // -------------------------------------------------------------------------
  router.get("/now/recommendations", async (req, res) => {
    const parsed = RecListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const runId = await resolveRunId(parsed.data.run_id, readCurrentRunId);
      if (!runId) {
        return res.json({
          run_id: null,
          items: [],
          generatedAt: clock().toISOString(),
        });
      }

      const [rawHash, dismissed, muted] = await Promise.all([
        recsRedis.getAllRecommendations(runId),
        recsRedis.getDismissedSet(runId),
        recsRedis.getMutedClassesSet(runId),
      ]);

      const items = filterActiveRecommendations({
        rawHash,
        dismissed,
        muted,
      });

      return res.json({
        run_id: runId,
        items,
        generatedAt: clock().toISOString(),
      });
    } catch (err: any) {
      console.error(
        `[now/recommendations] read failed: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /now/recommendations/:id/dismiss
  // -------------------------------------------------------------------------
  router.post("/now/recommendations/:id/dismiss", async (req, res) => {
    const recId = String(req.params.id || "").trim();
    if (!recId) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: [{ message: "rec id must be non-empty" }],
      });
    }
    const parsed = RecDismissBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const runId = await resolveRunId(parsed.data.run_id, readCurrentRunId);
      if (!runId) {
        return res.status(404).json({ error: "no current run" });
      }
      await recsRedis.dismissRecommendation(runId, recId, RUN_TTL_SECONDS);
      return res.json({ run_id: runId, rec_id: recId, dismissed: true });
    } catch (err: any) {
      console.error(
        `[now/recommendations/dismiss] write failed: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /now/recommendations/mute-class
  // -------------------------------------------------------------------------
  router.post("/now/recommendations/mute-class", async (req, res) => {
    const parsed = RecMuteClassBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const runId = await resolveRunId(parsed.data.run_id, readCurrentRunId);
      if (!runId) {
        return res.status(404).json({ error: "no current run" });
      }
      await recsRedis.muteSeverityClass(runId, parsed.data.severity, RUN_TTL_SECONDS);
      return res.json({
        run_id: runId,
        severity: parsed.data.severity,
        muted: true,
      });
    } catch (err: any) {
      console.error(
        `[now/recommendations/mute-class] write failed: ${err?.message || err}`,
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
 * Resolve a logical `run_id` parameter into a concrete run id. `"current"`
 * is the canonical synonym for "the most recent run"; any other string is
 * treated as an explicit id and returned verbatim. Returns `null` when
 * `"current"` is requested but no run exists yet.
 */
export async function resolveRunId(
  rawRunId: string,
  readCurrentRunId: CurrentRunIdReader,
): Promise<string | null> {
  if (rawRunId === "current") return readCurrentRunId();
  return rawRunId;
}

/**
 * Pure filter — exported for direct test coverage. Given the raw rec hash
 * (id → JSON) and the dismissed/muted sets, returns the active recs
 * newest-first. Drops:
 *  - any rec whose id is in the dismissed set
 *  - any rec whose severity is in the muted set
 *  - any rec whose JSON fails to parse (logged once per call)
 *
 * Sorting is newest-first on `created_at`. Ties break on id so the order
 * is deterministic in tests.
 */
export function filterActiveRecommendations(input: {
  rawHash: Record<string, string>;
  dismissed: string[];
  muted: string[];
}): Array<Record<string, unknown>> {
  const dismissed = new Set(input.dismissed);
  const muted = new Set(input.muted);
  const out: Array<Record<string, unknown>> = [];

  for (const [id, json] of Object.entries(input.rawHash)) {
    if (dismissed.has(id)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      console.error(`[now/recommendations] dropping unparseable rec id=${id}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const severity = typeof parsed.severity === "string" ? parsed.severity : "";
    if (severity && muted.has(severity)) continue;
    out.push(parsed);
  }

  out.sort((a, b) => {
    const ta = Date.parse(String(a.created_at ?? "")) || 0;
    const tb = Date.parse(String(b.created_at ?? "")) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });

  return out;
}

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
  const { getStatus } = await import("../scheduler/heartbeat.ts");
  const status = await getStatus();
  return {
    running: !!status.running,
    lastTickAt: typeof status.lastTickAt === "string" ? status.lastTickAt : null,
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

async function defaultReadCurrentRunId(): Promise<string | null> {
  const { getCurrentRun } = await import("../autopilot/runs.ts");
  const result = await getCurrentRun();
  if (!result.ok) return null;
  const view = result.view as Record<string, unknown>;
  const id = typeof view.run_id === "string" ? view.run_id : "";
  return id || null;
}
