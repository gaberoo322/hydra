/**
 * Autopilot Run **read projections** — the testable read surface that powers
 * `GET /api/autopilot/runs(/...)` and the dashboard.
 *
 * Split out of `src/autopilot/runs.ts` (issue #1183) so the lifecycle WRITES
 * (`startRun`/`endRun`/`recordTurn`/`recordCycle`/`sweepRunIfDead`/...) and the
 * read PROJECTIONS live in separate modules. This module owns the read-only,
 * mostly-pure derivation surface:
 *
 *   - `fetchTurnsWithJoins` — turn-fetch + cycle-outcome join
 *   - `projectRunView` — raw hash → public run view
 *   - `projectRunDigest` — raw hash + joins → history-table digest
 *   - `deriveLifecycleState` — pure discriminated lifecycle derivation (#888)
 *
 * The two Redis-touching projections (`fetchTurnsWithJoins`, `projectRunDigest`)
 * accept an injectable `deps` reader bag so tests can pin the projection
 * boundary without a live Redis (the default `deps` reads through the real
 * typed accessors). Everything else here is pure — no Redis, no clock beyond
 * `Date.now()` which the caller can normalise.
 *
 * This Module is the canonical home for every read-projection symbol. The
 * back-compat re-export relay that once forwarded them through `runs.ts` was
 * retired (issue #2125), so callers import from here directly.
 */

import {
  getCycleHashesBatch,
} from "../redis/cycle-tracking.ts";
import {
  listAutopilotRunTurnsDesc,
} from "../redis/autopilot-runs.ts";
import { osHeartbeatAgeS, isOsHeartbeatStale } from "./os-heartbeat.ts";
import { classBySkill } from "../taxonomy/classes.ts";
import {
  epochFromIsoOrNow,
  type SubagentDispatch,
} from "../redis/dispatches.ts";
import { bucketCycleStatus } from "./cycle-status.ts";
import { isLivePid } from "../worktree-orphan.ts";

// ---------------------------------------------------------------------------
// Constants (read-side)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Read-only leaf helpers
// ---------------------------------------------------------------------------

/**
 * `kill -0 pid` liveness probe. Returns true iff the pid is alive AND
 * we have permission to signal it (EPERM = alive-from-our-perspective).
 * An invalid pid (`!Number.isFinite || pid <= 0`) is treated as alive so the
 * sweeper doesn't promote rows from older writers that never stamped a pid.
 *
 * This is now a re-export of the canonical {@link isLivePid} predicate in
 * src/worktree-orphan.ts (consolidated in issue #2816 — the semantics were
 * already identical here; the two former unguarded copies in src/index.ts and
 * scripts/ci/branch-prune-runner.ts diverged only on non-finite pids). The
 * `isPidAlive` name is kept as an alias so the ~6 downstream deps-bag
 * references (runs.ts, sweep-reader.ts, cycle-close.ts + their tests, all keyed
 * on the field name `isPidAlive`) do not churn; the rename is an opportunistic
 * follow-up, out of scope here.
 */
export const isPidAlive = isLivePid;

/**
 * Parse a persisted `crash_detail` JSON string back into an object for the
 * read projection. A missing / unparseable value yields `null` (treated as
 * "no crash detail captured") rather than throwing — the read surface must
 * stay loud-but-non-fatal.
 */
function parseCrashDetail(raw: string | undefined): Record<string, unknown> | null {
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

// ---------------------------------------------------------------------------
// Injectable reader deps (so projections are testable without Redis)
// ---------------------------------------------------------------------------

/**
 * Reader seam for the two Redis-touching projections. Defaults to the real
 * typed accessors; tests pass a stub bag to pin the join/digest boundary
 * without a live Redis. Kept narrow — only the reads the projections perform.
 */
export interface ProjectionDeps {
  listTurnsDesc: (runId: string, limit: number) => Promise<string[]>;
  getCycleHashesBatch: (cycleIds: string[]) => Promise<Record<string, Record<string, string>>>;
}

const defaultProjectionDeps: ProjectionDeps = {
  listTurnsDesc: listAutopilotRunTurnsDesc,
  getCycleHashesBatch,
};

// ---------------------------------------------------------------------------
// Projection: turn-join
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
 * `getCycleHashesBatch`. `deps` is injectable so the join boundary can
 * be pinned without Redis.
 */
export async function fetchTurnsWithJoins(
  runId: string,
  limit: number,
  deps: ProjectionDeps = defaultProjectionDeps,
): Promise<Array<Record<string, unknown>>> {
  const raw = await deps.listTurnsDesc(runId, limit);
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

  const cycleMap = await deps.getCycleHashesBatch(cycleIdsToFetch);

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

// ---------------------------------------------------------------------------
// Projection: run view
// ---------------------------------------------------------------------------

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
    } catch (err) {
      console.error(`[autopilot] corrupt limits JSON in run row — degrading to {}: ${err}`);
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

// ---------------------------------------------------------------------------
// Projection: run digest
// ---------------------------------------------------------------------------

/**
 * Project a single run hash + its joined turns into the digest shape
 * used by the history table. One turn-fetch per run, reusing the same
 * joins we'd do for the live page. `deps` is injectable so the digest
 * boundary can be pinned without Redis.
 */
export async function projectRunDigest(
  runId: string,
  row: Record<string, string>,
  deps: ProjectionDeps = defaultProjectionDeps,
): Promise<Record<string, unknown>> {
  const turns = await fetchTurnsWithJoins(runId, RUN_TURNS_MAX_FETCH, deps);

  let merged = 0;
  let failed = 0;
  for (const turn of turns) {
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    for (const a of actions) {
      if (a && a.type === "dispatch" && a.outcome && typeof a.outcome === "object") {
        const bucket = bucketCycleStatus(String((a.outcome as any).status || ""));
        if (bucket === "merged") merged += 1;
        else if (bucket === "failed") failed += 1;
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
    exit_code: row.exit_code !== undefined ? Number(row.exit_code) : null,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle truth (issue #888) — pure derivation
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
type AutopilotLifecycleState = "running" | "idle" | "ended" | "crashed";

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

// ---------------------------------------------------------------------------
// Termination-health rollup (issue #1352 / #1815 / #1847)
//
// Moved here from `runs.ts` (issue #1964) to complete the #1183 split:
// `summarizeTerminationHealth` is a pure analytical projection over an
// already-fetched run-digest array (no Redis, no clock, no await), so its home
// is this read-only projection Module, not the write-side lifecycle Module.
// Callers import it from here directly (the runs.ts relay was retired, #2125).
// ---------------------------------------------------------------------------

/**
 * Pure coercion helper — local copy of the same-named write-side helper in
 * `runs.ts` (issue #1964). It is COPIED rather than imported so this module
 * stays the lower, projection-only Module: importing it from `runs.ts` would
 * invert the `runs.ts` → `run-projections.ts` dependency direction. The
 * `runs.ts` copy (with its 18 write-side digest-reader call sites) is unrelated
 * to this move and stays put.
 */
function numberOrDefault(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * `term_reason` values that mark a CLEAN self-termination — the run's own
 * decision loop (`term-check.py` / `decide._check_termination`) reached a stop
 * rule and POSTed run-end, rather than the reap backstop catching a truncated
 * print-mode session. These are the numerator of the clean-termination rate.
 *
 * `handoff` (issue #1903) is ALSO clean: a print-mode session that ended a turn
 * with subagent slots still occupied is an honest baton-pass to the successor
 * run's dispatch ledger (#1352), not a truncation. Counting it clean is the
 * whole point of #1903 — today every dispatch-bearing run terminates
 * `interrupted` (baton-pass mis-stamped), pinning `cleanTerminationRate` ≈ 0 and
 * the #1815/#1847 starvation alarm permanently on. Reclassifying the baton-pass
 * makes the rate measure REAL starvation (crashes / zero-progress) instead.
 *
 * `interrupted` / `crash` / `failure_backstop` are NOT clean: `interrupted` is
 * the reap backstop's cause for a print-mode session that exited (code 0/143/
 * 130) with ZERO slots in flight before the loop reached a stop rule — a
 * genuine truncation with nothing pending, distinct from the `handoff`
 * baton-pass (slots > 0).
 */
const CLEAN_TERM_REASONS: ReadonlySet<string> = new Set([
  "idle",
  "budget",
  "wall_clock",
  "handoff",
]);

/**
 * Pure observability rollup over the run digests (issue #1352, acceptance
 * clause 3; gating refined in #1815). Computes the **clean-termination rate** —
 * the fraction of **dispatch-bearing** ENDED runs that self-terminated via a
 * clean `term_reason` ({@link CLEAN_TERM_REASONS} — including the #1903
 * `handoff` baton-pass) rather than the `interrupted`/`crash` reap backstop.
 * When this rate sits at ~0 over a
 * non-trivial sample of dispatch-bearing runs, the retro learning loop is
 * structurally starved (every run dies before its dispatches' terminal cycle
 * records materialise) — the alarm condition #1352 was filed on.
 *
 * **Why dispatch-gated (issue #1815):** the board is dominated by *trivial
 * idle-at-startup* runs — the autopilot launches (pace-gate timer), finds no
 * eligible work, and idles out in ~1-3min with `dispatches=0` and a clean
 * `idle` term_reason. Counting those toward the clean numerator made
 * `cleanRuns === 0` essentially never true, masking the exact starvation signal
 * the alarm was built for (live: 0/11 dispatch-bearing runs terminated cleanly,
 * yet the alarm read healthy because 26 trivial idle-drains inflated the rate to
 * 0.33). The rate and the `starved` bit are therefore computed over
 * `runs.filter(r => r.dispatches > 0)` only — trivial idle runs neither inflate
 * the numerator nor mask the alarm.
 *
 * Read-only and total: takes already-fetched digests, returns counts + a
 * nullable rate (null when there are no *dispatch-bearing* ended runs to divide
 * by, so a fresh / work-starved-board system reports "no data" rather than a
 * misleading 0).
 *
 * Returned fields:
 * - `cleanTerminationRate` — dispatch-bearing clean runs / dispatch-bearing
 *   ended runs (null when there are no dispatch-bearing ended runs).
 * - `endedRuns` / `cleanRuns` — raw counts over ALL ended runs (un-gated;
 *   retained for backward-compatible reporting and so a consumer can see how
 *   many trivial idle-drains were filtered out: `endedRuns -
 *   dispatchBearingRuns`).
 * - `dispatchBearingRuns` / `dispatchBearingCleanRuns` — the gated counts the
 *   rate and alarm are actually derived from.
 * - `endedDispatchTotal` — total dispatches across ended runs (unchanged).
 * - `starved` — the pre-derived alarm bit: true when a non-trivial sample of
 *   **dispatch-bearing** ended runs ({@link STARVATION_MIN_ENDED_RUNS}) sustains
 *   a clean-termination RATE below {@link STARVATION_CLEAN_RATE_FLOOR}. Consumers
 *   (hydra-doctor, the dashboard) alarm on the boolean directly instead of
 *   re-deriving thresholds.
 *
 * **Why a rate floor, not `=== 0` (issue #1847):** #1815 fixed the denominator
 * (dispatch-bearing gating) but left the threshold a brittle boolean —
 * `dispatchBearingCleanRuns === 0`. As soon as a SINGLE dispatch-bearing run
 * terminated cleanly, the alarm silenced regardless of how low the real rate
 * was, so a live 2/33 = ~6% clean rate read `starved: false`. The threshold is
 * now a strict rate comparison: `cleanTerminationRate < STARVATION_CLEAN_RATE_FLOOR`
 * (0.15) once the sample floor is met. At MIN=5 this preserves the old floor
 * (0/5 still trips), while a sustained sub-15% rate at larger N now alarms
 * instead of being masked by one clean run.
 */
const STARVATION_MIN_ENDED_RUNS = 5;

/**
 * Minimum clean-termination RATE (over dispatch-bearing ended runs) below which
 * the {@link summarizeTerminationHealth} `starved` alarm fires, once the
 * {@link STARVATION_MIN_ENDED_RUNS} sample floor is met (issue #1847). A strict
 * `<` comparison: at the 5-run floor, 0/5 = 0 trips (preserving the pre-#1847
 * `=== 0` behavior) while 1/5 = 0.20 clears; a sustained sub-15% rate at any
 * larger sample now alarms instead of being silenced by a single clean run.
 */
const STARVATION_CLEAN_RATE_FLOOR = 0.15;

export function summarizeTerminationHealth(
  runs: Array<Record<string, unknown>>,
): {
  cleanTerminationRate: number | null;
  endedRuns: number;
  cleanRuns: number;
  dispatchBearingRuns: number;
  dispatchBearingCleanRuns: number;
  endedDispatchTotal: number;
  starved: boolean;
} {
  let endedRuns = 0;
  let cleanRuns = 0;
  let dispatchBearingRuns = 0;
  let dispatchBearingCleanRuns = 0;
  let endedDispatchTotal = 0;
  for (const run of runs) {
    if (run.status !== "ended") continue;
    endedRuns += 1;
    const dispatches = numberOrDefault(run.dispatches, 0);
    endedDispatchTotal += dispatches;
    const termReason = typeof run.term_reason === "string" ? run.term_reason : "";
    const isClean = CLEAN_TERM_REASONS.has(termReason);
    if (isClean) cleanRuns += 1;
    // Gate the rate + alarm on dispatch-bearing runs only (#1815): trivial
    // idle-at-startup runs (dispatches=0) must not inflate the clean numerator
    // and mask the starvation signal.
    if (dispatches > 0) {
      dispatchBearingRuns += 1;
      if (isClean) dispatchBearingCleanRuns += 1;
    }
  }
  const cleanTerminationRate =
    dispatchBearingRuns > 0 ? dispatchBearingCleanRuns / dispatchBearingRuns : null;
  return {
    cleanTerminationRate,
    endedRuns,
    cleanRuns,
    dispatchBearingRuns,
    dispatchBearingCleanRuns,
    endedDispatchTotal,
    // Issue #1847: strict rate comparison against the already-computed
    // dispatch-gated rate (do NOT re-derive). One clean run no longer
    // permanently silences the alarm — a sustained sub-floor rate trips it.
    starved:
      dispatchBearingRuns >= STARVATION_MIN_ENDED_RUNS &&
      cleanTerminationRate !== null &&
      cleanTerminationRate < STARVATION_CLEAN_RATE_FLOOR,
  };
}

// ---------------------------------------------------------------------------
// Inflight-slot seed (issue #1352 Problem A) — pure read-side derivation
//
// Moved here from `runs.ts` (issue #1993) to complete the #1183 split:
// `deriveInflightSlotSeed` is a pure function over the in-flight subagent
// dispatch ledger (no Redis, no clock, no await — the async `readInflightSlotSeed`
// wrapper in `runs.ts` does the Redis read), so its home is this read-only
// projection Module, not the write-side lifecycle Module. Callers import both
// symbols from here directly (the runs.ts relay was retired, #2125).
// ---------------------------------------------------------------------------

/**
 * One seeded pipeline-slot object — the shape `decide.py` reads when it tests
 * `occupied = sum(1 for v in slots.values() if v is not None)` in
 * `_rule_idle_fallback`, and when `_rule_orphaned_slots` ages the slot against
 * the subagent wall-clock cap. We carry the real `started_epoch` so a genuinely
 * over-age in-flight subagent is correctly drained via `wait_or_reap` rather
 * than held forever; `task_id` is the subagent's dispatchId (best-effort — the
 * slot-event reap path frees the slot by class name, not by task_id match);
 * `_source` marks the row as a cross-run seed for debugging.
 */
export interface InflightSlotSeed {
  skill: string;
  task_id: string;
  started: string;
  started_epoch: number;
  _source: "inflight-seed";
}

/**
 * Issue #1352 (Problem A — premature idle-terminate). Pure helper: map the
 * in-flight **subagent dispatch ledger** (`hydra:dispatches:subagent:*`, which
 * survives a pace-gate relaunch) onto the fixed pipeline-slot occupancy
 * `decide.py` reasons about, so a freshly-bootstrapped run can SEED
 * `state.json.slots` with the subagents the prior session left running.
 *
 * Without this seed, `bootstrap.sh` clobbers `state.json` with all-null slots
 * on every relaunch; the new session's first `decide.py decide` call then sees
 * `occupied == 0` while a real subagent is still running (its `SubagentStop`
 * hook event has not arrived yet) and trips `_rule_idle_fallback` into a
 * `terminate(cause=idle)` — which the print-mode session honours by exiting,
 * and the ExecStopPost reap backstop stamps `interrupted`. Result: 100%
 * interrupted runs, 0 drillable retro dispatches. Seeding `occupied > 0` makes
 * the rule emit `wait` (busy-wait nap) instead, so the run survives until the
 * subagent's `SubagentStop` event frees the slot or the orphaned-slot age cap
 * drains it.
 *
 * Read-only and total over its inputs (no IO — the async wrapper does the
 * Redis read). Skips dispatches whose `skill` maps to a non-pipeline class
 * (signal classes have no slot semantics) or to no class at all. At most one
 * seed per pipeline slot — the newest dispatch (the ledger lists newest-first)
 * wins, matching the "≤1 subagent per slot" invariant.
 */
export function deriveInflightSlotSeed(
  dispatches: readonly SubagentDispatch[],
): Record<string, InflightSlotSeed> {
  const slots: Record<string, InflightSlotSeed> = {};
  for (const d of dispatches) {
    if (!d.skill) continue;
    const cls = classBySkill(d.skill);
    if (!cls || cls.kind !== "pipeline") continue;
    // listActiveSubagentDispatches is newest-first; keep the first seen per
    // slot so the freshest dispatch wins the ≤1-per-slot pipeline invariant.
    if (slots[cls.name]) continue;
    const startedEpoch = epochFromIsoOrNow(d.startedAt);
    slots[cls.name] = {
      skill: d.skill,
      task_id: d.dispatchId || d.sessionId,
      started: d.startedAt,
      started_epoch: startedEpoch,
      _source: "inflight-seed",
    };
  }
  return slots;
}
