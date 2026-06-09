/**
 * Schemas for the autopilot idle-diagnostics endpoint (issue #889,
 * now-console-2 / PRD #887).
 *
 * One read-only endpoint:
 *
 *   GET /api/autopilot/idle-diagnostics → AutopilotIdleDiagnosticsResponse
 *
 * The data behind an IDLE verdict on the Now Console: *why* is the Pace
 * Gate (ADR-0021) not launching a `hydra-autopilot` run right now? It
 * joins three live facts the Pace Gate itself consults each ~15-min tick
 * (`scripts/autopilot/pace-gate.sh`):
 *
 *   1. The usage-eligibility projection (`/api/usage/eligibility`):
 *      `paceState`, `targetPercent`, `percentSinceReset`, `percentLast5h`,
 *      `emergencyStop`, the Weekly Reset Anchor.
 *   2. A liveness check of the autopilot run (the dead-pid-swept lifecycle
 *      from `src/autopilot/runs.ts` — the same `kill -0` rule the Gate's
 *      state-file PID probe applies).
 *   3. A coarse next-pace-gate-check estimate, derived from the timer's
 *      `OnUnitActiveSec` cadence.
 *
 * `blockedBy` is the single verdict the Console renders, computed with the
 * SAME precedence the Pace Gate uses to decide whether to launch:
 *   - `running`       — a run is already live; the Gate never stacks runs.
 *   - `endpoint-error`— the eligibility source was unreachable; the Gate
 *                       FAILS SAFE (does not launch) when blind to usage.
 *   - `emergency-stop`— the 5h cap (>=90%) tripped; the Gate pauses fully.
 *   - `pacing-ahead`  — total burn is above the Pacing Curve; the Gate pauses.
 *   - `null`          — eligible; the Gate would launch on its next tick.
 *
 * Schema discipline mirrors `src/schemas/now-page.ts` (ADR-0011): `.strict()`
 * objects, `z.infer<>` for canonical types, a `schema-validation-failed`
 * error envelope at the route boundary.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Query schema for `GET /api/autopilot/idle-diagnostics`. The endpoint
 * takes no meaningful parameters today; `.strict()` rejects unexpected
 * query keys so a typo (e.g. `?forse=1`) surfaces as a 400 rather than
 * being silently ignored, satisfying the AC's request-validation contract.
 */
export const AutopilotIdleDiagnosticsQuerySchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * The Pace Gate's launch verdict for RIGHT NOW. `null` means eligible —
 * the Gate would launch a run on its next tick.
 */
const IdleBlockedBySchema = z
  .enum(["running", "emergency-stop", "pacing-ahead", "endpoint-error"])
  .nullable();

export type IdleBlockedBy = z.infer<typeof IdleBlockedBySchema>;

/**
 * Position of total burn relative to the Pacing Curve (ADR-0021). Mirrors
 * `PaceState` from the usage tracker. `"on"` when the Weekly Reset Anchor is
 * unset or the quota is uncalibrated (no curve to compare against).
 */
const IdlePaceStateSchema = z.enum(["behind", "on", "ahead"]);

/**
 * The pacing numerics the Gate compares each tick — surfaced so the Console
 * can show *how far* ahead/behind the curve the burn is, not just the
 * categorical verdict.
 */
const IdlePaceSchema = z
  .object({
    /** Pacing Curve verdict for this instant in the week. */
    state: IdlePaceStateSchema,
    /** % of weekly quota that *should* have burned by now (the curve). */
    targetPercent: z.number(),
    /** Actual % of weekly quota burned since the Weekly Reset Anchor. */
    sinceResetPercent: z.number(),
    /** ISO of the current Weekly Reset Anchor boundary, or `null`. */
    anchor: z.string().nullable(),
  })
  .strict();

export type IdlePace = z.infer<typeof IdlePaceSchema>;

/**
 * Autopilot run liveness — the dead-pid-swept lifecycle (issue #888). `alive`
 * is the boolean the verdict keys off (`state === "running"`); the rest is
 * carried so the Console can render "last run ended N ago (<termReason>)".
 */
const IdleAutopilotLivenessSchema = z
  .object({
    alive: z.boolean(),
    state: z.enum(["running", "idle", "ended", "crashed"]),
    runId: z.string().nullable(),
    termReason: z.string().nullable(),
    endedEpoch: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type IdleAutopilotLiveness = z.infer<typeof IdleAutopilotLivenessSchema>;

export const AutopilotIdleDiagnosticsResponseSchema = z
  .object({
    /** TRUE iff `blockedBy === null` — the Gate would launch on its next tick. */
    isEligible: z.boolean(),
    /** The single launch-blocking reason, or `null` when eligible. */
    blockedBy: IdleBlockedBySchema,
    /** Whether the underlying eligibility projection was calibrated. */
    calibrated: z.boolean(),
    /** Whether the 5h emergency-stop cap (>=90%) is tripped. */
    emergencyStop: z.boolean(),
    /** 5h rolling burn as a % of the calibrated 5h quota (0 when uncalibrated). */
    percentLast5h: z.number(),
    /** Pacing-curve numerics (state, target, sinceReset, anchor). */
    pace: IdlePaceSchema,
    /** Autopilot run liveness (dead-pid-swept lifecycle). */
    autopilot: IdleAutopilotLivenessSchema,
    /**
     * Coarse upper-bound ISO estimate of the next Pace Gate admission check —
     * `now + OnUnitActiveSec`. The Gate fires at most every ~15 min, so this
     * is "no later than"; `null` when the cadence env is unparseable.
     */
    nextPaceGateCheck: z.string().nullable(),
    generatedAt: z.string(),
  })
  .strict();

export type AutopilotIdleDiagnosticsResponse = z.infer<
  typeof AutopilotIdleDiagnosticsResponseSchema
>;
