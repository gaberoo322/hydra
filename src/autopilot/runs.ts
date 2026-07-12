/**
 * Autopilot Run + Turn lifecycle **WRITES** — the orchestrator-side Module
 * that owns the contract behind `POST /api/autopilot/*`.
 *
 * The read-only **projections** were split into the sibling
 * `run-projections.ts` (issue #1183), which is their canonical home. The
 * back-compat re-export relay was retired (issue #2125), so callers import
 * projection symbols from `run-projections.ts` directly.
 *
 * The **sweep-composite-reader idiom** (the dead-pid sweeper `sweepRunIfDead`
 * plus the `readAndSweepAutopilotRun` / `readLifecycleState` / `sweepLoadedRow`
 * readers that pair a Redis load with that sweep, and the `RUN_TTL_SECONDS`
 * constant) was likewise extracted into the sibling `sweep-reader.ts`
 * (issue #2568): one Module per concern. This write Module imports only the
 * `RUN_TTL_SECONDS` constant it needs along the single `runs → sweep-reader`
 * edge; it does NOT re-export that surface (AC2 / #2125 precedent), so external
 * callers import the sweep helpers from `sweep-reader.ts` directly.
 *
 * The **composite READ orchestrators** — the high-level readers
 * (`getCurrentLifecycle` / `getCurrentRun` / `getRun` / `getRunRow` /
 * `listRuns` / `readInflightSlotSeed` / `getRunDispatchClasses`) that DRIVE the
 * projections + sweep readers to assemble caller-facing views — were finally
 * split into the sibling `run-reads.ts`, completing the write/read separation
 * #1183 began and #2568 extended (one Module per concern). This write Module
 * exposes only the lifecycle WRITE methods; callers import the readers from
 * `run-reads.ts` directly (no back-compat re-export here — the #2125 precedent).
 * The shared result-type primitives (`Ok` / `Err` / `errRedis` / `numberOrDefault`)
 * were extracted into the zero-I/O leaf `run-result.ts` (issue #3087) so BOTH
 * the read module (`run-reads.ts`) and the sibling write module (`cycle-close.ts`)
 * import them DOWN from that leaf rather than sideways from this write module.
 * This write Module imports the value helpers (`errRedis` / `numberOrDefault`) and
 * the `Ok` / `Err` types it uses internally; it no longer re-exports any of them.
 * Both back-compat re-exports were dropped once no caller imported them from here —
 * the value helpers in issue #3144 and the `Ok` / `Err` types in issue #3149; every
 * caller imports these from the `run-result.ts` leaf directly.
 *
 * The **dispatch → PR link** writer `recordDispatchPr` (plus its
 * `RecordDispatchPrBody` / `RecordDispatchPrResult` types) was extracted into the
 * sibling `dispatch-pr-link.ts` (issue #3205). That write is NOT part of the
 * run/turn lifecycle — it feeds the Builder-Health Scorecard's Autonomy Rate /
 * time-to-merge and its only live caller is `src/api/builder-health.ts` — so it
 * now lives in the Builder Health instrumentation domain, symmetric with its
 * reader sibling `aggregators/autonomy-rate.ts`. This completes the future
 * clean-up the `run-reads.ts` header anticipated; callers import
 * `recordDispatchPr` from `dispatch-pr-link.ts` directly (no re-export here,
 * the #2125 precedent).
 *
 * Concepts (see `CONTEXT.md`):
 *   - **Autopilot Run** — one invocation of `/hydra-autopilot`,
 *     bookended by run-start / run-end, persisted as
 *     `hydra:autopilot:run:<runId>` with a ZSET index.
 *   - **Autopilot Turn** — one iteration of the decision loop inside a
 *     run, persisted as an immutable JSON member in
 *     `hydra:autopilot:run:<runId>:turns` (score = `turn_n`).
 *
 * The Module exposes the lifecycle write methods (idempotent on their
 * stable keys). Side effects only happen through this seam — the route
 * layer never touches `redis/autopilot-runs.ts` directly. Errors are
 * returned as result objects, never thrown, matching the
 * `merge/grounding/verification` convention in CLAUDE.md.
 *
 * Result-object shape:
 *
 *     type Result<T> =
 *       | { ok: true } & T
 *       | { ok: false; code: ErrorCode; detail?: string }
 *
 * ErrorCode is one of:
 *   - "duplicate"   — idempotent no-op (same run/turn/cycle already recorded)
 *   - "not-found"   — operating on a run/turn that doesn't exist
 *   - "invalid"     — caller-supplied data failed semantic validation
 *                     (route layer translates to HTTP 400; schema-level
 *                     errors are caught upstream by zod)
 *   - "redis"       — Redis error; `detail` carries the message
 */

import {
  getAutopilotRun,
  initAutopilotRun,
  updateAutopilotRunFields,
  setAutopilotRunField,
  incrAutopilotRunField,
  refreshAutopilotRunTTL,
  addAutopilotRunToIndex,
  addAutopilotRunTurn,
  hasAutopilotRunTurnAt,
} from "../redis/autopilot-runs.ts";
import { recordAnchorReflection } from "../reflections/per-anchor.ts";
import type {
  CrashDetail,
  RunStartBody,
  RunEndBody,
  TurnBody,
  ReflectionRecordBody,
} from "./schemas.ts";
// `isPidAlive` (the liveness probe the injectable deps bag defaults to) is
// imported from `run-projections.ts` (issue #1183); the composite READ
// projections moved to `run-reads.ts` along with the readers that drove them.
import { isPidAlive } from "./run-projections.ts";
// The sweep-composite-reader idiom was extracted into the sibling
// `sweep-reader.ts` (issue #2568). The write lifecycle below imports only the
// `RUN_TTL_SECONDS` constant it needs along this single `runs → sweep-reader`
// edge (one-directional, acyclic). There is NO re-export of the sweep surface
// here (AC2, #2125 precedent): external callers import the sweep helpers from
// `sweep-reader.ts` directly.
import { RUN_TTL_SECONDS } from "./sweep-reader.ts";
// Issue #2956: workless-board backoff hint. endRun stamps it on a zero-dispatch
// idle exit so the pace-gate skips relaunch into a still-workless board. The
// setter is injected via the deps bag (defaulting to the real Redis write) so
// the endRun path stays testable without Redis.
import { setWorklessUntil, worklessBackoffSec } from "../redis/workless-hint.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * `term_reason` values the autopilot writers are allowed to emit. Anything
 * else is normalised to `"unknown"` so a writer typo can't break the read-back.
 *
 * `budget` / `wall_clock` / `idle` come from `term-check.py`'s in-loop stop
 * decisions. `interrupted` is the reap-on-exit backstop's cause for a clean
 * process exit that did NOT route through a term-check stop (print-mode end,
 * SIGTERM from `systemctl restart` / `RuntimeMaxSec`) — distinct from a genuine
 * `crash` (issue #898), which is an abnormal exit that also missed a run-end.
 *
 * `handoff` (issue #1903) is a CLEAN self-termination: the print-mode session
 * deliberately ended a turn while subagent slots were STILL occupied
 * (`slots_occupied > 0`), handing the in-flight work to the durable subagent
 * dispatch ledger (`hydra:dispatches:subagent:*`) that the NEXT pace-gate-
 * launched run re-seeds via #1352. It is an honest baton-pass, NOT the crash-
 * adjacent `interrupted` — which now stays reserved for a clean ZERO-slot exit
 * that bypassed term-check (a genuine print-mode end with nothing in flight).
 */
const VALID_TERM_REASONS: ReadonlySet<string> = new Set([
  "budget",
  "wall_clock",
  "idle",
  "handoff",
  "interrupted",
  "failure_backstop",
  "crash",
]);

/**
 * `term_reason` values that mark an abnormal (non-clean) termination — the only
 * ones a `crash_detail` snapshot is recorded for (issue #1079). A clean stop
 * carries no crash detail even if a caller sends one, so the field stays a
 * reliable "this run died badly, here's why" signal rather than ambient noise.
 */
const CRASH_TERM_REASONS: ReadonlySet<string> = new Set([
  "crash",
  "failure_backstop",
]);

/**
 * Server-side defensive cap on the persisted `crash_detail.log_tail`. The reap
 * writer (`bootstrap.sh`) already ships a bounded slice; this belt-and-braces
 * truncation stops a misbehaving / future writer bloating the run hash. ~8 KB
 * comfortably holds the last ~50-100 log lines.
 */
const CRASH_DETAIL_LOG_TAIL_MAX_CHARS = 8 * 1024;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

// Shared result-type primitives + the `errRedis` helper now live in the zero-I/O
// leaf `run-result.ts` (issue #3087). This write Module imports the value helpers
// (`errRedis` / `numberOrDefault`) and the `Ok` / `Err` types it uses internally
// (see `RecordReflectionOutcomeResult` / `RunStartResult` below). The read module
// (`run-reads.ts`) and the sibling write module (`cycle-close.ts`) import DOWN from
// the leaf directly rather than sideways from this write module. Both back-compat
// re-exports through this module were dropped once no caller imported them from
// here — the value helpers (`errRedis` / `numberOrDefault`) in issue #3144, and the
// `Ok` / `Err` types in issue #3149; every caller imports from the leaf. `ErrorCode`
// stays module-internal to the leaf.
import { errRedis, numberOrDefault } from "./run-result.ts";
import type { Ok, Err } from "./run-result.ts";

// ---------------------------------------------------------------------------
// Injectable run/turn-lifecycle-write deps (issue #2158; narrowed by #2768)
//
// The run/turn-lifecycle writers (`startRun`/`endRun`/`recordTurn`) each touch
// the Redis Adapters seam. That made the lifecycle write POLICY — idempotency
// keying, term_reason normalisation, crash-detail capture — only exercisable
// with a live Redis. (The dead-pid running→killed/crash sweeper `sweepRunIfDead`
// was extracted into `sweep-reader.ts` with its own narrow `SweepReaderDeps` in
// #2568; this bag STRUCTURALLY satisfies that narrow surface, so the deps-test
// fixture still passes this bag to the sweeper unchanged.) This seam wraps those
// writes in an injectable deps bag so the SAME policy is testable on in-memory
// fixtures — exactly the precedent the read-side `ProjectionDeps`
// (run-projections.ts, #1183) set.
//
// Issue #2768 narrowed this bag: `recordCycle` (the cross-domain cycle-close
// coordinator) moved to the sibling `cycle-close.ts`, taking its
// cycle/scheduler/metrics facades with it into the new `CycleCloseDeps`. So this
// bag now carries only the run/turn-write facet (`runs`) plus the shared
// `isPidAlive` / `now` fields.
//
// Shape decisions (per the approved design concept for #2158):
//   - GROUPED named sub-facades (here `runs`), not a flat bag, following the
//     `RecsRedisFacade` precedent in recommendation-engine.ts.
//   - The facade fields are the TYPED redis/<domain>.ts accessors (never a raw
//     Redis client), so a test double honours the same typed contract and the
//     Redis Adapters seam is never bypassed in production.
//   - A SINGLE `now()` epoch-ms clock (the `EngineDeps` precedent): both the
//     `*_epoch` seconds fields (`Math.floor(now()/1000)`) and the ISO strings
//     (`new Date(now()).toISOString()`) derive from it — one source of truth.
//   - `isPidAlive` is RE-DECLARED here (same field name as `ProjectionDeps` /
//     `SweepReaderDeps`, by convention not interface inheritance) so this bag
//     still structurally satisfies the moved sweeper's narrow deps surface and
//     the deps-test fixture's dead-pid branch stays reachable on a synthetic
//     `running` row without faking a real dead PID.
//
// Default deps route through the exact same accessors + clock as before, so
// omitting the `deps` arg is byte-for-byte the current production behaviour and
// every existing call site in src/api/autopilot-lifecycle.ts is unchanged.
// ---------------------------------------------------------------------------

/** Run-hash + index + turn accessors the run/turn writers touch. */
interface AutopilotRunsRunFacade {
  getAutopilotRun(runId: string): Promise<Record<string, string>>;
  initAutopilotRun(
    runId: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void>;
  updateAutopilotRunFields(
    runId: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void>;
  setAutopilotRunField(runId: string, field: string, value: string): Promise<void>;
  incrAutopilotRunField(runId: string, field: string, by: number): Promise<void>;
  refreshAutopilotRunTTL(runId: string, ttlSeconds: number): Promise<void>;
  addAutopilotRunToIndex(
    runId: string,
    scoreEpochSeconds: number,
    ttlSeconds: number,
  ): Promise<void>;
  addAutopilotRunTurn(
    runId: string,
    turnN: number,
    member: string,
    ttlSeconds: number,
  ): Promise<void>;
  hasAutopilotRunTurnAt(runId: string, turnN: number): Promise<boolean>;
}

export interface AutopilotRunsDeps {
  runs: AutopilotRunsRunFacade;
  /**
   * Liveness probe used by the dead-pid sweeper. Same field name as
   * `ProjectionDeps.isPidAlive` (by convention, not inheritance) and defaults
   * to the same `isPidAlive` imported from run-projections.ts. Injecting it
   * makes the sweeper's `running`→`killed`/`crash` branch reachable on a
   * synthetic row without spawning/killing a real PID.
   */
  isPidAlive: (pid: number) => boolean;
  /**
   * Epoch-MS clock. A single source of truth: `*_epoch` seconds fields derive
   * via `Math.floor(now()/1000)` and ISO strings via `new Date(now())`.
   * Defaults to `Date.now`.
   */
  now: () => number;
  /**
   * Stamp the workless-board backoff hint (issue #2956). Called by {@link endRun}
   * ONLY when a run terminates cause=idle having dispatched nothing. Given the
   * hint instant (epoch-ms) and `nowMs`, records it (self-clearing by TTL) and
   * returns the stored instant, or `null` when nothing was stored. Defaults to
   * the real Redis write (`setWorklessUntil`); injected so the endRun idle path
   * is testable without Redis. NEVER throws to endRun — the write is best-effort.
   */
  stampWorklessHint: (worklessUntilMs: number, nowMs: number) => Promise<number | null>;
}

const defaultAutopilotRunsDeps: AutopilotRunsDeps = {
  runs: {
    getAutopilotRun,
    initAutopilotRun,
    updateAutopilotRunFields,
    setAutopilotRunField,
    incrAutopilotRunField,
    refreshAutopilotRunTTL,
    addAutopilotRunToIndex,
    addAutopilotRunTurn,
    hasAutopilotRunTurnAt,
  },
  isPidAlive,
  now: Date.now,
  stampWorklessHint: setWorklessUntil,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a `crash_detail` snapshot into the bounded, persistable shape
 * (issue #1079). Drops empty fields, coerces `exit_code` to a finite number,
 * and re-truncates `log_tail` server-side as a defensive cap (the writer is
 * already expected to bound it). Returns `null` when nothing survives — the
 * caller then writes no `crash_detail` field at all rather than an empty
 * object, so a read can treat presence as "we captured something".
 */
function sanitizeCrashDetail(detail: CrashDetail | undefined): Record<string, unknown> | null {
  if (!detail || typeof detail !== "object") return null;
  const out: Record<string, unknown> = {};
  if (typeof detail.signal === "string" && detail.signal.trim().length > 0) {
    out.signal = detail.signal.trim();
  }
  if (typeof detail.exit_code === "number" && Number.isFinite(detail.exit_code)) {
    out.exit_code = detail.exit_code;
  }
  if (typeof detail.last_action === "string" && detail.last_action.trim().length > 0) {
    out.last_action = detail.last_action.trim();
  }
  if (typeof detail.log_tail === "string" && detail.log_tail.length > 0) {
    const tail = detail.log_tail;
    // Keep the TAIL of the tail — the most-recent lines carry the failure.
    out.log_tail =
      tail.length > CRASH_DETAIL_LOG_TAIL_MAX_CHARS
        ? tail.slice(-CRASH_DETAIL_LOG_TAIL_MAX_CHARS)
        : tail;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Lifecycle: reflection-record (issue #1119)
// ---------------------------------------------------------------------------

export type RecordReflectionOutcomeResult = Ok<{
  anchorRef: string;
  outcome: string;
}> | Err;

/**
 * Re-wire a reflection PRODUCER onto the live path (issue #1119, Slice 1).
 *
 * `recordAnchorReflection` lost its only live caller when #710 deleted the
 * in-process planner, so the per-anchor reflection store went structurally
 * empty (`GET /api/reflections?anchor=` → `count:0`), and a retry of a
 * prior-failure anchor silently lost its own failure context (the #193
 * retry-correctness invariant). This wrapper is the orchestrator-side entry
 * point the reap path calls (via `POST /api/autopilot/reflection-record`) when
 * a dispatch terminalises NON-MERGED, so the next attempt's pull is non-empty.
 *
 * Never throws — returns an Ok/Err result (the merge/grounding/verification
 * convention); a reflection-write failure is learning, not correctness, and the
 * reap path swallows a non-2xx. A thin pass-through onto the producer's opts;
 * idempotency is the producer's capped per-anchor ring plus reap's
 * `reaped_task_ids` ledger keyed on `cycleId`.
 */
export async function recordReflectionOutcome(
  body: ReflectionRecordBody,
): Promise<RecordReflectionOutcomeResult> {
  try {
    const anchorRef = body.anchorRef.trim();
    const outcome = body.outcome.trim();
    if (!anchorRef) {
      return { ok: false, code: "invalid", detail: "anchorRef must be a non-empty string" };
    }
    if (!outcome) {
      return { ok: false, code: "invalid", detail: "outcome must be a non-empty string" };
    }
    const cycleId =
      typeof body.cycleId === "string" && body.cycleId.trim().length > 0
        ? body.cycleId.trim()
        : `reflection-${anchorRef}-${Date.now()}`;

    await recordAnchorReflection({
      cycleId,
      anchorRef,
      taskTitle: body.taskTitle ?? anchorRef,
      outcome,
      reason: body.reason,
      scopeFiles: body.scopeFiles,
    });

    return { ok: true, anchorRef, outcome };
  } catch (err: any) {
    // Never throw out of this path — reflection writes are best-effort
    // learning, not correctness. Surface the failure as an Err so the route
    // can answer 500 without crashing the reap-side POST.
    return errRedis(err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: run-start
// ---------------------------------------------------------------------------

export type RunStartResult = Ok<{ run_id: string; deduped: boolean }> | Err;

export async function startRun(
  body: RunStartBody,
  deps: AutopilotRunsDeps = defaultAutopilotRunsDeps,
): Promise<RunStartResult> {
  try {
    const runId = body.run_id.trim();
    const started = body.started || new Date(deps.now()).toISOString();
    const startedEpoch = numberOrDefault(body.started_epoch, Math.floor(deps.now() / 1000));
    const pid = numberOrDefault(body.pid, 0);
    const trigger =
      typeof body.trigger === "string" && body.trigger.length > 0 ? body.trigger : "manual";
    const limits = body.limits && typeof body.limits === "object" ? body.limits : {};

    // Idempotency: a row with `started` filled means run-start already fired.
    const existing = await deps.runs.getAutopilotRun(runId);
    if (existing && existing.started) {
      return { ok: true, run_id: runId, deduped: true };
    }

    await deps.runs.initAutopilotRun(runId, {
      run_id: runId,
      started,
      started_epoch: String(startedEpoch),
      status: "running",
      trigger,
      pid: String(pid),
      limits: JSON.stringify(limits),
      turns: "0",
      dispatches: "0",
      // `cumulative_tokens` is a dashboard-facing MIRROR of state.json's
      // per-turn token surrogate, advanced by `recordTurn` from each turn's
      // `tokens_after` POST (see the write below). It is NOT the autopilot's
      // budget gate: `TERM:budget` reads state.json directly in
      // scripts/autopilot/term-check.py (+ decide.py `_check_termination`), so
      // a 0 here never disables termination (issue #2429). It stays 0 only for
      // a run that never accumulates surrogate tokens — e.g. a 1-2-turn run
      // that exits under the print-mode session model (#1352/#1903) before the
      // surrogate grows. Multi-turn runs carry the real accumulated value.
      cumulative_tokens: "0",
      idle_turns: "0",
      last_heartbeat_epoch: String(startedEpoch),
    }, RUN_TTL_SECONDS);
    await deps.runs.addAutopilotRunToIndex(runId, startedEpoch, RUN_TTL_SECONDS);

    return { ok: true, run_id: runId, deduped: false };
  } catch (err: any) {
    return errRedis(err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: run-end
// ---------------------------------------------------------------------------

export type RunEndResult =
  | Ok<{ run_id: string; status: string; term_reason: string; deduped: boolean }>
  | Err;

export async function endRun(
  body: RunEndBody,
  deps: AutopilotRunsDeps = defaultAutopilotRunsDeps,
): Promise<RunEndResult> {
  try {
    const runId = body.run_id.trim();
    const existing = await deps.runs.getAutopilotRun(runId);
    if (!existing || !existing.started) {
      return { ok: false, code: "not-found", detail: `unknown run_id: ${runId}` };
    }

    // Idempotency: already terminal → keep first end's term_reason as truth.
    if (existing.status && existing.status !== "running") {
      return {
        ok: true,
        run_id: runId,
        status: existing.status,
        term_reason: existing.term_reason || "",
        deduped: true,
      };
    }

    const cause = typeof body.cause === "string" ? body.cause : "";
    const termReason = VALID_TERM_REASONS.has(cause) ? cause : "unknown";
    const endedEpoch = numberOrDefault(body.ended_epoch, Math.floor(deps.now() / 1000));
    const exitCode = body.exit_code !== undefined ? numberOrDefault(body.exit_code, 0) : 0;

    const fields: Record<string, string> = {
      status: "ended",
      term_reason: termReason,
      ended_epoch: String(endedEpoch),
      exit_code: String(exitCode),
    };

    // Issue #1079: capture a durable, structured crash snapshot ONLY for an
    // abnormal termination. Stored as a JSON string on the run hash so it
    // survives log/journal rotation — the gap the ephemeral #499 endpoints
    // left. A clean stop never persists crash_detail even if a caller sends
    // one, so the field stays a reliable "died badly, here's why" signal.
    if (CRASH_TERM_REASONS.has(termReason)) {
      const detail = sanitizeCrashDetail(body.crash_detail);
      if (detail) fields.crash_detail = JSON.stringify(detail);
    }

    await deps.runs.updateAutopilotRunFields(runId, fields, RUN_TTL_SECONDS);

    // Issue #2956 — workless-board backoff hint. When a run terminates
    // cause=idle having dispatched NOTHING, the board was fully workless (every
    // class on cooldown, no signals firing): decide.py's first wait-only turn
    // tripped `_rule_idle_fallback` and ended the run in ~2 minutes. Stamp a
    // short temporal hint so the pace-gate skips relaunch into that same
    // workless board instead of spawning another zero-dispatch idle exit
    // (~14% of runs). ONLY on idle + zero-dispatch: any dispatch (or a
    // budget/wall_clock/crash exit) means real work was available, so we must
    // launch normally next cadence. Best-effort — a write failure must never
    // change the run-end verdict, so its own catch swallows and logs.
    if (termReason === "idle") {
      // Fail SAFE to "had work" on an unparseable count: only an AFFIRMATIVE
      // zero suppresses the next launch, so a garbage `dispatches` field can
      // never wrongly hold the launcher off.
      const dispatches = Number(existing.dispatches || "0");
      if (Number.isFinite(dispatches) && dispatches === 0) {
        try {
          const nowMs = deps.now();
          const worklessUntilMs = nowMs + worklessBackoffSec() * 1000;
          await deps.stampWorklessHint(worklessUntilMs, nowMs);
        } catch (err: any) {
          console.error(
            `[autopilot] endRun workless-hint stamp failed (run_id=${runId}); pace-gate will launch normally: ${err?.message || err}`,
          );
        }
      }
    }

    return {
      ok: true,
      run_id: runId,
      status: "ended",
      term_reason: termReason,
      deduped: false,
    };
  } catch (err: any) {
    return errRedis(err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: turn
// ---------------------------------------------------------------------------

export type RecordTurnResult =
  | Ok<{ run_id: string; turn_n: number; deduped: boolean; dispatch_count: number }>
  | Err;

export async function recordTurn(
  body: TurnBody,
  deps: AutopilotRunsDeps = defaultAutopilotRunsDeps,
): Promise<RecordTurnResult> {
  try {
    const runId = body.run_id.trim();
    const turnN = body.turn_n;
    const epoch = numberOrDefault(body.epoch, Math.floor(deps.now() / 1000));

    const runRow = await deps.runs.getAutopilotRun(runId);
    if (!runRow || !runRow.started) {
      return { ok: false, code: "not-found", detail: `unknown run_id: ${runId}` };
    }

    if (await deps.runs.hasAutopilotRunTurnAt(runId, turnN)) {
      return { ok: true, run_id: runId, turn_n: turnN, deduped: true, dispatch_count: 0 };
    }

    const actions = Array.isArray(body.actions) ? body.actions : [];
    const reasons = Array.isArray(body.reasons) ? body.reasons : [];
    const slotsSnapshot =
      body.slots_snapshot && typeof body.slots_snapshot === "object" ? body.slots_snapshot : {};
    const signalsSnapshot =
      body.signals_snapshot && typeof body.signals_snapshot === "object"
        ? body.signals_snapshot
        : {};
    const tokensAfter = numberOrDefault(body.tokens_after, 0);
    const idleTurns = numberOrDefault(body.idle_turns, 0);

    const dispatchCount = actions.reduce(
      (n, a) => (a && (a as any).type === "dispatch" ? n + 1 : n),
      0,
    );

    const turnMember = JSON.stringify({
      turn_n: turnN,
      epoch,
      actions,
      reasons,
      slots_snapshot: slotsSnapshot,
      signals_snapshot: signalsSnapshot,
      tokens_after: tokensAfter,
      idle_turns: idleTurns,
    });

    // 1. Immutable turn row.
    await deps.runs.addAutopilotRunTurn(runId, turnN, turnMember, RUN_TTL_SECONDS);

    // 2. Counter updates — single-field writes so slice-1 fields stay intact.
    const currentTurns = Number(runRow.turns || "0");
    if (turnN > currentTurns) {
      await deps.runs.setAutopilotRunField(runId, "turns", String(turnN));
    }
    if (dispatchCount > 0) {
      await deps.runs.incrAutopilotRunField(runId, "dispatches", dispatchCount);
    }
    // Mirror state.json's surrogate onto the run hash (issue #2429). `tokensAfter`
    // is the per-turn `tokens_after` POSTed by heartbeat.py, which sources it from
    // state.json `cumulative_tokens` — so this field tracks the same value the
    // live `TERM:budget` gate reads, NOT an independent accounting. See the
    // init-site comment above for why this is dashboard-only and never the gate.
    await deps.runs.setAutopilotRunField(runId, "cumulative_tokens", String(tokensAfter));
    await deps.runs.setAutopilotRunField(runId, "idle_turns", String(idleTurns));
    await deps.runs.setAutopilotRunField(runId, "last_heartbeat_epoch", String(epoch));
    await deps.runs.refreshAutopilotRunTTL(runId, RUN_TTL_SECONDS);

    return { ok: true, run_id: runId, turn_n: turnN, deduped: false, dispatch_count: dispatchCount };
  } catch (err: any) {
    return errRedis(err);
  }
}

