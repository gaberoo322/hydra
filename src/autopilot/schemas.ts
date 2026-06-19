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
    // Issue #2063: the integer COUNT of files the merged PR changed
    // (`gh pr view --json files --jq '.files | length'`). OPTIONAL on purpose:
    // it is only knowable on the merged/auto-merge follow-up write (the PR
    // number is unknown at reap time — reap.py hardcodes pr_number=""), so the
    // reap-time write omits it and the later PR-aware write enriches the
    // already-recorded cycle. recordCycle maps it onto the metrics hash, where
    // it is a NUMERIC field (aggregate.ts reduces `m.filesChanged || 0`,
    // run-projections.ts reads `hash.filesChanged || null`). This is NOT the
    // string[] path list the capacity-floor reactor consumes — it is a
    // non-negative integer count. Accepts number|string for the same
    // loose-script-payload tolerance as the other count fields above; a genuine
    // zero-file cycle records 0 truthfully (distinguishable from never-written).
    filesChanged: z.union([z.number(), z.string()]).optional(),
    // Issue #1136 (Slice 2 of #1119): the comma-separated reflection bucket
    // tokens (`per-anchor` / `by-file` / ...) the code-writing dispatch was
    // SERVED at planning time by `GET /api/reflections`, reported back so
    // `deriveReflectionMatchSource` (src/metrics/trend.ts) stops reading
    // 'none' on every cycle. OPTIONAL on purpose: the dispatch deposits the
    // string only when it served reflections, reap reads an absent deposit
    // file as empty, and every existing reap call / non-code-writing class
    // omits it entirely — so this is byte-for-byte backward compatible.
    // recordCycle is a pure PASS-THROUGH of this field (it never derives it);
    // the Slice-1 wrong-altitude guard (reap time has no planning-time
    // knowledge) stays intact because the string crosses the gap via the
    // dispatch's deposit file, not reap's own knowledge.
    reflectionSources: z.string().optional(),
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

/**
 * Structured crash snapshot captured at run-end for an abnormal termination
 * (issue #1079). Durable on the run hash so a crash is drillable AFTER the
 * ephemeral `/log` (`.log.prev`-bounded) and systemd journal have rotated.
 *
 * Every field is optional — the reap backstop fills what it can derive
 * (`signal` / `exit_code` from systemd, `log_tail` from the run log) and a
 * read-time sweep that never saw a POST may carry only the minimal shape.
 * `log_tail` is bounded by the writer (`bootstrap.sh` ships a small slice;
 * `endRun` re-truncates server-side as a defensive cap).
 */
const CrashDetailSchema = z
  .looseObject({
    /** Signal name that killed the process (e.g. `SEGV`, `KILL`), when known. */
    signal: z.string().optional(),
    /** Process exit code, when systemd reported one. */
    exit_code: z.number().optional(),
    /** Last action / phase the loop reached before dying, when known. */
    last_action: z.string().optional(),
    /** Bounded tail of the run log at crash time (survives log rotation). */
    log_tail: z.string().optional(),
  });

export type CrashDetail = z.infer<typeof CrashDetailSchema>;

export const RunEndBodySchema = z
  .looseObject({
    run_id: z.string().trim().min(1, { message: "run_id must be a non-empty string" }),
    cause: z.string().optional(),
    ended_epoch: z.number().optional(),
    exit_code: z.number().optional(),
    crash_detail: CrashDetailSchema.optional(),
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
const TurnActionSchema = z
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

// ---------------------------------------------------------------------------
// Autopilot pause — POST /api/autopilot/paused (issue #988)
// ---------------------------------------------------------------------------

/**
 * Operator-only autopilot-pause toggle body. NEW endpoint, so strict (per the
 * "For NEW endpoints, follow queue.ts's strict pattern" note above): an
 * unknown field is a caller bug we want surfaced, not silently ignored.
 *
 *   paused: true  => pause autopilot (launcher skips, brain drains — no new
 *                    dispatches; in-flight subagents are untouched).
 *   paused: false => resume autopilot.
 *
 * No attribution field (unlike the emergency-brake's `engagedBy`): the pause
 * blob is `{paused, since}` only, by design (issue #988).
 */
export const AutopilotPauseBodySchema = z
  .strictObject({
    paused: z.boolean({ message: "paused must be a boolean" }),
  });

// ---------------------------------------------------------------------------
// Reflection record — POST /api/autopilot/reflection-record (issue #1119)
// ---------------------------------------------------------------------------

/**
 * Reap-side reflection-record body — the WRITE-gap fix for the severed
 * episodic-reflection learning loop (issue #1119, Slice 1).
 *
 * The reflection PRODUCERS (`recordAnchorReflection`/`recordReflection`) lost
 * their only live caller when #710 deleted the in-process planner; the
 * CONSUMERS stayed live but read an always-empty store (the #841
 * `GET /api/reflections?anchor=` injection path, `loadAnchorReflectionsRaw` in
 * anchor scoring, retro-bundle's `readAnchorReflections`). This endpoint
 * re-wires a producer onto the autopilot reap path: when a dispatch
 * terminalises on a NON-MERGED outcome, `scripts/autopilot/reap.py` POSTs the
 * classified failure here so the next attempt's pull is non-empty — restoring
 * the #193 retry-correctness invariant.
 *
 * STRICT (per the "For NEW endpoints, follow queue.ts's strict pattern" note
 * at the top of this file): an unknown field is a caller bug we want surfaced.
 * The shape mirrors `recordAnchorReflection`'s opts:
 *
 *   anchorRef  — the anchor reference (issue ref, e.g. "issue-1119"); the
 *                reflection store keys on this. REQUIRED, non-empty.
 *   taskTitle  — the human task title carried in the dispatch envelope.
 *   outcome    — the classified self-heal pattern ID (no-diff /
 *                verification-failure / scope-violation / ...). REQUIRED,
 *                non-empty: a reflection is a prior-FAILURE narrative, so the
 *                failure category must be present.
 *   reason     — the cue/note digest (the stderr-line / stage tag the wrapper
 *                captured). REQUIRED, non-empty.
 *   cycleId    — the autopilot task_id; OPTIONAL. Drives the producer's
 *                per-record dedup (re-invocation for the same reaped dispatch
 *                converges harmlessly). Defaults server-side when absent.
 *   scopeFiles — OPTIONAL `## Files in scope` paths, for the #326 by-file
 *                secondary index so retries on a DIFFERENT anchor that touched
 *                the same files also surface this narrative.
 */
export const ReflectionRecordBodySchema = z
  .strictObject({
    anchorRef: z.string().trim().min(1, { message: "anchorRef must be a non-empty string" }),
    taskTitle: z.string().optional(),
    outcome: z.string().trim().min(1, { message: "outcome must be a non-empty string" }),
    reason: z.string().trim().min(1, { message: "reason must be a non-empty string" }),
    cycleId: z.string().trim().min(1).optional(),
    scopeFiles: z.array(z.string()).optional(),
  });

export type ReflectionRecordBody = z.infer<typeof ReflectionRecordBodySchema>;
