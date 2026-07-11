/**
 * Autopilot Run **I/O projection coordinator** — the Redis-touching read
 * surface that powers `GET /api/autopilot/runs(/...)` and the dashboard.
 *
 * Split out of `src/autopilot/runs.ts` (issue #1183) so the lifecycle WRITES
 * (`startRun`/`endRun`/`recordTurn`/`recordCycle`/`sweepRunIfDead`/...) and the
 * read PROJECTIONS live in separate modules. This module owns the projection
 * coordinator — the raw-hash mapping + turn-join derivations:
 *
 *   - `fetchTurnsWithJoins` — turn-fetch + cycle-outcome join (Redis)
 *   - `projectRunView` — raw hash → public run view
 *   - `projectRunDigest` — raw hash + joins → history-table digest (Redis)
 *
 * The two Redis-touching projections (`fetchTurnsWithJoins`, `projectRunDigest`)
 * accept an injectable `deps` reader bag so tests can pin the projection
 * boundary without a live Redis (the default `deps` reads through the real
 * typed accessors).
 *
 * The pure, zero-I/O **run-lifecycle state machine** — `deriveLifecycleState`,
 * `summarizeTerminationHealth`, `deriveInflightSlotSeed` (+ their constants and
 * types) — was extracted into the sibling leaf `run-lifecycle-state.ts`
 * (issue #3106), following the `retro-dispatch-classifier.ts` extraction
 * precedent (#3090 / PR #3094): pure state-machine logic lives apart from the
 * I/O coordinator that calls it. This module imports DOWN from the leaf for the
 * `WEDGE_AGE_THRESHOLD_S` constant `projectRunView` still needs, and re-exports
 * that constant below so callers already resolving it through this path do not
 * churn. The three lifecycle FUNCTION re-exports (`deriveLifecycleState`,
 * `summarizeTerminationHealth`, `deriveInflightSlotSeed`) were dropped once every
 * caller migrated to importing them from the leaf directly (issue #3143), and the
 * lifecycle TYPE re-exports (`AutopilotLifecycle`, `AutopilotLifecycleState`,
 * `InflightSlotSeed`) followed for the same reason (issue #3147) — every caller
 * now imports them from the leaf.
 *
 * This Module is the canonical home for the projection-coordinator symbols. The
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
import { bucketCycleStatus } from "./cycle-status.ts";
import { isLivePid } from "../worktree-orphan.ts";
import { WEDGE_AGE_THRESHOLD_S } from "./run-lifecycle-state.ts";

// ---------------------------------------------------------------------------
// Back-compat re-export relay (issue #3106, #2125 migration window)
//
// The pure run-lifecycle state machine now lives in `run-lifecycle-state.ts`.
// `projectRunView` in this module still reads `WEDGE_AGE_THRESHOLD_S`, so that
// constant is re-exported here to preserve the public surface at this import
// path. The three lifecycle FUNCTIONS were dropped from the relay once every
// caller migrated to the leaf (issue #3143); the lifecycle TYPES followed for
// the same reason (issue #3147). New callers of the state machine SHOULD import
// from `run-lifecycle-state.ts`.
// ---------------------------------------------------------------------------
export {
  WEDGE_AGE_THRESHOLD_S,
} from "./run-lifecycle-state.ts";

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

// `WEDGE_AGE_THRESHOLD_S` now lives in the `run-lifecycle-state.ts` leaf
// (issue #3106) and is imported DOWN above; `projectRunView` reads it and the
// re-export relay preserves the public surface at this path.

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
