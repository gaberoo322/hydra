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
 *   - `computeCostBreakdown` — cost rollup from joined turns
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
 * `runs.ts` re-exports every symbol moved here, so existing import paths
 * (`from "../autopilot/runs.ts"`) keep resolving unchanged.
 */

import {
  getCycleHashesBatch,
} from "../redis/cycle-tracking.ts";
import {
  listAutopilotRunTurnsDesc,
} from "../redis/autopilot-runs.ts";
import { osHeartbeatAgeS, isOsHeartbeatStale } from "./os-heartbeat.ts";

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

/**
 * Status values that count toward `cycles-merged` (vs `cycles-failed`).
 * Aligned with the autopilot taxonomy: a "cycle" merged when the
 * dispatched subagent landed a PR; failed when it abandoned, timed
 * out, or its PR closed unmerged.
 *
 * Owned here because the projections (`projectRunDigest`) are the
 * primary read-side users; the `recordCycle` writer imports them back
 * from this module so there is a single definition.
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
// Read-only leaf helpers
// ---------------------------------------------------------------------------

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

export const defaultProjectionDeps: ProjectionDeps = {
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

// ---------------------------------------------------------------------------
// Projection: cost breakdown
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Projection: run digest
// ---------------------------------------------------------------------------

/**
 * Project a single run hash + its joined turns into the digest shape
 * used by the history table. One turn-fetch per run; the table needs
 * the cost total, which we get from the same joins we'd do for the
 * live page. `deps` is injectable so the digest boundary can be pinned
 * without Redis.
 */
export async function projectRunDigest(
  runId: string,
  row: Record<string, string>,
  deps: ProjectionDeps = defaultProjectionDeps,
): Promise<Record<string, unknown>> {
  const turns = await fetchTurnsWithJoins(runId, RUN_TURNS_MAX_FETCH, deps);
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
