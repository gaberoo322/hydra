/**
 * Schemas for the Dashboard v2 Now page (issue #618, PRD #615).
 *
 * Slice 3 — five endpoints under `/api/v2/now/*`:
 *
 *   GET /api/v2/now/service-strip       → ServiceStripResponse
 *   GET /api/v2/now/autopilot-tick      → AutopilotTickResponse (thin wrapper)
 *   GET /api/v2/now/active-dispatches   → ActiveDispatchesResponse
 *   GET /api/v2/now/cost-burn           → CostBurnResponse
 *   GET /api/v2/now/alerts              → AlertsNowResponse
 *
 * Schema discipline mirrors `v2/today.ts` (issue #616, ADR-0011): `.strict()`
 * objects, `z.infer<>` for canonical types, structured
 * `schema-validation-failed` error envelope at the route boundary.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Service strip
// ---------------------------------------------------------------------------

const ServiceStatusSchema = z.enum(["ok", "degraded", "down"]);

const ServiceRowSchema = z
  .object({
    service: z.string(),
    status: ServiceStatusSchema,
    lastChecked: z.string(),
    lastError: z.string().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ServiceStripResponseSchema = z
  .object({
    rows: z.array(ServiceRowSchema),
    generatedAt: z.string(),
  })
  .strict();

export type ServiceStripResponse = z.infer<typeof ServiceStripResponseSchema>;

// ---------------------------------------------------------------------------
// Autopilot tick (thin wrapper)
// ---------------------------------------------------------------------------

/**
 * Shape returned by `GET /api/v2/now/autopilot-tick`. This is a thin
 * adapter over the existing `/api/scheduler/status` + `/api/autopilot/runs/current`
 * surfaces — the dashboard widget needs at most a handful of fields, so
 * we project them into a stable shape rather than passing the underlying
 * payloads through unchanged.
 *
 * - `running` — TRUE iff `lifecycle.state === "running"` (issue #888). No
 *   longer derived from the scheduler housekeeping heartbeat; the latest
 *   autopilot run must be `running` with a live pid.
 * - `lastTickAt` — heartbeat surface for the housekeeping tick (issue #397).
 *   May be `null` when the scheduler hasn't ticked yet this process.
 * - `currentRun` — projected current autopilot run, when one is in
 *   `status: running`. `null` otherwise.
 * - `lifecycle` — discriminated autopilot lifecycle truth (issue #888):
 *   `running` | `idle` | `ended` | `crashed`, with `term_reason` +
 *   `ended_epoch` populated when the most-recent run is terminal so the
 *   UI can render "last run ended N ago (<term_reason>)".
 */
const AutopilotLifecycleStateSchema = z.enum([
  "running",
  "idle",
  "ended",
  "crashed",
]);

const AutopilotLifecycleSchema = z
  .object({
    state: AutopilotLifecycleStateSchema,
    runId: z.string().nullable(),
    termReason: z.string().nullable(),
    endedEpoch: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const AutopilotCurrentRunSchema = z
  .object({
    id: z.string(),
    startedAt: z.string(),
    trigger: z.string(),
    turns: z.number().int().nonnegative(),
    dispatches: z.number().int().nonnegative(),
    elapsedSeconds: z.number().int().nonnegative(),
    ageSeconds: z.number().int().nonnegative(),
  })
  .strict();

export const AutopilotTickResponseSchema = z
  .object({
    running: z.boolean(),
    lastTickAt: z.string().nullable(),
    currentRun: AutopilotCurrentRunSchema.nullable(),
    lifecycle: AutopilotLifecycleSchema,
    generatedAt: z.string(),
  })
  .strict();

export type AutopilotTickResponse = z.infer<typeof AutopilotTickResponseSchema>;
export type AutopilotLifecyclePayload = z.infer<typeof AutopilotLifecycleSchema>;

// ---------------------------------------------------------------------------
// Active dispatches
// ---------------------------------------------------------------------------

// "subagent" added in issue #692 — the active-dispatches aggregator now
// merges a third source (Agent-tool subagent sessions captured by the
// SessionStart hook) alongside autopilot runs and operator-launched sessions.
const DispatchSourceSchema = z.enum(["autopilot", "operator", "subagent"]);

const DispatchSchema = z
  .object({
    id: z.string(),
    classLabel: z.string(),
    source: DispatchSourceSchema,
    startedAt: z.string(),
    currentStep: z.string().optional(),
    issueRef: z.string().optional(),
    prRef: z.string().optional(),
  })
  .strict();

export const ActiveDispatchesResponseSchema = z
  .object({
    items: z.array(DispatchSchema),
    generatedAt: z.string(),
  })
  .strict();

export type ActiveDispatchesResponse = z.infer<typeof ActiveDispatchesResponseSchema>;

// ---------------------------------------------------------------------------
// Cost burn
// ---------------------------------------------------------------------------

export const CostBurnResponseSchema = z
  .object({
    /** Coarse burn-rate spark — see `src/aggregators/cost-burn.ts` JSDoc. */
    lastHourSpark: z.array(z.number()),
    generatedAt: z.string(),
  })
  .strict();

export type CostBurnResponse = z.infer<typeof CostBurnResponseSchema>;

// ---------------------------------------------------------------------------
// Alerts (thin wrapper)
// ---------------------------------------------------------------------------

/**
 * Query schema for `GET /api/v2/now/alerts`. Defaults to a 60-minute
 * window and a 25-item limit — the Now page widget is small.
 */
export const AlertsNowQuerySchema = z
  .object({
    limit: z.coerce
      .number({ message: "limit must be a number" })
      .int({ message: "limit must be an integer" })
      .min(1, { message: "limit must be >= 1" })
      .max(100, { message: "limit must be <= 100" })
      .default(25),
    sinceMinutes: z.coerce
      .number({ message: "sinceMinutes must be a number" })
      .int({ message: "sinceMinutes must be an integer" })
      .min(1, { message: "sinceMinutes must be >= 1" })
      .max(24 * 60, { message: "sinceMinutes must be <= 1440" })
      .default(60),
  })
  .strict();

export type AlertsNowQuery = z.infer<typeof AlertsNowQuerySchema>;

/**
 * One alert row. Alerts are stored as opaque JSON in `hydra:alerts`; we
 * pass through the fields we know about and tolerate extras with
 * `.passthrough()` so the dashboard can render newly-added fields without
 * a schema change.
 *
 * Required fields (the existing `/api/alerts` writers always set them):
 *   id, timestamp, message, severity
 */
const AlertRowSchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    message: z.string(),
    severity: z.string(),
  })
  .passthrough();

export const AlertsNowResponseSchema = z
  .object({
    items: z.array(AlertRowSchema),
    windowMinutes: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type AlertsNowResponse = z.infer<typeof AlertsNowResponseSchema>;

// ---------------------------------------------------------------------------
// Autopilot health — stuck signals (issue #890, now-console-3)
// ---------------------------------------------------------------------------

/**
 * Query schema for `GET /api/now/autopilot-health`. `historyWindow` caps how
 * many recent runs the cross-run heuristics scan (the live-run heuristic
 * always reads only the current run). Defaults to 14 runs — roughly a day or
 * two of autopilot activity under the pace gate.
 */
export const AutopilotHealthQuerySchema = z
  .object({
    historyWindow: z.coerce
      .number({ message: "historyWindow must be a number" })
      .int({ message: "historyWindow must be an integer" })
      .min(1, { message: "historyWindow must be >= 1" })
      .max(100, { message: "historyWindow must be <= 100" })
      .default(14),
  })
  .strict();

export type AutopilotHealthQuery = z.infer<typeof AutopilotHealthQuerySchema>;

/**
 * The four stuck-signal heuristic types the autopilot-health aggregator
 * computes (issue #890):
 *   - `stalled-dispatch`   — a live dispatch running past a threshold with no
 *                            fresh tool-call / turn activity.
 *   - `unproductive-loop`  — a class dispatched repeatedly across the history
 *                            window with zero merges or a high failed count.
 *   - `idle-streak`        — consecutive no-op turns / runs terminating idle.
 *   - `issue-pr-churn`     — the same issue or PR re-dispatched repeatedly
 *                            without resolving.
 */
const StuckSignalTypeSchema = z.enum([
  "stalled-dispatch",
  "unproductive-loop",
  "idle-streak",
  "issue-pr-churn",
]);

const StuckSignalSeveritySchema = z.enum(["info", "warn", "critical"]);

/**
 * One ranked stuck signal. `evidence` is an open key/value bag carrying the
 * class, counts, and issue/PR refs the operator needs to act on the signal —
 * an `unknown`-valued record so a heuristic can attach extra evidence (a
 * count, a class label, an array of refs) without a schema change.
 */
export const StuckSignalSchema = z
  .object({
    type: StuckSignalTypeSchema,
    severity: StuckSignalSeveritySchema,
    summary: z.string(),
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();

export const AutopilotHealthResponseSchema = z
  .object({
    signals: z.array(StuckSignalSchema),
    historyWindow: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type StuckSignalType = z.infer<typeof StuckSignalTypeSchema>;
export type StuckSignalSeverity = z.infer<typeof StuckSignalSeveritySchema>;
export type StuckSignal = z.infer<typeof StuckSignalSchema>;
export type AutopilotHealthResponse = z.infer<typeof AutopilotHealthResponseSchema>;
