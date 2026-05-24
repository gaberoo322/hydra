/**
 * Autopilot data-plane endpoints (issue #430).
 *
 * After PR-3 (#383) deleted the in-process control loop, `src/cycle.ts`'s
 * header comment declared that autopilot subagents would write their own
 * cycle records into Redis. That handoff was never built: `/api/cycle/history`,
 * `/api/metrics`, and the lifetime `hydra:scheduler:cycles-*` counters were
 * all serving frozen pre-cut-over data, because nobody was writing the
 * post-cut numbers.
 *
 * This router is the missing writer. `POST /api/autopilot/cycle-record` is
 * called from `scripts/autopilot/` once per autopilot turn that dispatched a
 * code-writing subagent (a "cycle" in the post-cut sense — one autopilot
 * turn, not the deleted codex-era control-loop cycle). It performs three
 * complementary writes:
 *
 *   1. `hydra:cycle:<id>` hash + ZADD to `hydra:cycle:index` — read by
 *      `/api/cycle/history`.
 *   2. `recordCycleMetrics(cycleId, { source: "claude", ... })` — populates
 *      `hydra:metrics:<id>` (read by `/api/metrics`) and the metrics ZSET
 *      that `/api/scheduler/status.mergeRateWindow` reasons over.
 *   3. Lifetime counter increments on `hydra:scheduler:cycles-{run,merged,
 *      failed}` so the lifetime merge-rate stops being a codex-era fossil.
 *
 * The route is idempotent on `cycleId`: if the cycle hash already exists,
 * the second call is a no-op (no double counting on Phase 2 / Phase 6 retry).
 * Callers key by a stable identifier — autopilot turn ID or worktree branch
 * name — so retries collapse cleanly.
 */

import { Router } from "express";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { redisKeys } from "../redis-keys.ts";
import {
  hashSet,
  hashGetAll,
  hashSetField,
  hashIncrBy,
  zAdd,
  zRevRange,
  expireKey,
  incrSchedulerCyclesRun,
  incrSchedulerCyclesMerged,
  incrSchedulerCyclesFailed,
} from "../redis-adapter.ts";
import { getRedisConnection } from "../redis/connection.ts";
import { recordCycleMetrics } from "../metrics/record.ts";

// -----------------------------------------------------------------------------
// Slice 3 (issue #499) — log-tail + journal endpoints.
//
// File paths are env-overridable so tests can point at temp files without
// touching /tmp. Production code never sets these envs.
// -----------------------------------------------------------------------------
const AUTOPILOT_LOG_PATH = process.env.HYDRA_AUTOPILOT_LOG || "/tmp/hydra-autopilot-nightly.log";
const AUTOPILOT_LOG_PREV_PATH = process.env.HYDRA_AUTOPILOT_LOG_PREV || `${AUTOPILOT_LOG_PATH}.prev`;
const AUTOPILOT_STATE_PATH = process.env.HYDRA_AUTOPILOT_STATE || "/tmp/hydra-autopilot-state.json";

const LOG_TAIL_DEFAULT = 50;
const LOG_TAIL_MAX = 2000;
// .prev mtime vs run.started_epoch tolerance — bootstrap.sh runs `mv` after
// it computes STARTED_EPOCH so the mtime is typically within seconds of the
// previous run's end (which is approximately the current run's start). 5
// minutes is generous enough to cover slow disks and clock skew without
// matching a much older rotated file.
const LOG_PREV_MTIME_TOLERANCE_S = 300;

// journalctl arg cap — output size cap and timeout (issue #499 AC: 1MB, 10s).
// Env override exists ONLY so the regression test for the timeout path can
// drive a sub-second budget instead of forcing CI to wait 10s per run. The
// production playbook never sets HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS — and
// the surrounding doc explicitly pins the contract at 10s.
const JOURNAL_MAX_BYTES = 1024 * 1024;
const JOURNAL_TIMEOUT_MS = Number(process.env.HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS || "10000");
const JOURNAL_UNIT = process.env.HYDRA_AUTOPILOT_JOURNAL_UNIT || "hydra-autopilot.service";
// Test override — when set, the journal endpoint shells out to this command
// instead of journalctl. Used by autopilot-logs.test.mts to assert the argv
// shape and timeout/cap behaviour without requiring journalctl on the test
// host. Production never sets this.
const JOURNAL_CMD_OVERRIDE = process.env.HYDRA_AUTOPILOT_JOURNAL_CMD;

const CYCLE_TTL_SECONDS = 7 * 24 * 3600; // 7 days — matches /cycle/register
const RUN_TTL_SECONDS = 7 * 24 * 3600; // 7 days — autopilot run rows
// Slice-4 (issue #500) — soft cap on the number of turns the detail
// endpoint / history-row digest will fetch per run. Slice-1 imposes a 7d
// TTL on the turns ZSET, and token-budget limits keep autopilot runs well
// under a few hundred turns; 10k is two orders of magnitude above that
// ceiling so the cap only ever bites pathological data. Keeps the LIMIT
// arg within Redis's 64-bit signed-int comfort zone.
const RUN_TURNS_MAX_FETCH = 10000;

// Wedge-detection threshold (issue #497). Read-only metadata in GET response;
// no Redis write. 10 minutes matches the operator-playbook expectation that a
// healthy autopilot turn completes well under that, and pre-#435 wedges hung
// for 30m+ before anyone noticed.
const WEDGE_AGE_THRESHOLD_S = 600;

// Allowed term_reason values from term-check.py. Anything else is normalized
// to "unknown" so a typo in the writer can't break the read-back surface.
const VALID_TERM_REASONS = new Set([
  "budget",
  "wall_clock",
  "idle",
  "failure_backstop",
  "crash",
]);

// Status values that count toward `cycles-merged` (vs `cycles-failed`).
// Aligned with the autopilot taxonomy: a "cycle" merged when the dispatched
// subagent landed a PR; failed when it abandoned, timed out, or its PR
// closed unmerged.
const MERGED_STATUSES = new Set(["merged", "completed", "succeeded"]);
const FAILED_STATUSES = new Set(["failed", "abandoned", "aborted", "timeout", "timed-out"]);

interface CycleRecordBody {
  cycleId?: string;
  status?: string;
  source?: string;
  startedAt?: string;
  completedAt?: string;
  // Task accounting — used by cycle-history readers and metric trend.
  total?: number;
  completed?: number;
  failed?: number;
  abandoned?: number;
  // Metric payload (forwarded to recordCycleMetrics). Optional fields the
  // autopilot can fill in if known; absent fields default sensibly.
  anchorType?: string;
  anchorReference?: string;
  taskTitle?: string;
  tasksAttempted?: number;
  tasksMerged?: number;
  tasksFailed?: number;
  tasksAbandoned?: number;
  prNumber?: number | string;
  totalDurationMs?: number;
  costUsd?: number;
  abandonReason?: string;
  regressionIntroduced?: boolean;
  // Tags carried for free into the metric hash so dashboards can filter on
  // them later (e.g. autopilot turn ID, worktree branch).
  autopilotTurnId?: string;
  worktreeBranch?: string;
}

export function createAutopilotRouter() {
  const router = Router();

  // POST /autopilot/cycle-record — autopilot Phase 6 calls this once per
  // code-writing subagent dispatch outcome.
  //
  // Returns { ok, cycleId, status, deduped } where deduped=true means the
  // record already existed and no counters were touched.
  router.post("/autopilot/cycle-record", async (req, res) => {
    try {
      const body = (req.body || {}) as CycleRecordBody;
      const cycleId = typeof body.cycleId === "string" ? body.cycleId.trim() : "";
      if (!cycleId) {
        return res.status(400).json({ error: "Missing cycleId" });
      }

      const status = typeof body.status === "string" && body.status.length > 0
        ? body.status
        : "completed";

      // Idempotency: if the cycle hash already exists with a status, the
      // record was filed by an earlier Phase 6 call — skip all writes.
      // (Avoids double-counting on autopilot retries; see issue #430 impl
      // notes about keying by autopilot turn ID / worktree branch.)
      const existing = await hashGetAll(redisKeys.cycle(cycleId));
      if (existing && existing.status) {
        return res.json({ ok: true, cycleId, status: existing.status, deduped: true });
      }

      const source = typeof body.source === "string" && body.source.length > 0
        ? body.source
        : "claude";
      const startedAt = body.startedAt || new Date().toISOString();
      const completedAt = body.completedAt || new Date().toISOString();

      // Task counters: prefer explicit completed/failed/abandoned; fall
      // back to the metric-shape names (tasksMerged/tasksFailed/...) so
      // callers can use either vocabulary.
      const total = numberOrDefault(body.total, 1);
      const completed = numberOrDefault(body.completed ?? body.tasksMerged, 0);
      const failed = numberOrDefault(body.failed ?? body.tasksFailed, 0);
      const abandoned = numberOrDefault(body.abandoned ?? body.tasksAbandoned, 0);

      // 1. Per-cycle hash + cycle index. The hash is what `/api/cycle/history`
      //    surfaces today (via a KEYS scan in `src/cycle.ts`); the ZSET is
      //    the forward-compat index callers can paginate against.
      await hashSet(
        redisKeys.cycle(cycleId),
        "status", status,
        "startedAt", startedAt,
        "completedAt", completedAt,
        "source", source,
        "total", String(total),
        "completed", String(completed),
        "failed", String(failed),
        "abandoned", String(abandoned),
      );
      await expireKey(redisKeys.cycle(cycleId), CYCLE_TTL_SECONDS);
      await zAdd(redisKeys.cycleIndex(), Date.now(), cycleId);

      // 2. Per-cycle metric — feeds `/api/metrics` and the rolling
      //    mergeRateWindow in /scheduler/status.
      //
      // We forward only the fields the autopilot knows about; recordCycleMetrics
      // will derive qualityGateCoverage etc. on its own and stringify the rest.
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
        // costUsd — pass through if the autopilot has a surrogate; if absent,
        // recordCycleMetrics will try to compute from agent-runs (which the
        // autopilot doesn't log today, so it'll resolve to 0). #394 owns
        // the surrogate semantics; here we only forward what we're given.
        costUsd: typeof body.costUsd === "number" ? body.costUsd : undefined,
      };
      // Strip undefined fields so recordCycleMetrics's deriveQualityGateCoverage
      // doesn't see literal "undefined" strings.
      for (const k of Object.keys(metrics)) {
        if (metrics[k] === undefined) delete metrics[k];
      }
      await recordCycleMetrics(cycleId, metrics);

      // 3. Lifetime counters. cycles-run increments unconditionally so the
      //    rate denominator reflects every dispatched cycle, not just the
      //    merges. cycles-merged / cycles-failed are mutually exclusive by
      //    status bucket.
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

      return res.json({ ok: true, cycleId, status, bucketed, deduped: false });
    } catch (err: any) {
      console.error(`[autopilot] cycle-record failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /autopilot/run-start (issue #497) — bootstrap.sh end-of-Phase-0.
  //
  // Idempotent on run_id: a second POST with the same id is a no-op (the
  // bootstrap can fire twice in some recovery paths; we don't want to clobber
  // the just-started run row or reset counters).
  // -------------------------------------------------------------------------
  router.post("/autopilot/run-start", async (req, res) => {
    try {
      const body = (req.body || {}) as RunStartBody;
      const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
      if (!runId) {
        return res.status(400).json({ error: "Missing run_id" });
      }
      const started = typeof body.started === "string" ? body.started : new Date().toISOString();
      const startedEpoch =
        typeof body.started_epoch === "number" && Number.isFinite(body.started_epoch)
          ? body.started_epoch
          : Math.floor(Date.now() / 1000);
      const pid = numberOrDefault(body.pid, 0);
      const trigger = typeof body.trigger === "string" && body.trigger.length > 0
        ? body.trigger
        : "manual";
      const limits = body.limits && typeof body.limits === "object" ? body.limits : {};

      // Idempotency — if run row exists and is `running` (or any status with
      // a populated `started` field), skip the write. Re-POST is a no-op.
      const existing = await hashGetAll(redisKeys.autopilotRun(runId));
      if (existing && existing.started) {
        return res.json({ ok: true, run_id: runId, deduped: true });
      }

      await hashSet(
        redisKeys.autopilotRun(runId),
        "run_id", runId,
        "started", started,
        "started_epoch", String(startedEpoch),
        "status", "running",
        "trigger", trigger,
        "pid", String(pid),
        "limits", JSON.stringify(limits),
        "turns", "0",
        "dispatches", "0",
        "cumulative_tokens", "0",
        "idle_turns", "0",
        "last_heartbeat_epoch", String(startedEpoch),
      );
      await expireKey(redisKeys.autopilotRun(runId), RUN_TTL_SECONDS);
      await zAdd(redisKeys.autopilotRunsIndex(), startedEpoch, runId);
      // Index doesn't natively TTL — refresh expiry so the ZSET tracks the
      // 7d retention of the underlying hashes.
      await expireKey(redisKeys.autopilotRunsIndex(), RUN_TTL_SECONDS);

      return res.json({ ok: true, run_id: runId, deduped: false });
    } catch (err: any) {
      console.error(`[autopilot] run-start failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /autopilot/run-end (issue #497) — term-check.py when it returns a
  // `terminate` action. Transitions `running → ended` with the term_reason
  // from the body's `cause`.
  //
  // Idempotent on run_id: re-posting an end on a row that's already `ended`
  // or `killed` is a no-op (we keep the first end's term_reason — that's the
  // truthful one; a duplicate end-post usually means term-check.py was retried
  // by the playbook). A `running` row is transitioned; a missing row is a 404.
  // -------------------------------------------------------------------------
  router.post("/autopilot/run-end", async (req, res) => {
    try {
      const body = (req.body || {}) as RunEndBody;
      const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
      if (!runId) {
        return res.status(400).json({ error: "Missing run_id" });
      }

      const existing = await hashGetAll(redisKeys.autopilotRun(runId));
      if (!existing || !existing.started) {
        return res.status(404).json({ error: `unknown run_id: ${runId}` });
      }

      // Idempotency: already terminal → no-op.
      if (existing.status && existing.status !== "running") {
        return res.json({ ok: true, run_id: runId, deduped: true, status: existing.status });
      }

      const cause = typeof body.cause === "string" ? body.cause : "";
      const termReason = VALID_TERM_REASONS.has(cause) ? cause : "unknown";
      const endedEpoch = numberOrDefault(
        body.ended_epoch,
        Math.floor(Date.now() / 1000),
      );
      const exitCode = body.exit_code !== undefined ? numberOrDefault(body.exit_code, 0) : 0;

      await hashSet(
        redisKeys.autopilotRun(runId),
        "status", "ended",
        "term_reason", termReason,
        "ended_epoch", String(endedEpoch),
        "exit_code", String(exitCode),
      );
      await expireKey(redisKeys.autopilotRun(runId), RUN_TTL_SECONDS);

      return res.json({
        ok: true,
        run_id: runId,
        status: "ended",
        term_reason: termReason,
        deduped: false,
      });
    } catch (err: any) {
      console.error(`[autopilot] run-end failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /autopilot/turn (issue #498, slice 2) — heartbeat.py posts one
  // immutable turn record per decision turn.
  //
  // Body shape:
  //   {
  //     run_id, turn_n, epoch,
  //     actions: [{type, ...payload}],         // from plan.json
  //     reasons: [string],                      // from plan.json
  //     slots_snapshot: {dev_orch, qa_orch, ...} // from state.json
  //     signals_snapshot: {health: epoch, ...}  // from state.json
  //     tokens_after: int,                      // state.cumulative_tokens
  //     idle_turns: int,                        // state.idle_turns
  //   }
  //
  // Writes:
  //   1. JSON member to `hydra:autopilot:run:<id>:turns` ZSET with score=turn_n.
  //   2. Atomic counter update on the run hash:
  //        turns = MAX(turns, turn_n)                  (monotonic per slice 1 promise)
  //        dispatches += count(action.type=="dispatch") (HINCRBY — race-safe)
  //        cumulative_tokens = tokens_after            (snapshot, not accumulated)
  //        idle_turns = idle_turns                     (snapshot from state)
  //        last_heartbeat_epoch = epoch                (so the wedge-detector sees liveness)
  //
  // Idempotency: re-POST at the same (run_id, turn_n) is a no-op. We detect
  // it via ZRANGEBYSCORE turn_n turn_n on the turns ZSET — if a member already
  // exists at that score, the turn was already recorded. NO counters get
  // touched on the dup path.
  //
  // Returns 404 if the run hash doesn't exist yet (out-of-order writes from
  // a stale playbook hitting a fresh run_id are user error, not a silent
  // overwrite).
  // -------------------------------------------------------------------------
  router.post("/autopilot/turn", async (req, res) => {
    try {
      const body = (req.body || {}) as TurnBody;
      const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
      if (!runId) {
        return res.status(400).json({ error: "Missing run_id" });
      }
      const turnN = numberOrDefault(body.turn_n, NaN);
      if (!Number.isFinite(turnN) || turnN < 0) {
        return res.status(400).json({ error: "Missing or invalid turn_n" });
      }
      const epoch = numberOrDefault(body.epoch, Math.floor(Date.now() / 1000));

      const runRow = await hashGetAll(redisKeys.autopilotRun(runId));
      if (!runRow || !runRow.started) {
        return res.status(404).json({ error: `unknown run_id: ${runId}` });
      }

      // Idempotency check — has this (run_id, turn_n) already been written?
      const r = getRedisConnection();
      const existingAtScore: string[] = await r.zrangebyscore(
        redisKeys.autopilotRunTurns(runId),
        turnN,
        turnN,
      );
      if (existingAtScore && existingAtScore.length > 0) {
        return res.json({ ok: true, run_id: runId, turn_n: turnN, deduped: true });
      }

      const actions = Array.isArray(body.actions) ? body.actions : [];
      const reasons = Array.isArray(body.reasons) ? body.reasons : [];
      const slotsSnapshot = body.slots_snapshot && typeof body.slots_snapshot === "object"
        ? body.slots_snapshot
        : {};
      const signalsSnapshot = body.signals_snapshot && typeof body.signals_snapshot === "object"
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

      // 1. Append the immutable turn row.
      await zAdd(redisKeys.autopilotRunTurns(runId), turnN, turnMember);
      await expireKey(redisKeys.autopilotRunTurns(runId), RUN_TTL_SECONDS);

      // 2. Counter updates — single-field writes so we don't clobber slice-1
      //    fields (PR #522 design promise). HINCRBY for additive counters.
      const currentTurns = Number(runRow.turns || "0");
      if (turnN > currentTurns) {
        await hashSetField(redisKeys.autopilotRun(runId), "turns", String(turnN));
      }
      if (dispatchCount > 0) {
        await hashIncrBy(redisKeys.autopilotRun(runId), "dispatches", dispatchCount);
      }
      await hashSetField(
        redisKeys.autopilotRun(runId),
        "cumulative_tokens",
        String(tokensAfter),
      );
      await hashSetField(redisKeys.autopilotRun(runId), "idle_turns", String(idleTurns));
      await hashSetField(
        redisKeys.autopilotRun(runId),
        "last_heartbeat_epoch",
        String(epoch),
      );
      await expireKey(redisKeys.autopilotRun(runId), RUN_TTL_SECONDS);

      return res.json({
        ok: true,
        run_id: runId,
        turn_n: turnN,
        deduped: false,
        dispatch_count: dispatchCount,
      });
    } catch (err: any) {
      console.error(`[autopilot] turn write failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs (issue #500, slice 4) — history table on /autopilot.
  //
  // Returns the most-recent N runs (default 14) from `hydra:autopilot:runs:index`
  // (ZSET, score desc by started_epoch). Each entry is a DIGEST row containing
  // the fields the history table renders + the cost-breakdown totals computed
  // from cycle joins.
  //
  // Slice-3 AC12 pattern: this endpoint is read-only relative to Redis EXCEPT
  // for the inherited slice-1 read-time sweeper, which promotes `running →
  // killed/crash` on rows whose pid is dead. That promotion is idempotent and
  // pre-existed; no NEW writes are introduced by slice 4. No new top-level
  // fields on `hydra:autopilot:run:<id>` (slice-2 AC10 schema closure holds).
  //
  // Query params:
  //   ?limit=N — clamped to [1, 50], default 14 per issue body.
  //
  // Response shape:
  //   { runs: [ digest, ... ] }
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs", async (req, res) => {
    try {
      const limitRaw = req.query.limit;
      const limit = clampInt(
        limitRaw === undefined ? 14 : Number(limitRaw),
        1,
        50,
        14,
      );

      // ZREVRANGE 0 limit-1 → most recent N by started_epoch score.
      const runIds = await zRevRange(redisKeys.autopilotRunsIndex(), 0, limit - 1);
      if (!runIds || runIds.length === 0) {
        return res.json({ runs: [] });
      }

      const digests: Array<Record<string, unknown>> = [];
      for (const runId of runIds) {
        const row = await hashGetAll(redisKeys.autopilotRun(runId));
        if (!row || !row.started) continue; // index ahead of hash (TTL race)
        // Apply the same read-time sweeper used on /runs/current — dead-pid
        // `running` rows in history must show as killed/crash, not running.
        const sweepResult = await sweepRunIfDead(runId, row);
        const digest = await projectRunDigest(runId, sweepResult.row);
        digests.push(digest);
      }

      return res.json({ runs: digests });
    } catch (err: any) {
      console.error(`[autopilot] runs list failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/current (issue #497) — header strip on /autopilot.
  //
  // Returns the most recent run by started_epoch. On `running` rows, applies
  // the read-time sweeper: if the pid is dead, promote `running → killed`
  // with `term_reason: "crash"` and write back. Idempotent — `running → *`
  // is the only direction.
  //
  // Response shape:
  //   {
  //     run_id, started, started_epoch, status, term_reason?, trigger,
  //     pid, exit_code?, limits (parsed JSON),
  //     turns, dispatches, cumulative_tokens, idle_turns,
  //     last_heartbeat_epoch, ended_epoch?,
  //     // computed:
  //     elapsed_s, age_s, pid_alive (only when running), wedge_likely (only when running)
  //   }
  //
  // 404 if no runs exist (first-deploy backfill case — bootstrap.sh fires on
  // next autopilot start).
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/current", async (_req, res) => {
    try {
      // ZREVRANGE 0 0 → most recent by started_epoch score.
      const recent = await zRevRange(redisKeys.autopilotRunsIndex(), 0, 0);
      if (!recent || recent.length === 0) {
        return res.status(404).json({ error: "no autopilot runs recorded yet" });
      }
      const runId = recent[0];
      const row = await hashGetAll(redisKeys.autopilotRun(runId));
      if (!row || !row.started) {
        // Index ahead of the hash (TTL race) — treat as none.
        return res.status(404).json({ error: "no autopilot runs recorded yet" });
      }

      const sweepResult = await sweepRunIfDead(runId, row);
      const view = projectRunView(sweepResult.row);

      // Slice 2 (issue #498) — attach the most recent turn rows (descending
      // by turn_n) with cycle-record joins for dispatch actions. Slice 1
      // clients ignore unknown fields, so this is additive and safe.
      const turns = await fetchTurnsWithJoins(runId, 50);
      (view as any).turns = turns;

      // Slice 4 (issue #500) — attach cost breakdown computed from the
      // dispatch cycles in this run. Sourced from the SAME turns we just
      // fetched (zero extra Redis hits beyond the slice-2 fetch). Schema-
      // closure-safe: returned only on the response view, never written to
      // the run hash.
      const cost = computeCostBreakdown(turns);
      (view as any).cost = cost;

      return res.json(view);
    } catch (err: any) {
      console.error(`[autopilot] runs/current failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId/log?tail=N (issue #499, slice 3) — "Why did
  // that crash?" log tail. Resolves which of the two log files to serve:
  //
  //   - If runId is the CURRENT run (per state.json `run_id`), serve
  //     `/tmp/hydra-autopilot-nightly.log` (live, being appended to).
  //   - Else if runId is the IMMEDIATELY PRIOR run and `.log.prev` exists
  //     with an mtime within tolerance of run.started_epoch, serve
  //     `.log.prev` (frozen at rotation).
  //   - Else 404 ("log no longer available — rotated").
  //
  // The selection rule is deliberately strict: the bootstrap only keeps two
  // files, so older runs can never have their log surfaced via this
  // endpoint. The `/journal` companion fills that gap.
  //
  // Auth surface: runId is validated against the Redis runs index (must
  // exist). `tail` is bounded to [1, LOG_TAIL_MAX]. No file path leaves the
  // server (we don't echo the resolved path; the response is plain text).
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/log", async (req, res) => {
    try {
      const runId = String(req.params.runId || "").trim();
      if (!runId) {
        return res.status(400).json({ error: "Missing runId" });
      }
      // Validate runId exists in the runs index — rejects unknown ids
      // (prevents probing for arbitrary state files via crafted runIds).
      const row = await hashGetAll(redisKeys.autopilotRun(runId));
      if (!row || !row.started) {
        return res.status(404).json({ error: `unknown run_id: ${runId}` });
      }

      const tailRaw = req.query.tail;
      const tailParsed = tailRaw === undefined ? LOG_TAIL_DEFAULT : Number(tailRaw);
      if (!Number.isInteger(tailParsed) || tailParsed < 1 || tailParsed > LOG_TAIL_MAX) {
        return res.status(400).json({
          error: `invalid tail: must be integer in [1, ${LOG_TAIL_MAX}]`,
        });
      }

      const resolution = await resolveLogFileForRun(runId, row);
      if (!resolution) {
        return res.status(404).json({
          error: "log no longer available — rotated",
        });
      }

      // Read the file and tail it in-memory. We CAP the read at a reasonable
      // upper bound — the nightly log is overwritten on each bootstrap so
      // it's typically <10MB; we still defensively read at most the last
      // 16MB to avoid pathological RAM use if the file grows huge.
      const contents = await readLastBytes(resolution.path, 16 * 1024 * 1024);
      const lines = contents.split(/\r?\n/);
      // Drop a trailing empty line caused by terminal newline; preserve real
      // blank lines mid-file.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const tailed = lines.slice(-tailParsed).join("\n");

      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-autopilot-log-source", resolution.source);
      return res.status(200).send(tailed);
    } catch (err: any) {
      console.error(`[autopilot] runs/:runId/log failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId/journal (issue #499, slice 3) — systemd
  // journal slice for the run's time window. Shells out to:
  //
  //   journalctl --user -u <unit> --since <iso> --until <iso>
  //              --no-pager --output=short-iso
  //
  // SECURITY: argv array (no shell), all interpolated values come from the
  // Redis run hash (never the request). `--since`/`--until` are ISO-8601
  // strings the server itself wrote at run-start; they cannot be influenced
  // by an attacker. Output capped at JOURNAL_MAX_BYTES, killed at
  // JOURNAL_TIMEOUT_MS.
  //
  // One-shot: no polling. If a longer window is needed, the operator can
  // still ssh in and run journalctl directly — this endpoint is the cheap
  // dashboard-friendly default.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/journal", async (req, res) => {
    try {
      const runId = String(req.params.runId || "").trim();
      if (!runId) {
        return res.status(400).json({ error: "Missing runId" });
      }
      const row = await hashGetAll(redisKeys.autopilotRun(runId));
      if (!row || !row.started) {
        return res.status(404).json({ error: `unknown run_id: ${runId}` });
      }

      const since = sanitizeIso(row.started);
      if (!since) {
        return res.status(500).json({
          error: "run hash missing valid started timestamp",
        });
      }
      // `--until` defaults to now for live runs; for ended/killed rows use
      // the recorded ended_epoch (converted to ISO). We only ever derive
      // these from server-side fields, never the request.
      const untilIso = computeUntilIso(row);

      const result = await runJournalctl(JOURNAL_UNIT, since, untilIso);

      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-autopilot-journal-unit", JOURNAL_UNIT);
      if (result.truncated) res.setHeader("x-autopilot-journal-truncated", "true");
      if (result.timedOut) res.setHeader("x-autopilot-journal-timed-out", "true");
      return res.status(200).send(result.text);
    } catch (err: any) {
      console.error(`[autopilot] runs/:runId/journal failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId (issue #500, slice 4) — full detail for a
  // single (historical or live) run. Powers the /autopilot/:runId page.
  //
  // Body shape:
  //   {
  //     run:   { ...projectRunView fields..., cost: { ... } },
  //     turns: [ ...ALL turns (no 50 cap), with cycle joins... ]
  //   }
  //
  // Slice-3 AC12 read-only-relative-to-Redis pattern: no writes EXCEPT the
  // inherited slice-1 sweep promotion. 404 on unknown runId.
  //
  // Note `/runs/current` has a 50-turn cap; this endpoint deliberately omits
  // that cap because the detail page needs the full timeline (issue body:
  // "Turn timeline still expandable, but shows all turns").
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId", async (req, res) => {
    try {
      const runId = String(req.params.runId || "").trim();
      if (!runId) {
        return res.status(400).json({ error: "Missing runId" });
      }
      // Guard: `current` is a sibling path, not a runId. Express has already
      // routed `/runs/current` to the more-specific handler above, so this
      // defensive check only catches truly malformed inputs.
      if (runId === "current") {
        return res.status(400).json({ error: "use GET /autopilot/runs/current" });
      }

      const row = await hashGetAll(redisKeys.autopilotRun(runId));
      if (!row || !row.started) {
        return res.status(404).json({ error: `unknown run_id: ${runId}` });
      }

      const sweepResult = await sweepRunIfDead(runId, row);
      const view = projectRunView(sweepResult.row);

      // No 50-cap: pass RUN_TURNS_MAX_FETCH so the helper's ZREVRANGEBYSCORE
      // returns every turn for this run. Run TTL is 7d, so the worst case is
      // a few thousand rows — well within a single Redis RTT.
      const turns = await fetchTurnsWithJoins(runId, RUN_TURNS_MAX_FETCH);
      const cost = computeCostBreakdown(turns);
      (view as any).cost = cost;

      return res.json({ run: view, turns });
    } catch (err: any) {
      console.error(`[autopilot] runs/:runId failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

// -----------------------------------------------------------------------------
// Slice 3 helpers — exported for direct unit testing.
// -----------------------------------------------------------------------------

/**
 * Look up the current run_id from /tmp/hydra-autopilot-state.json. Returns
 * null if the file is missing or unparseable — both are normal pre-first-run
 * states and the caller treats them as "no live run".
 */
export async function readCurrentRunIdFromState(): Promise<string | null> {
  try {
    const raw = await readFile(AUTOPILOT_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const rid = parsed && typeof parsed.run_id === "string" ? parsed.run_id.trim() : "";
    return rid || null;
  } catch {
    return null;
  }
}

/**
 * Decide which log file (if any) serves the request for `runId`.
 *
 * Returns `{ path, source: "live" | "prev" }` or `null` if the log is no
 * longer available (rotated past the .prev window, or never existed for
 * this run).
 *
 * The rule (see issue #499 body):
 *   - runId == state.json.run_id  →  AUTOPILOT_LOG_PATH (live)
 *   - else, IF AUTOPILOT_LOG_PREV_PATH exists AND its mtime is within
 *     LOG_PREV_MTIME_TOLERANCE_S of row.started_epoch, serve .prev.
 *   - else null.
 */
export async function resolveLogFileForRun(
  runId: string,
  row: Record<string, string>,
): Promise<{ path: string; source: "live" | "prev" } | null> {
  const currentRunId = await readCurrentRunIdFromState();
  if (currentRunId && currentRunId === runId) {
    // Confirm the live file actually exists; if bootstrap.sh hasn't run yet
    // we 404 rather than 500 on an empty open.
    try {
      await stat(AUTOPILOT_LOG_PATH);
      return { path: AUTOPILOT_LOG_PATH, source: "live" };
    } catch {
      return null;
    }
  }

  // .prev — only serve if mtime is plausibly the rotation that PRECEDED this
  // run. bootstrap.sh runs the rotation `mv` just before the new run starts,
  // so the prev file's mtime is ~= row.started_epoch.
  let prevStat;
  try {
    prevStat = await stat(AUTOPILOT_LOG_PREV_PATH);
  } catch {
    return null;
  }
  const startedEpoch = Number(row.started_epoch || "0");
  if (!Number.isFinite(startedEpoch) || startedEpoch <= 0) return null;
  const mtimeEpoch = Math.floor(prevStat.mtimeMs / 1000);
  if (Math.abs(mtimeEpoch - startedEpoch) > LOG_PREV_MTIME_TOLERANCE_S) {
    return null;
  }
  return { path: AUTOPILOT_LOG_PREV_PATH, source: "prev" };
}

/**
 * Read up to the last `maxBytes` of a file as a UTF-8 string. For our use
 * case (log files <16MB) this comfortably fits in memory; for anything
 * larger we read only the trailing window.
 *
 * Returns an empty string for empty/missing files (the caller has already
 * stat'd to confirm existence).
 */
async function readLastBytes(path: string, maxBytes: number): Promise<string> {
  const st = await stat(path);
  if (st.size === 0) return "";
  if (st.size <= maxBytes) {
    return readFile(path, "utf-8");
  }
  // For huge files, read only the trailing maxBytes.
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, st.size - maxBytes);
    return buf.toString("utf-8");
  } finally {
    await fh.close();
  }
}

/**
 * Validate that a string looks like an ISO-8601 timestamp the kernel
 * journal will accept. Returns the original string when valid; null
 * otherwise. We are intentionally strict: this guards against a malformed
 * Redis row being passed straight into argv.
 */
export function sanitizeIso(s: string | undefined | null): string | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  // Accept either Z or numeric offset; reject anything with whitespace or
  // shell-meaningful characters even though we're using argv (defense in
  // depth — and journalctl rejects junk anyway).
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Compute the `--until` value for a journal query. For ended/killed runs
 * with a recorded ended_epoch, returns that as ISO. Otherwise returns the
 * current time as ISO (live run window).
 */
export function computeUntilIso(row: Record<string, string>): string {
  const endedEpoch = Number(row.ended_epoch || "0");
  if (Number.isFinite(endedEpoch) && endedEpoch > 0) {
    return new Date(endedEpoch * 1000).toISOString();
  }
  return new Date().toISOString();
}

interface JournalResult {
  text: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Spawn `journalctl --user -u <unit> --since <iso> --until <iso> --no-pager
 * --output=short-iso`. Output capped at JOURNAL_MAX_BYTES; over-cap reads
 * SIGTERM the child and append a truncation marker. Timeout SIGTERMs after
 * JOURNAL_TIMEOUT_MS.
 *
 * Exported so the test can drive it with a mocked binary via
 * HYDRA_AUTOPILOT_JOURNAL_CMD.
 */
export function runJournalctl(
  unit: string,
  sinceIso: string,
  untilIso: string,
): Promise<JournalResult> {
  return new Promise<JournalResult>((resolve) => {
    const cmd = JOURNAL_CMD_OVERRIDE || "journalctl";
    const args = JOURNAL_CMD_OVERRIDE
      ? [unit, sinceIso, untilIso]
      : [
          "--user",
          "-u", unit,
          "--since", sinceIso,
          "--until", untilIso,
          "--no-pager",
          "--output=short-iso",
        ];

    let child;
    try {
      // shell:false is the default for spawn; we re-state it via the absence
      // of the `shell` option. Argv array, no interpolation.
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      resolve({
        text: `[autopilot] journalctl spawn failed: ${err?.message || err}\n`,
        truncated: false,
        timedOut: false,
      });
      return;
    }

    let buf = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = buf.toString("utf-8");
      if (extra) text += extra;
      resolve({ text, truncated, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* intentional: best-effort kill */ }
      finish(
        `\n[autopilot] --- journalctl timed out after ${JOURNAL_TIMEOUT_MS}ms ---\n`,
      );
    }, JOURNAL_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = JOURNAL_MAX_BYTES - buf.length;
      if (remaining <= 0) {
        truncated = true;
        try { child.kill("SIGTERM"); } catch { /* intentional: best-effort */ }
        finish(`\n[autopilot] --- output truncated at ${JOURNAL_MAX_BYTES} bytes ---\n`);
        return;
      }
      const take = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      buf = Buffer.concat([buf, take]);
      if (chunk.length > remaining) {
        truncated = true;
        try { child.kill("SIGTERM"); } catch { /* intentional: best-effort */ }
        finish(`\n[autopilot] --- output truncated at ${JOURNAL_MAX_BYTES} bytes ---\n`);
      }
    });

    child.stderr?.on("data", () => {
      // intentional: discard stderr — journalctl prints "No entries" etc.
      // which is information leakage we don't want in a UI panel. The
      // exit code surfaces real failures.
    });

    child.on("error", (err: any) => {
      finish(`\n[autopilot] journalctl error: ${err?.message || err}\n`);
    });

    child.on("close", () => {
      finish();
    });
  });
}

interface RunStartBody {
  run_id?: string;
  started?: string;
  started_epoch?: number;
  pid?: number;
  trigger?: string;
  limits?: Record<string, unknown>;
}

interface RunEndBody {
  run_id?: string;
  cause?: string;
  ended_epoch?: number;
  exit_code?: number;
}

interface TurnAction {
  type?: string;
  [key: string]: unknown;
}

interface TurnBody {
  run_id?: string;
  turn_n?: number;
  epoch?: number;
  actions?: TurnAction[];
  reasons?: string[];
  slots_snapshot?: Record<string, unknown>;
  signals_snapshot?: Record<string, unknown>;
  tokens_after?: number;
  idle_turns?: number;
}

/**
 * Read the latest `limit` turn rows for a run (descending by turn_n) and
 * attach cycle-record outcomes onto `action.type=="dispatch"` actions.
 *
 * The join key: each dispatch action in a turn may carry an
 * `autopilotTurnId` (the canonical join key from issue #430) or a derived
 * `cycleId`. We default cycleId to `<run_id>:<turn_n>:<index>` when the
 * action doesn't supply one, mirroring how reap.py/dispatch.sh allocate
 * cycle IDs today. Missing cycles return null in the `outcome` slot — the
 * UI renders "pending" rather than erroring.
 *
 * The fetch is one ZREVRANGEBYSCORE for the turn members and one pipelined
 * batch of HGETALL calls for the cycle hashes. O(turns + dispatches) Redis
 * round trips, not O(turns * dispatches).
 */
export async function fetchTurnsWithJoins(
  runId: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const r = getRedisConnection();
  // ZREVRANGEBYSCORE +inf -inf LIMIT 0 N → most recent turn_n first.
  const raw: string[] = await r.zrevrangebyscore(
    redisKeys.autopilotRunTurns(runId),
    "+inf",
    "-inf",
    "LIMIT",
    0,
    limit,
  );
  if (!raw || raw.length === 0) return [];

  // Parse + collect the cycle IDs we need to look up. Each dispatch action
  // contributes one cycle key. Non-dispatch actions contribute nothing.
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
        // Action may explicitly carry a cycleId/autopilotTurnId. Otherwise
        // synthesize the canonical key the dispatcher would have used.
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

  // Batch-fetch all cycle hashes in a single pipeline.
  const cycleMap: Record<string, Record<string, string>> = {};
  if (cycleIdsToFetch.length > 0) {
    const pipeline = r.pipeline();
    const uniqueIds = Array.from(new Set(cycleIdsToFetch));
    for (const cid of uniqueIds) {
      pipeline.hgetall(redisKeys.cycle(cid));
    }
    const results: any[] = await pipeline.exec();
    uniqueIds.forEach((cid, i) => {
      const entry = results?.[i];
      // ioredis pipeline result shape: [err, value]
      const hash = entry && Array.isArray(entry) ? entry[1] : null;
      if (hash && typeof hash === "object" && Object.keys(hash).length > 0) {
        cycleMap[cid] = hash as Record<string, string>;
      }
    });
  }

  // Attach outcomes onto the dispatch actions and strip the temporary _cycleId.
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
 * pid liveness probe. `kill -0 pid` does not actually signal the process —
 * it only checks existence/permission. Returns true iff the pid is alive
 * AND we have permission to signal it.
 *
 * pid=0 is a defensive "we don't know" — return alive so the sweeper does
 * NOT promote to killed (avoids killing rows from older writers that didn't
 * stamp a pid).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = no such process; EPERM = process exists but we can't signal.
    // EPERM means alive-from-our-perspective; only ESRCH is a true "dead".
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

/**
 * Read-time sweeper. If the row is `running` and the pid is dead, promote
 * to `status: killed, term_reason: crash`. Idempotent — only the
 * `running → killed/crash` direction.
 *
 * Returns the (possibly mutated) row plus a flag noting whether a sweep
 * write actually happened.
 */
export async function sweepRunIfDead(
  runId: string,
  row: Record<string, string>,
): Promise<{ row: Record<string, string>; swept: boolean }> {
  if (row.status !== "running") return { row, swept: false };
  const pid = Number(row.pid || "0");
  if (isPidAlive(pid)) return { row, swept: false };

  // Dead pid — promote. Use last_heartbeat_epoch or started_epoch as the
  // ended_epoch (we don't know exactly when it died; the last write is the
  // best lower-bound estimate).
  const endedEpoch =
    Number(row.last_heartbeat_epoch || "0") || Number(row.started_epoch || "0") ||
    Math.floor(Date.now() / 1000);

  await hashSetField(redisKeys.autopilotRun(runId), "status", "killed");
  await hashSetField(redisKeys.autopilotRun(runId), "term_reason", "crash");
  await hashSetField(redisKeys.autopilotRun(runId), "ended_epoch", String(endedEpoch));
  await expireKey(redisKeys.autopilotRun(runId), RUN_TTL_SECONDS);

  const mutated = {
    ...row,
    status: "killed",
    term_reason: "crash",
    ended_epoch: String(endedEpoch),
  };
  return { row: mutated, swept: true };
}

/**
 * Project a raw Redis hash into the public response shape: parse JSON limits,
 * coerce numeric fields, compute elapsed_s / age_s, and on `running` rows
 * compute pid_alive + wedge_likely.
 */
export function projectRunView(row: Record<string, string>): Record<string, unknown> {
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
  const elapsedS = endedEpoch !== undefined ? Math.max(0, endedEpoch - startedEpoch) : Math.max(0, now - startedEpoch);
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

  if (status === "running") {
    const pid = Number(row.pid || "0");
    view.pid_alive = isPidAlive(pid);
    view.wedge_likely = ageS > WEDGE_AGE_THRESHOLD_S;
  }

  return view;
}

function numberOrDefault(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Clamp an integer to [min, max], falling back to `fallback` for NaN /
 * non-finite / non-integer inputs. Used for query-string limits where a
 * misbehaving caller shouldn't be able to drive an unbounded ZRANGE.
 */
export function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Compute the slice-4 cost breakdown from a set of (already-joined) turn
 * rows. Sums `outcome.costUsd` across all dispatch actions in this run.
 *
 * `orchestration_cost_usd` is always 0 — the outer `claude -p /hydra-autopilot`
 * call is subscription-billed (see issue body). It's surfaced as a separate
 * field so the dashboard can render the explicit "(subscription)" annotation
 * without inferring it.
 *
 * Returns:
 *   {
 *     orchestration_cost_usd: 0,
 *     dispatched_cost_usd:    sum,        // joined from cycle records
 *     dispatch_count:         N,          // total dispatch actions (any outcome)
 *     dispatch_count_with_cost: M,        // dispatches whose cycle had costUsd
 *   }
 *
 * Exported for direct test access.
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
 * Project a single run hash + its joined turns into the digest shape used by
 * the history table. Performs ONE turn-fetch per run (the table needs the
 * cost total, which we get from the same joins we'd do for the live page).
 *
 * Fields match the issue body's column list:
 *   run_id, started, ended, duration_s, status, term_reason, trigger,
 *   turns, dispatches, merged_count, failed_count, total_tokens,
 *   total_cost_usd, exit_code
 */
export async function projectRunDigest(
  runId: string,
  row: Record<string, string>,
): Promise<Record<string, unknown>> {
  // We need the dispatch actions to compute merged_count / failed_count /
  // total_cost_usd. The run hash already gives us `dispatches` as a counter
  // but not the breakdown by outcome — that requires walking the joined turns.
  //
  // Use a generous cap (RUN_TURNS_MAX_FETCH) so we never under-count for
  // long runs. Run TTL is 7d, dispatches per run are bounded by token budget.
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
        // else: "running"/"pending"/unknown — uncounted in the digest (it's a
        // history view; in-flight outcomes resolve next refresh).
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
