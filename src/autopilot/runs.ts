/**
 * Autopilot Run + Turn lifecycle — the orchestrator-side Module that
 * owns the contract behind `POST /api/autopilot/*` and the projections
 * that power `GET /api/autopilot/runs(/...)`.
 *
 * Concepts (see `CONTEXT.md`):
 *   - **Autopilot Run** — one invocation of `/hydra-autopilot`,
 *     bookended by run-start / run-end, persisted as
 *     `hydra:autopilot:run:<runId>` with a ZSET index.
 *   - **Autopilot Turn** — one iteration of the decision loop inside a
 *     run, persisted as an immutable JSON member in
 *     `hydra:autopilot:run:<runId>:turns` (score = `turn_n`).
 *
 * The Module exposes four lifecycle methods (idempotent on their
 * stable keys) and a small reader surface for the dashboard. Side
 * effects only happen through this seam — the route layer never
 * touches `redis/autopilot-runs.ts` directly. Errors are returned as
 * result objects, never thrown, matching the
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
  listRecentAutopilotRunIds,
  addAutopilotRunTurn,
  hasAutopilotRunTurnAt,
  listAutopilotRunTurnsDesc,
  putAutopilotPrLink,
} from "../redis/autopilot-runs.ts";
import {
  initCycleHash,
  getCycleHash,
  addCycleToIndex,
  getCycleHashesBatch,
} from "../redis/cycle-tracking.ts";
import {
  incrSchedulerCyclesRun,
  incrSchedulerCyclesMerged,
  incrSchedulerCyclesFailed,
} from "../redis/scheduler.ts";
import { recordCycleMetrics } from "../metrics/record.ts";
import { recordAnchorReflection } from "../reflections/reflections.ts";
import type {
  CrashDetail,
  CycleRecordBody,
  RunStartBody,
  RunEndBody,
  TurnBody,
  ReflectionRecordBody,
} from "./schemas.ts";
import { osHeartbeatAgeS, isOsHeartbeatStale } from "./os-heartbeat.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CYCLE_TTL_SECONDS = 7 * 24 * 3600;
export const RUN_TTL_SECONDS = 7 * 24 * 3600;
/**
 * Soft cap on turns the detail endpoint / digest projection will fetch
 * per run. Run TTL is 7d and token budgets keep autopilot runs well
 * under a few hundred turns; 10k is two orders of magnitude above that
 * ceiling so the cap only bites pathological data. Keeps Redis's LIMIT
 * arg inside the 64-bit signed-int comfort zone.
 */
export const RUN_TURNS_MAX_FETCH = 10000;
/**
 * Wedge-detection threshold for the read-time projection. Older
 * autopilots that hang past 10 minutes between turns get
 * `wedge_likely: true` on the response. Read-only metadata; no Redis
 * write follows.
 */
export const WEDGE_AGE_THRESHOLD_S = 600;

/**
 * `term_reason` values the autopilot writers are allowed to emit.
 * Anything else is normalised to `"unknown"` so a typo in the writer
 * can't break the read-back surface.
 *
 * `budget` / `wall_clock` / `idle` come from `term-check.py`'s in-loop
 * stop decisions. `interrupted` is the reap-on-exit backstop's cause for
 * a clean process exit that did NOT route through a term-check stop
 * (print-mode session end, SIGTERM from `systemctl restart` /
 * `RuntimeMaxSec`) — distinct from a genuine `crash` (issue #898).
 * `crash` is reserved for an abnormal exit (non-zero exit code) that
 * also missed a clean run-end.
 */
export const VALID_TERM_REASONS: ReadonlySet<string> = new Set([
  "budget",
  "wall_clock",
  "idle",
  "interrupted",
  "failure_backstop",
  "crash",
]);

/**
 * `term_reason` values that mark an abnormal (non-clean) termination — the
 * only ones a `crash_detail` snapshot is recorded for (issue #1079). A clean
 * stop (`budget` / `wall_clock` / `idle` / `interrupted`) carries no crash
 * detail even if a caller mistakenly sends one, so the field stays a reliable
 * "this run died badly, here's why" signal rather than ambient noise.
 */
export const CRASH_TERM_REASONS: ReadonlySet<string> = new Set([
  "crash",
  "failure_backstop",
]);

/**
 * Server-side defensive cap on the persisted `crash_detail.log_tail`. The
 * reap writer (`bootstrap.sh`) already ships a bounded slice; this is the
 * belt-and-braces truncation so a misbehaving / future writer can't bloat
 * the run hash. ~8 KB comfortably holds the last ~50-100 log lines.
 */
export const CRASH_DETAIL_LOG_TAIL_MAX_CHARS = 8 * 1024;

/**
 * Status values that count toward `cycles-merged` (vs `cycles-failed`).
 * Aligned with the autopilot taxonomy: a "cycle" merged when the
 * dispatched subagent landed a PR; failed when it abandoned, timed
 * out, or its PR closed unmerged.
 */
export const MERGED_STATUSES: ReadonlySet<string> = new Set([
  "merged",
  "completed",
  "succeeded",
]);
export const FAILED_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "abandoned",
  "aborted",
  "timeout",
  "timed-out",
]);

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ErrorCode = "duplicate" | "not-found" | "invalid" | "redis";

type Ok<T> = { ok: true; code?: undefined; detail?: undefined } & T;
type Err = { ok: false; code: ErrorCode; detail?: string };

function errRedis(err: any): Err {
  const detail = err?.message || String(err);
  console.error(`[autopilot] redis error: ${detail}`);
  return { ok: false, code: "redis", detail };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numberOrDefault(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Normalise a `crash_detail` snapshot into the bounded, persistable shape
 * (issue #1079). Drops empty fields, coerces `exit_code` to a finite number,
 * and re-truncates `log_tail` server-side as a defensive cap (the writer is
 * already expected to bound it). Returns `null` when nothing survives — the
 * caller then writes no `crash_detail` field at all rather than an empty
 * object, so a read can treat presence as "we captured something".
 */
export function sanitizeCrashDetail(detail: CrashDetail | undefined): Record<string, unknown> | null {
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

/**
 * Parse a persisted `crash_detail` JSON string back into an object for the
 * read projection. A missing / unparseable value yields `null` (treated as
 * "no crash detail captured") rather than throwing — the read surface must
 * stay loud-but-non-fatal.
 */
export function parseCrashDetail(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    console.error(`[autopilot] failed to parse crash_detail: ${err}`);
    return null;
  }
}

/**
 * `kill -0 pid` liveness probe. Returns true iff the pid is alive AND
 * we have permission to signal it (EPERM = alive-from-our-perspective).
 * pid <= 0 is treated as alive so the sweeper doesn't promote rows
 * from older writers that never stamped a pid.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = no such process; EPERM = exists but unsignalable (alive).
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

/**
 * Read-time sweeper for a dead-pid `running` row. The terminal status it
 * writes depends on whether a clean exit was recorded:
 *
 *   - If the row carries `exit_code === "0"` (an exit hook stamped a
 *     clean exit but the run-end POST that would have flipped `status`
 *     never landed), promote to `status: ended, term_reason: interrupted`
 *     — the process is gone but it exited cleanly.
 *   - Otherwise (no recorded exit code, or a non-zero one), promote to
 *     `status: killed, term_reason: crash` — the historical catch-all for
 *     "the process is gone and nobody recorded a clean run-end."
 *
 * Idempotent: only fires on a `running` row, and a terminal row written
 * once is never re-swept. With the reap-on-exit backstop (issue #898)
 * POSTing run-end on every exit path, this sweeper is now the rare
 * genuine-crash fallback rather than the common termination route.
 *
 * Exported so other read surfaces that scan autopilot run rows (e.g. the
 * active-dispatches aggregator's autopilot sub-source, issue #888) can
 * apply the SAME liveness rule rather than trusting `status: running`
 * verbatim — a crashed run that never POSTed its run-end would otherwise
 * linger as a phantom in-flight dispatch until the 7-day TTL.
 */
export async function sweepRunIfDead(
  runId: string,
  row: Record<string, string>,
): Promise<{ row: Record<string, string>; swept: boolean }> {
  if (row.status !== "running") return { row, swept: false };
  const pid = Number(row.pid || "0");
  if (isPidAlive(pid)) return { row, swept: false };

  const endedEpoch =
    Number(row.last_heartbeat_epoch || "0") ||
    Number(row.started_epoch || "0") ||
    Math.floor(Date.now() / 1000);

  // A recorded clean exit (exit_code === 0) means the process ended
  // normally even though the terminal run-end POST didn't land — treat
  // it as a clean interrupted end, not a crash. Reserve crash for a
  // missing or non-zero exit code.
  const cleanExit = row.exit_code !== undefined && Number(row.exit_code) === 0;
  const status = cleanExit ? "ended" : "killed";
  const termReason = cleanExit ? "interrupted" : "crash";

  const fields: Record<string, string> = {
    status,
    term_reason: termReason,
    ended_epoch: String(endedEpoch),
  };

  // Issue #1079: a dead-pid running row swept to `killed`/`crash` means NO
  // run-end POST ever landed — the reap backstop missed too. We can't recover
  // the signal/log_tail here, but stamp a minimal crash_detail (unless one was
  // already persisted) so this fallback path is still distinguishable from a
  // run that genuinely has no detail, and `last_action` records that the sweep
  // (not a clean term) produced the verdict.
  if (termReason === "crash" && row.crash_detail === undefined) {
    fields.crash_detail = JSON.stringify({
      last_action: "swept-dead-pid: no run-end POST received before pid death",
    });
  }

  await updateAutopilotRunFields(runId, fields, RUN_TTL_SECONDS);

  const mutated = {
    ...row,
    ...fields,
  };
  return { row: mutated, swept: true };
}

// ---------------------------------------------------------------------------
// Lifecycle: cycle-record
// ---------------------------------------------------------------------------

export type CycleRecordResult = Ok<{
  cycleId: string;
  status: string;
  bucketed: "merged" | "failed" | null;
  deduped: boolean;
}> | Err;

/**
 * Record one autopilot turn's code-writing subagent outcome. Three
 * complementary writes:
 *   1. `hydra:cycle:<id>` hash + ZADD to `hydra:cycle:index`
 *   2. `recordCycleMetrics(...)` — feeds /api/metrics + scheduler's mergeRateWindow
 *   3. Lifetime counters on `hydra:scheduler:cycles-{run,merged,failed}`
 *
 * Idempotent on `cycleId`: if the hash already has a `status`, the
 * call is a no-op and returns `deduped: true`. Callers key by a
 * stable identifier (autopilot turn id, worktree branch) so retries
 * collapse cleanly.
 */
export async function recordCycle(body: CycleRecordBody): Promise<CycleRecordResult> {
  try {
    const cycleId = body.cycleId.trim();
    const status =
      typeof body.status === "string" && body.status.length > 0 ? body.status : "completed";

    // Idempotency: if a status already exists, treat as already-filed.
    const existing = await getCycleHash(cycleId);
    if (existing && existing.status) {
      return { ok: true, cycleId, status: existing.status, bucketed: null, deduped: true };
    }

    const source =
      typeof body.source === "string" && body.source.length > 0 ? body.source : "claude";
    const startedAt = body.startedAt || new Date().toISOString();
    const completedAt = body.completedAt || new Date().toISOString();

    const total = numberOrDefault(body.total, 1);
    const completed = numberOrDefault(body.completed ?? body.tasksMerged, 0);
    const failed = numberOrDefault(body.failed ?? body.tasksFailed, 0);
    const abandoned = numberOrDefault(body.abandoned ?? body.tasksAbandoned, 0);

    await initCycleHash(cycleId, {
      status,
      startedAt,
      completedAt,
      source,
      total: String(total),
      completed: String(completed),
      failed: String(failed),
      abandoned: String(abandoned),
    }, CYCLE_TTL_SECONDS);
    await addCycleToIndex(cycleId, Date.now());

    const metrics: Record<string, any> = {
      source,
      anchorType: body.anchorType,
      anchorReference: body.anchorReference,
      taskTitle: body.taskTitle,
      tasksAttempted: numberOrDefault(body.tasksAttempted, total),
      tasksMerged: numberOrDefault(body.tasksMerged ?? body.completed, completed),
      tasksFailed: numberOrDefault(body.tasksFailed ?? body.failed, failed),
      tasksAbandoned: numberOrDefault(body.tasksAbandoned ?? body.abandoned, abandoned),
      totalDurationMs: numberOrDefault(body.totalDurationMs, 0),
      prNumber: body.prNumber !== undefined ? String(body.prNumber) : undefined,
      abandonReason: body.abandonReason,
      regressionIntroduced: body.regressionIntroduced === true ? true : undefined,
      autopilotTurnId: body.autopilotTurnId,
      worktreeBranch: body.worktreeBranch,
      costUsd: typeof body.costUsd === "number" ? body.costUsd : undefined,
    };
    for (const k of Object.keys(metrics)) {
      if (metrics[k] === undefined) delete metrics[k];
    }
    await recordCycleMetrics(cycleId, metrics);

    await incrSchedulerCyclesRun();
    const lowerStatus = status.toLowerCase();
    let bucketed: "merged" | "failed" | null = null;
    if (MERGED_STATUSES.has(lowerStatus)) {
      await incrSchedulerCyclesMerged();
      bucketed = "merged";
    } else if (FAILED_STATUSES.has(lowerStatus)) {
      await incrSchedulerCyclesFailed();
      bucketed = "failed";
    }

    return { ok: true, cycleId, status, bucketed, deduped: false };
  } catch (err: any) {
    return errRedis(err);
  }
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
 * `recordAnchorReflection`/`recordReflection` lost their only live caller when
 * #710 deleted the in-process planner, so the per-anchor reflection store has
 * been structurally empty — every `GET /api/reflections?anchor=` returns
 * `count:0`, and a retry of a prior-failure anchor silently loses its own
 * failure context (the #193 retry-correctness invariant). This wrapper is the
 * orchestrator-side entry point the autopilot reap path calls (via
 * `POST /api/autopilot/reflection-record`) when a dispatch terminalises on a
 * NON-MERGED outcome, so the next attempt's pull is non-empty.
 *
 * Never throws — returns an Ok/Err result object, matching the
 * merge/grounding/verification convention (CLAUDE.md) and the rest of this
 * module. A reflection-write failure is observability/learning, not
 * correctness: the reap path swallows a non-2xx and never blocks on it.
 *
 * The producer (`recordAnchorReflection`) keeps its current signature; this is
 * a thin pass-through that maps the validated body onto its opts. Idempotency
 * is the producer's existing push semantics (capped per-anchor ring) plus the
 * reap path's `reaped_task_ids` ledger keyed on `cycleId` — re-invocation for
 * the same reaped dispatch converges harmlessly.
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
// Lifecycle: dispatch -> PR link (issue #732)
// ---------------------------------------------------------------------------

export interface RecordDispatchPrBody {
  prNumber: number;
  runId?: string;
  dispatchId?: string;
  skill?: string;
  issueRef?: string;
  openedAt?: string;
}

export type RecordDispatchPrResult =
  | Ok<{ prNumber: number; openedAtMs: number }>
  | Err;

/**
 * Stamp a dispatch->PR link when a dispatched subagent opens a PR. The
 * Builder-Health Scorecard derives Autonomy Rate + time-to-merge from this
 * link (the open timestamp + PR number) joined against GitHub on read; no
 * per-dispatch intervention flag is stored. Idempotent on `prNumber`.
 */
export async function recordDispatchPr(
  body: RecordDispatchPrBody,
): Promise<RecordDispatchPrResult> {
  try {
    const prNumber = Number(body.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { ok: false, code: "invalid", detail: "prNumber must be a positive integer" };
    }
    const openedAtMs = body.openedAt ? Date.parse(body.openedAt) : Date.now();
    const resolvedMs = Number.isFinite(openedAtMs) ? openedAtMs : Date.now();
    const fields: Record<string, string> = {};
    if (body.runId) fields.runId = String(body.runId);
    if (body.dispatchId) fields.dispatchId = String(body.dispatchId);
    if (body.skill) fields.skill = String(body.skill);
    if (body.issueRef) fields.issueRef = String(body.issueRef);
    await putAutopilotPrLink(prNumber, fields, resolvedMs);
    return { ok: true, prNumber, openedAtMs: resolvedMs };
  } catch (err: any) {
    return errRedis(err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: run-start
// ---------------------------------------------------------------------------

export type RunStartResult = Ok<{ run_id: string; deduped: boolean }> | Err;

export async function startRun(body: RunStartBody): Promise<RunStartResult> {
  try {
    const runId = body.run_id.trim();
    const started = body.started || new Date().toISOString();
    const startedEpoch = numberOrDefault(body.started_epoch, Math.floor(Date.now() / 1000));
    const pid = numberOrDefault(body.pid, 0);
    const trigger =
      typeof body.trigger === "string" && body.trigger.length > 0 ? body.trigger : "manual";
    const limits = body.limits && typeof body.limits === "object" ? body.limits : {};

    // Idempotency: a row with `started` filled means run-start already fired.
    const existing = await getAutopilotRun(runId);
    if (existing && existing.started) {
      return { ok: true, run_id: runId, deduped: true };
    }

    await initAutopilotRun(runId, {
      run_id: runId,
      started,
      started_epoch: String(startedEpoch),
      status: "running",
      trigger,
      pid: String(pid),
      limits: JSON.stringify(limits),
      turns: "0",
      dispatches: "0",
      cumulative_tokens: "0",
      idle_turns: "0",
      last_heartbeat_epoch: String(startedEpoch),
    }, RUN_TTL_SECONDS);
    await addAutopilotRunToIndex(runId, startedEpoch, RUN_TTL_SECONDS);

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

export async function endRun(body: RunEndBody): Promise<RunEndResult> {
  try {
    const runId = body.run_id.trim();
    const existing = await getAutopilotRun(runId);
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
    const endedEpoch = numberOrDefault(body.ended_epoch, Math.floor(Date.now() / 1000));
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

    await updateAutopilotRunFields(runId, fields, RUN_TTL_SECONDS);

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

export async function recordTurn(body: TurnBody): Promise<RecordTurnResult> {
  try {
    const runId = body.run_id.trim();
    const turnN = body.turn_n;
    const epoch = numberOrDefault(body.epoch, Math.floor(Date.now() / 1000));

    const runRow = await getAutopilotRun(runId);
    if (!runRow || !runRow.started) {
      return { ok: false, code: "not-found", detail: `unknown run_id: ${runId}` };
    }

    if (await hasAutopilotRunTurnAt(runId, turnN)) {
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
    await addAutopilotRunTurn(runId, turnN, turnMember, RUN_TTL_SECONDS);

    // 2. Counter updates — single-field writes so slice-1 fields stay intact.
    const currentTurns = Number(runRow.turns || "0");
    if (turnN > currentTurns) {
      await setAutopilotRunField(runId, "turns", String(turnN));
    }
    if (dispatchCount > 0) {
      await incrAutopilotRunField(runId, "dispatches", dispatchCount);
    }
    await setAutopilotRunField(runId, "cumulative_tokens", String(tokensAfter));
    await setAutopilotRunField(runId, "idle_turns", String(idleTurns));
    await setAutopilotRunField(runId, "last_heartbeat_epoch", String(epoch));
    await refreshAutopilotRunTTL(runId, RUN_TTL_SECONDS);

    return { ok: true, run_id: runId, turn_n: turnN, deduped: false, dispatch_count: dispatchCount };
  } catch (err: any) {
    return errRedis(err);
  }
}

// ---------------------------------------------------------------------------
// Reader: turn-join + projections
// ---------------------------------------------------------------------------

/**
 * Read the latest `limit` turn rows for a run (descending by turn_n)
 * and attach cycle-record outcomes onto `action.type === "dispatch"`
 * actions.
 *
 * Each dispatch action may carry `cycleId` or `autopilotTurnId`. When
 * neither is present, we synthesise `<run_id>:<turn_n>:<index>` —
 * mirroring how `reap.py` / `dispatch.sh` allocate cycle IDs today.
 * Missing cycles surface as `outcome: null` (UI renders "pending").
 *
 * O(turns + dispatches) Redis round-trips via the pipelined
 * `getCycleHashesBatch`.
 */
export async function fetchTurnsWithJoins(
  runId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const raw = await listAutopilotRunTurnsDesc(runId, limit);
  if (!raw || raw.length === 0) return [];

  const turns: Array<Record<string, unknown>> = [];
  const cycleIdsToFetch: string[] = [];

  for (const member of raw) {
    let parsed: any;
    try {
      parsed = JSON.parse(member);
    } catch (err) {
      console.error(`[autopilot] failed to parse turn member: ${err}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const turnN = Number(parsed.turn_n || 0);
    const actions: any[] = Array.isArray(parsed.actions) ? parsed.actions : [];
    actions.forEach((a, idx) => {
      if (a && a.type === "dispatch") {
        const cid =
          (typeof a.cycleId === "string" && a.cycleId) ||
          (typeof a.autopilotTurnId === "string" && a.autopilotTurnId) ||
          `${runId}:${turnN}:${idx}`;
        a._cycleId = cid;
        cycleIdsToFetch.push(cid);
      }
    });
    turns.push(parsed);
  }

  const cycleMap = await getCycleHashesBatch(cycleIdsToFetch);

  for (const turn of turns) {
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    for (const a of actions) {
      if (a && a.type === "dispatch") {
        const cid = a._cycleId;
        delete a._cycleId;
        const hash = cycleMap[cid];
        if (hash) {
          a.outcome = {
            cycleId: cid,
            status: hash.status || "unknown",
            prNumber: hash.prNumber || hash.pr_number || null,
            filesChanged: hash.filesChanged || null,
            costUsd: hash.costUsd ? Number(hash.costUsd) : null,
            startedAt: hash.startedAt || null,
            completedAt: hash.completedAt || null,
          };
        } else {
          a.outcome = null;
        }
      }
    }
  }

  return turns;
}

/**
 * Compute the slice-4 cost breakdown from already-joined turn rows.
 * `orchestration_cost_usd` is always 0 — the outer
 * `claude -p /hydra-autopilot` call is subscription-billed; surfaced
 * as a separate field so the dashboard can render the
 * "(subscription)" annotation without inferring it.
 */
export function computeCostBreakdown(
  turns: Array<Record<string, unknown>>,
): {
  orchestration_cost_usd: number;
  dispatched_cost_usd: number;
  dispatch_count: number;
  dispatch_count_with_cost: number;
} {
  let dispatched = 0;
  let dispatchCount = 0;
  let withCost = 0;
  for (const turn of turns) {
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    for (const a of actions) {
      if (a && a.type === "dispatch") {
        dispatchCount += 1;
        const outcome = a.outcome;
        if (outcome && typeof outcome === "object") {
          const c = (outcome as any).costUsd;
          if (typeof c === "number" && Number.isFinite(c)) {
            dispatched += c;
            withCost += 1;
          }
        }
      }
    }
  }
  return {
    orchestration_cost_usd: 0,
    dispatched_cost_usd: Number(dispatched.toFixed(6)),
    dispatch_count: dispatchCount,
    dispatch_count_with_cost: withCost,
  };
}

/**
 * Project a raw Redis hash into the public response shape: parse JSON
 * limits, coerce numeric fields, compute elapsed_s / age_s, and on
 * `running` rows compute pid_alive + wedge_likely.
 *
 * `wedge_likely` cross-checks the OS heartbeat (#1091): the per-turn
 * `last_heartbeat_epoch` only refreshes at `recordTurn` close, so a run
 * mid-turn on slow background subagents has a stale `age_s` even while the
 * control loop is alive. We only flag a wedge when BOTH the per-turn
 * heartbeat AND the continuously-written OS heartbeat
 * (`/tmp/hydra-autopilot-heartbeat.txt`) are stale. `readOsHbAgeS` is
 * injectable for tests; the default reads the real heartbeat file and
 * fails open (unreadable → treated as stale).
 */
export function projectRunView(
  row: Record<string, string>,
  readOsHbAgeS: (nowS: number) => number | null = osHeartbeatAgeS,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const startedEpoch = Number(row.started_epoch || "0");
  const lastHb = Number(row.last_heartbeat_epoch || row.started_epoch || "0");
  const endedEpoch = row.ended_epoch ? Number(row.ended_epoch) : undefined;

  let limits: unknown = {};
  if (row.limits) {
    try {
      limits = JSON.parse(row.limits);
    } catch {
      limits = {};
    }
  }

  const status = row.status || "running";
  const elapsedS =
    endedEpoch !== undefined ? Math.max(0, endedEpoch - startedEpoch) : Math.max(0, now - startedEpoch);
  const ageS = Math.max(0, now - lastHb);

  const view: Record<string, unknown> = {
    run_id: row.run_id || "",
    started: row.started || "",
    started_epoch: startedEpoch,
    status,
    trigger: row.trigger || "manual",
    pid: Number(row.pid || "0"),
    limits,
    turns: Number(row.turns || "0"),
    dispatches: Number(row.dispatches || "0"),
    cumulative_tokens: Number(row.cumulative_tokens || "0"),
    idle_turns: Number(row.idle_turns || "0"),
    last_heartbeat_epoch: lastHb,
    elapsed_s: elapsedS,
    age_s: ageS,
  };

  if (row.term_reason) view.term_reason = row.term_reason;
  if (endedEpoch !== undefined) view.ended_epoch = endedEpoch;
  if (row.exit_code !== undefined) view.exit_code = Number(row.exit_code);
  // Issue #1079: surface the durable crash snapshot on the run-detail view +
  // retro bundle (both read through this projection). Parsed back from the
  // persisted JSON string; absent / unparseable → field omitted.
  const crashDetail = parseCrashDetail(row.crash_detail);
  if (crashDetail) view.crash_detail = crashDetail;

  if (status === "running") {
    const pid = Number(row.pid || "0");
    view.pid_alive = isPidAlive(pid);
    // #1091: only a wedge when BOTH heartbeats are stale. A fresh OS
    // heartbeat means the loop is alive even though the per-turn heartbeat
    // (refreshed only at recordTurn close) lags during a long turn.
    const perTurnStale = ageS > WEDGE_AGE_THRESHOLD_S;
    const osStale = isOsHeartbeatStale(readOsHbAgeS(now), WEDGE_AGE_THRESHOLD_S);
    view.wedge_likely = perTurnStale && osStale;
  }

  return view;
}

/**
 * Project a single run hash + its joined turns into the digest shape
 * used by the history table. One turn-fetch per run; the table needs
 * the cost total, which we get from the same joins we'd do for the
 * live page.
 */
export async function projectRunDigest(
  runId: string,
  row: Record<string, string>,
): Promise<Record<string, unknown>> {
  const turns = await fetchTurnsWithJoins(runId, RUN_TURNS_MAX_FETCH);
  const cost = computeCostBreakdown(turns);

  let merged = 0;
  let failed = 0;
  for (const turn of turns) {
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    for (const a of actions) {
      if (a && a.type === "dispatch" && a.outcome && typeof a.outcome === "object") {
        const status = String((a.outcome as any).status || "").toLowerCase();
        if (MERGED_STATUSES.has(status)) merged += 1;
        else if (FAILED_STATUSES.has(status)) failed += 1;
      }
    }
  }

  const startedEpoch = Number(row.started_epoch || "0");
  const endedEpoch = row.ended_epoch ? Number(row.ended_epoch) : null;
  const durationS =
    endedEpoch !== null && Number.isFinite(endedEpoch) && endedEpoch > startedEpoch
      ? endedEpoch - startedEpoch
      : row.status === "running"
        ? Math.max(0, Math.floor(Date.now() / 1000) - startedEpoch)
        : null;

  return {
    run_id: row.run_id || runId,
    started: row.started || "",
    started_epoch: startedEpoch,
    ended_epoch: endedEpoch,
    duration_s: durationS,
    status: row.status || "running",
    term_reason: row.term_reason || null,
    trigger: row.trigger || "manual",
    turns: Number(row.turns || "0"),
    dispatches: Number(row.dispatches || "0"),
    merged_count: merged,
    failed_count: failed,
    total_tokens: Number(row.cumulative_tokens || "0"),
    total_cost_usd: cost.dispatched_cost_usd,
    exit_code: row.exit_code !== undefined ? Number(row.exit_code) : null,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle truth (issue #888)
// ---------------------------------------------------------------------------

/**
 * Discriminated autopilot lifecycle state derived from the most-recent
 * run row. The data plane's single source of truth for "is autopilot
 * running right now" — replacing the conflation of `getStatus().running`
 * (the scheduler housekeeping heartbeat) with autopilot liveness.
 *
 *   - `running` — the latest run's status is `running` AND its recorded
 *     pid is alive. A terminal most-recent run is NEVER `running`.
 *   - `crashed` — the latest run was killed / its pid died mid-run
 *     (status `killed` or `term_reason` `crash`). The read-time sweeper
 *     in `sweepRunIfDead` promotes a dead-pid running row into this
 *     shape, so a stale `running` row with a dead pid also lands here.
 *   - `ended` — the latest run terminated cleanly (status `ended` with a
 *     non-crash `term_reason`).
 *   - `idle` — there is no run at all, OR the most-recent run is terminal
 *     in a way that is neither a clean end nor a crash (defensive
 *     fallback). The UI shows "last run ended N ago".
 */
export type AutopilotLifecycleState = "running" | "idle" | "ended" | "crashed";

export interface AutopilotLifecycle {
  state: AutopilotLifecycleState;
  /** The run this state was derived from. `null` when no run exists. */
  run_id: string | null;
  /**
   * `term_reason` of the most-recent terminal run, surfaced so the UI can
   * render "last run ended N ago (<term_reason>)". `null` while running
   * or when no terminal run exists.
   */
  term_reason: string | null;
  /**
   * Epoch (Unix seconds) the most-recent run ended. `null` while running
   * or when no terminal run exists. Lets the UI compute "N ago".
   */
  ended_epoch: number | null;
}

/**
 * Pure derivation of {@link AutopilotLifecycle} from an already-swept run
 * row. `row` is `null` when no autopilot run has ever been recorded.
 *
 * Pure — no Redis, no clock — so the route layer and tests can pin it.
 * Callers MUST pass the row AFTER `sweepRunIfDead` so a dead-pid `running`
 * row has already been promoted to `killed`/`crash`; the pid re-check
 * here is belt-and-braces for callers (e.g. raw projections) that skip
 * the sweep.
 */
export function deriveLifecycleState(
  row: Record<string, string> | null | undefined,
): AutopilotLifecycle {
  if (!row || !row.status) {
    return { state: "idle", run_id: null, term_reason: null, ended_epoch: null };
  }
  const runId = row.run_id || null;
  const status = row.status;
  const termReason = row.term_reason || null;
  const endedEpoch = row.ended_epoch ? Number(row.ended_epoch) : null;
  const resolvedEnded =
    endedEpoch !== null && Number.isFinite(endedEpoch) ? endedEpoch : null;

  if (status === "running") {
    const pid = Number(row.pid || "0");
    if (isPidAlive(pid)) {
      return { state: "running", run_id: runId, term_reason: null, ended_epoch: null };
    }
    // Dead-pid running row a sweep would have promoted — report crashed.
    return {
      state: "crashed",
      run_id: runId,
      term_reason: termReason || "crash",
      ended_epoch: resolvedEnded,
    };
  }

  if (status === "killed" || termReason === "crash") {
    return {
      state: "crashed",
      run_id: runId,
      term_reason: termReason || "crash",
      ended_epoch: resolvedEnded,
    };
  }

  if (status === "ended") {
    return {
      state: "ended",
      run_id: runId,
      term_reason: termReason,
      ended_epoch: resolvedEnded,
    };
  }

  // Any other terminal status — defensive idle fallback.
  return {
    state: "idle",
    run_id: runId,
    term_reason: termReason,
    ended_epoch: resolvedEnded,
  };
}

export type GetCurrentLifecycleResult = Ok<{ lifecycle: AutopilotLifecycle }> | Err;

/**
 * Read the most-recent run, apply the dead-pid sweeper, and derive the
 * discriminated lifecycle state. Unlike {@link getCurrentRun}, this never
 * 404s on a terminal most-recent run — it reports `idle` / `ended` /
 * `crashed` for it. When no run has ever been recorded, returns the
 * `idle` shape with `run_id: null`.
 */
export async function getCurrentLifecycle(): Promise<GetCurrentLifecycleResult> {
  try {
    const recent = await listRecentAutopilotRunIds(1);
    if (!recent || recent.length === 0) {
      return {
        ok: true,
        lifecycle: { state: "idle", run_id: null, term_reason: null, ended_epoch: null },
      };
    }
    const runId = recent[0];
    const row = await getAutopilotRun(runId);
    if (!row || !row.started) {
      return {
        ok: true,
        lifecycle: { state: "idle", run_id: null, term_reason: null, ended_epoch: null },
      };
    }
    const sweepResult = await sweepRunIfDead(runId, row);
    return { ok: true, lifecycle: deriveLifecycleState(sweepResult.row) };
  } catch (err: any) {
    return errRedis(err);
  }
}

// ---------------------------------------------------------------------------
// Reader: high-level
// ---------------------------------------------------------------------------

export type GetCurrentRunResult =
  | Ok<{ view: Record<string, unknown> }>
  | Err;

/**
 * Read the most recent run, apply the dead-pid sweeper, project, and
 * attach the latest 50 turns with cycle joins + cost breakdown. 404
 * surfaces as `{ ok: false, code: "not-found" }`.
 */
export async function getCurrentRun(): Promise<GetCurrentRunResult> {
  try {
    const recent = await listRecentAutopilotRunIds(1);
    if (!recent || recent.length === 0) {
      return { ok: false, code: "not-found", detail: "no autopilot runs recorded yet" };
    }
    const runId = recent[0];
    const row = await getAutopilotRun(runId);
    if (!row || !row.started) {
      return { ok: false, code: "not-found", detail: "no autopilot runs recorded yet" };
    }
    const sweepResult = await sweepRunIfDead(runId, row);
    const view = projectRunView(sweepResult.row);
    const turns = await fetchTurnsWithJoins(runId, 50);
    (view as any).turns = turns;
    (view as any).cost = computeCostBreakdown(turns);
    return { ok: true, view };
  } catch (err: any) {
    return errRedis(err);
  }
}

export type GetRunResult =
  | Ok<{ run: Record<string, unknown>; turns: Array<Record<string, unknown>> }>
  | Err;

/** Read one run by id with the FULL turn timeline (no 50 cap). */
export async function getRun(runId: string): Promise<GetRunResult> {
  try {
    const row = await getAutopilotRun(runId);
    if (!row || !row.started) {
      return { ok: false, code: "not-found", detail: `unknown run_id: ${runId}` };
    }
    const sweepResult = await sweepRunIfDead(runId, row);
    const view = projectRunView(sweepResult.row);
    const turns = await fetchTurnsWithJoins(runId, RUN_TURNS_MAX_FETCH);
    (view as any).cost = computeCostBreakdown(turns);
    return { ok: true, run: view, turns };
  } catch (err: any) {
    return errRedis(err);
  }
}

export type GetRunRowResult =
  | Ok<{ row: Record<string, string> }>
  | Err;

/** Read the raw run hash (for the log/journal endpoints' lookups). */
export async function getRunRow(runId: string): Promise<GetRunRowResult> {
  try {
    const row = await getAutopilotRun(runId);
    if (!row || !row.started) {
      return { ok: false, code: "not-found", detail: `unknown run_id: ${runId}` };
    }
    return { ok: true, row };
  } catch (err: any) {
    return errRedis(err);
  }
}

export type ListRunsResult = Ok<{ runs: Array<Record<string, unknown>> }> | Err;

/** List recent runs as digests for the history table. */
export async function listRuns(limit: number): Promise<ListRunsResult> {
  try {
    const runIds = await listRecentAutopilotRunIds(limit);
    if (!runIds || runIds.length === 0) return { ok: true, runs: [] };
    const digests: Array<Record<string, unknown>> = [];
    for (const runId of runIds) {
      const row = await getAutopilotRun(runId);
      if (!row || !row.started) continue;
      const sweepResult = await sweepRunIfDead(runId, row);
      const digest = await projectRunDigest(runId, sweepResult.row);
      digests.push(digest);
    }
    return { ok: true, runs: digests };
  } catch (err: any) {
    return errRedis(err);
  }
}
