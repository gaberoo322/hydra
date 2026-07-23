/**
 * Autopilot Run + Lifecycle **composite READS** — the read-coordination Module
 * that powers `GET /api/autopilot/runs(/...)`, the `/now` page, and the status
 * / behavior-gallery aggregators.
 *
 * Extracted from `runs.ts` (this issue) so the lifecycle WRITE path
 * (`startRun`/`endRun`/`recordTurn`) and the composite
 * READ path each have a single named home, completing the
 * write/read separation that #1183 (`run-projections.ts`, the pure projections)
 * began and #2568 (`sweep-reader.ts`, the dead-pid sweep idiom) extended. The
 * composite-read *orchestrators* — the functions that DRIVE those projections
 * and sweep helpers to assemble a caller-facing view — stayed in `runs.ts`
 * across both prior rounds; they now live here.
 *
 * This Module is the single place callers reach for any "read a run or
 * lifecycle" question:
 *
 *   - `getCurrentLifecycle` — most-recent run's discriminated lifecycle state
 *   - `getCurrentRun` — most-recent run's projected view + latest 50 turns
 *   - `getRun` — one run by id with the FULL turn timeline
 *   - `getRunRow` — the raw run hash (for the log/journal endpoints)
 *   - `listRuns` — recent runs as history-table digests
 *   - `readInflightSlotSeed` — the in-flight subagent dispatch slot seed
 *   - `getRunDispatchClasses` — the distinct dispatch classes a run used
 *
 * Dependency direction (kept acyclic — mirrors the #1183 / #2568 invariants):
 *   - `run-reads.ts` → `run-projections.ts` (the pure projections it drives)
 *   - `run-reads.ts` → `sweep-reader.ts` (the sweep-composite readers it drives)
 *   - `run-reads.ts` → `redis/autopilot-runs.ts` + `redis/dispatches.ts`
 *     (the typed Redis Adapters it composes)
 *   - `run-reads.ts` → `run-result.ts` (the shared `Ok`/`Err`/`errRedis`
 *     result-type primitives ONLY — a downward edge to the zero-I/O leaf that
 *     the write module `runs.ts` also imports, so a read module no longer
 *     depends on a write module for its result types; issue #3087).
 *
 * There is NO back-compat re-export of this read surface from `runs.ts` (the
 * #2125 precedent that #1183 and #2568 both followed): external callers import
 * these readers from `run-reads.ts` directly. Errors are returned as result
 * objects, never thrown, matching the `merge/grounding/verification` convention
 * in CLAUDE.md.
 */

import {
  getAutopilotRun,
  listRecentAutopilotRunIds,
  listAutopilotRunTurnsDesc,
} from "../redis/autopilot-runs.ts";
import { listActiveSubagentDispatches } from "../redis/dispatches.ts";
// The pure read-projections live in `run-projections.ts` (issue #1183). The
// composite readers below DRIVE these projections; they are imported here for
// that use.
import {
  RUN_TURNS_MAX_FETCH,
  fetchTurnsWithJoins,
  projectRunView,
  projectRunDigest,
} from "./run-projections.ts";
import { deriveInflightSlotSeed } from "./run-lifecycle-state.ts";
import type { AutopilotLifecycle, InflightSlotSeed } from "./run-lifecycle-state.ts";
// The sweep-composite-reader idiom lives in `sweep-reader.ts` (issue #2568):
// the readers that pair a Redis load with the dead-pid sweep. The composite
// readers below DRIVE these; imported here for that use.
import { readLifecycleState, sweepLoadedRow } from "./sweep-reader.ts";
// Shared result-type primitives. `Ok`/`Err`/`errRedis` live in the zero-I/O leaf
// `run-result.ts` (issue #3087); the read orchestrators import them DOWN from
// that leaf — the same leaf the write module `runs.ts` imports — so a read
// module no longer depends sideways on the write module for its result types.
import { type Ok, type Err, errRedis } from "./run-result.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Reader: high-level — compose Redis reads + the projections in
// `run-projections.ts` (issue #1183) + the sweep-composite readers in
// `sweep-reader.ts` (issue #2568).
// ---------------------------------------------------------------------------

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
    return { ok: true, lifecycle: await readLifecycleState(runId, row) };
  } catch (err: any) {
    return errRedis(err);
  }
}

export type GetCurrentRunResult =
  | Ok<{ view: Record<string, unknown> }>
  | Err;

/**
 * Read the most recent run, apply the dead-pid sweeper, project, and
 * attach the latest 50 turns with cycle joins. 404 surfaces as
 * `{ ok: false, code: "not-found" }`.
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
    const view = projectRunView(await sweepLoadedRow(runId, row));
    const turns = await fetchTurnsWithJoins(runId, 50);
    (view as any).turns = turns;
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
    const view = projectRunView(await sweepLoadedRow(runId, row));
    const turns = await fetchTurnsWithJoins(runId, RUN_TURNS_MAX_FETCH);
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

/**
 * Async wrapper around {@link deriveInflightSlotSeed}: reads the live in-flight
 * subagent dispatch ledger and returns the slot seed. Powers
 * `GET /api/autopilot/inflight-slots`, which `bootstrap.sh` curls to seed
 * `state.json.slots` on relaunch (issue #1352). Never throws — a Redis failure
 * degrades to an empty seed (all-null slots, the pre-#1352 behaviour) so a
 * bootstrap can never be blocked by this read.
 */
export async function readInflightSlotSeed(): Promise<
  Record<string, InflightSlotSeed>
> {
  try {
    const dispatches = await listActiveSubagentDispatches();
    return deriveInflightSlotSeed(dispatches);
  } catch (err) {
    logger.error({ err }, "[autopilot] readInflightSlotSeed failed");
    return {};
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
      const digest = await projectRunDigest(runId, await sweepLoadedRow(runId, row));
      digests.push(digest);
    }
    return { ok: true, runs: digests };
  } catch (err: any) {
    return errRedis(err);
  }
}

// ---------------------------------------------------------------------------
// Reader: dispatch-class projection (issue #2640)
//
// "Which autopilot dispatch classes did run X use?" is a domain question for
// the AutopilotRun read surface — so it lives here (alongside the other
// composite readers) rather than in the behavior-gallery aggregator, which
// previously reached across the boundary into `src/redis/autopilot-runs.ts` via
// a dynamic `await import(...)` to run its own turn-scan. The aggregator now
// calls this typed function through its `deps.fetchClasses` injection point, and
// the dynamic import disappears (the module graph stays fully static).
// ---------------------------------------------------------------------------

/**
 * Soft cap on turns scanned per run for the dispatch-class projection. Matches
 * the value the retired `defaultFetchClasses` used in behavior-gallery.ts — a
 * run's dispatch classes stabilise well within its first couple hundred turns,
 * and the projection is a coarse "which classes appeared", not a per-turn read.
 */
const DISPATCH_CLASSES_TURN_SCAN = 200;

/**
 * Narrow, injectable reader seam for {@link getRunDispatchClasses}. Mirrors the
 * `ProjectionDeps` pattern in `run-projections.ts` (issue #1183): defaults to
 * the real typed accessor, but a test passes a stub so the turn-scan / dedup /
 * sort logic is exercisable without a live Redis.
 */
export interface DispatchClassesDeps {
  listTurnsDesc: (runId: string, limit: number) => Promise<string[]>;
}

const defaultDispatchClassesDeps: DispatchClassesDeps = {
  listTurnsDesc: listAutopilotRunTurnsDesc,
};

/**
 * Resolve the distinct autopilot dispatch classes a run used — the canonical
 * query behind the Explore Behavior tab's `class` filter. Pulls the turn list
 * off Redis (newest-first, capped) and harvests `actions[].class` from each
 * turn's `type === "dispatch"` actions. Returns a deduped, alphabetically
 * sorted `string[]`.
 *
 * Tolerant parse: a malformed turn member (unparseable JSON, non-array
 * `actions`, missing `class`) is silently skipped — a run's class set is a
 * "no signal" projection, not a correctness surface, so a single bad row must
 * not blank the whole result. This is identical to the behaviour of the retired
 * `defaultFetchClasses` this function replaces.
 */
export async function getRunDispatchClasses(
  runId: string,
  deps: DispatchClassesDeps = defaultDispatchClassesDeps,
): Promise<string[]> {
  const members = await deps.listTurnsDesc(runId, DISPATCH_CLASSES_TURN_SCAN);
  const classes = new Set<string>();
  for (const member of members) {
    try {
      const turn = JSON.parse(member);
      const actions = Array.isArray(turn?.actions) ? turn.actions : [];
      for (const a of actions) {
        if (a && a.type === "dispatch" && typeof a.class === "string") {
          classes.add(a.class);
        }
      }
    } catch { /* intentional: skip malformed turn rows — caller treats absent classes as "no signal" */ }
  }
  return [...classes].sort();
}
