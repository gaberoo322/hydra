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
import { recordCycleMetrics } from "../metrics.ts";

const CYCLE_TTL_SECONDS = 7 * 24 * 3600; // 7 days — matches /cycle/register
const RUN_TTL_SECONDS = 7 * 24 * 3600; // 7 days — autopilot run rows
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

      return res.json(view);
    } catch (err: any) {
      console.error(`[autopilot] runs/current failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
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
