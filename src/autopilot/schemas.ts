/**
 * Schemas for the four autopilot POST bodies — the orchestrator-side
 * boundary contract for what `scripts/autopilot/*` sends.
 *
 * Why `z.looseObject` and not `z.strictObject` (the queue-schema
 * pattern): the autopilot scripts evolved alongside the handlers
 * (state.json grew fields over the lifetime of issues #497-#500), and
 * the handlers were tolerant by design — they manually type-checked
 * the fields they cared about and let unknown fields slide. Switching
 * to strict in a retrofit PR would reject otherwise-valid payloads
 * when a script learned a new field before the schema did, breaking
 * the autopilot loop. Loose objects validate the *required* fields
 * and structurally type the known-optional ones; unknown fields pass
 * through and are ignored by the handlers, matching the prior runtime
 * behaviour exactly.
 *
 * For NEW endpoints, follow `src/schemas/queue.ts`'s strict pattern.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Cycle record — POST /api/autopilot/cycle-record
// ---------------------------------------------------------------------------

export const CycleRecordBodySchema = z
  .looseObject({
    cycleId: z.string().trim().min(1, { message: "cycleId must be a non-empty string" }),
    status: z.string().optional(),
    source: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    total: z.union([z.number(), z.string()]).optional(),
    completed: z.union([z.number(), z.string()]).optional(),
    failed: z.union([z.number(), z.string()]).optional(),
    abandoned: z.union([z.number(), z.string()]).optional(),
    tasksMerged: z.union([z.number(), z.string()]).optional(),
    tasksFailed: z.union([z.number(), z.string()]).optional(),
    tasksAbandoned: z.union([z.number(), z.string()]).optional(),
    tasksAttempted: z.union([z.number(), z.string()]).optional(),
    totalDurationMs: z.union([z.number(), z.string()]).optional(),
    anchorType: z.string().optional(),
    anchorReference: z.string().optional(),
    taskTitle: z.string().optional(),
    prNumber: z.union([z.number(), z.string()]).optional(),
    abandonReason: z.string().optional(),
    regressionIntroduced: z.boolean().optional(),
    autopilotTurnId: z.string().optional(),
    worktreeBranch: z.string().optional(),
    costUsd: z.number().optional(),
  });

export type CycleRecordBody = z.infer<typeof CycleRecordBodySchema>;

// ---------------------------------------------------------------------------
// Run lifecycle — POST /api/autopilot/run-start, /run-end
// ---------------------------------------------------------------------------

export const RunStartBodySchema = z
  .looseObject({
    run_id: z.string().trim().min(1, { message: "run_id must be a non-empty string" }),
    started: z.string().optional(),
    started_epoch: z.number().optional(),
    pid: z.number().optional(),
    trigger: z.string().optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
  });

export type RunStartBody = z.infer<typeof RunStartBodySchema>;

export const RunEndBodySchema = z
  .looseObject({
    run_id: z.string().trim().min(1, { message: "run_id must be a non-empty string" }),
    cause: z.string().optional(),
    ended_epoch: z.number().optional(),
    exit_code: z.number().optional(),
  });

export type RunEndBody = z.infer<typeof RunEndBodySchema>;

// ---------------------------------------------------------------------------
// Turn — POST /api/autopilot/turn
// ---------------------------------------------------------------------------

/**
 * A single turn action. The runtime accepts any shape with a `type`
 * field; the orchestrator only inspects `type === "dispatch"` (to
 * count dispatches and join cycle outcomes). All other fields pass
 * through and are surfaced in the dashboard's turn timeline verbatim.
 */
export const TurnActionSchema = z
  .looseObject({
    type: z.string().optional(),
  });

export const TurnBodySchema = z
  .looseObject({
    run_id: z.string().trim().min(1, { message: "run_id must be a non-empty string" }),
    turn_n: z.number({ message: "turn_n must be a number" }).int().nonnegative(),
    epoch: z.number().optional(),
    actions: z.array(TurnActionSchema).optional(),
    reasons: z.array(z.string()).optional(),
    slots_snapshot: z.record(z.string(), z.unknown()).optional(),
    signals_snapshot: z.record(z.string(), z.unknown()).optional(),
    tokens_after: z.number().optional(),
    idle_turns: z.number().optional(),
  });

export type TurnBody = z.infer<typeof TurnBodySchema>;
export type TurnAction = z.infer<typeof TurnActionSchema>;

// ---------------------------------------------------------------------------
// Emergency brake — POST /api/autopilot/emergency-brake (issue #744)
// ---------------------------------------------------------------------------

/**
 * Operator-only emergency-brake toggle body. NEW endpoint, so strict
 * (per the "For NEW endpoints, follow queue.ts's strict pattern" note above):
 * an unknown field is a caller bug we want surfaced, not silently ignored.
 *
 *   engaged: true  => pull the brake (pause all auto-merge, route open PRs to
 *                     /hydra-review).
 *   engaged: false => release the brake (resume ADR-0015 depth-gated merge).
 *
 * `engagedBy` is an optional operator-attribution string recorded for the
 * incident audit trail (defaults server-side to "operator").
 */
export const EmergencyBrakeBodySchema = z
  .strictObject({
    engaged: z.boolean({ message: "engaged must be a boolean" }),
    engagedBy: z.string().trim().min(1).optional(),
  });

export type EmergencyBrakeBody = z.infer<typeof EmergencyBrakeBodySchema>;
