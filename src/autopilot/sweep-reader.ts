/**
 * Autopilot Run **sweep-composite reader** idiom — the dead-pid sweeper and
 * the composed readers that pair a Redis load with that sweep before deriving
 * or returning a row.
 *
 * Extracted from `runs.ts` (issue #2568) so the write lifecycle
 * (`startRun`/`endRun`/`recordTurn`/`recordCycle`) and the sweep-composite
 * read idiom each have a single named home, mirroring the
 * `runs.ts`/`run-projections.ts` split (issue #1183): one Module per concern.
 *
 * Concept (see `CONTEXT.md`):
 *   - **Autopilot Run** — one invocation of `/hydra-autopilot`, persisted as
 *     `hydra:autopilot:run:<runId>`. A `running` row whose recorded pid is no
 *     longer alive is a phantom: the run crashed (or was killed) without its
 *     run-end POST ever landing. The dead-pid sweeper promotes such a row to a
 *     terminal status on read so no reader trusts `status: running` verbatim.
 *
 * Dependency direction (kept acyclic — invariant #3 / #4 of the design
 * concept):
 *   - `runs.ts` → `sweep-reader.ts` (one-directional; the write lifecycle
 *     imports the `RUN_TTL_SECONDS` constant + `sweepRunIfDead` predicate it
 *     needs).
 *   - `sweep-reader.ts` → `run-projections.ts` (`deriveLifecycleState`,
 *     `isPidAlive`, type `AutopilotLifecycle`) and
 *     `sweep-reader.ts` → `redis/autopilot-runs.ts` (`getAutopilotRun`).
 *   - The leaf adapter `src/redis/autopilot-runs.ts` gains NO import of
 *     `src/autopilot/` (preserves the #2189 no-cycle guarantee).
 *
 * There is NO back-compat re-export of this surface from `runs.ts` (AC2,
 * matching the #2125 retirement of the back-compat re-export relay):
 * `run-projections.ts` is the canonical-home-no-relay precedent. External
 * callers import the sweep helpers (and `RUN_TTL_SECONDS`) directly from here.
 */

import {
  getAutopilotRun,
  updateAutopilotRunFields,
} from "../redis/autopilot-runs.ts";
import { isPidAlive } from "./run-projections.ts";
import { deriveLifecycleState } from "./run-lifecycle-state.ts";
import type { AutopilotLifecycle } from "./run-lifecycle-state.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 7-day TTL stamped on every autopilot run write. Hosted here — alongside the
 * sweeper that writes with it (`sweepRunIfDead`) — rather than in `runs.ts`,
 * so the constant lives with its most-coupled consumer and `runs.ts` imports
 * it along the single `runs → sweep-reader` edge (issue #2568, acyclic). The
 * write-lifecycle writers in `runs.ts` and the two external importers
 * (`api/now-recommendations.ts`, `autopilot/recommendation-engine.ts`) import
 * it from here directly; there is no `runs.ts` re-export (AC2).
 */
export const RUN_TTL_SECONDS = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// Injectable sweep-reader deps (issue #2568)
//
// The sweeper is the only WRITE among the composed readers: it touches a
// single Redis Adapter accessor (`updateAutopilotRunFields`), the liveness
// probe, and the clock. It declares its OWN narrow `SweepReaderDeps` rather
// than reaching for the wide `AutopilotRunsDeps` that stays in `runs.ts`:
// because the write-lifecycle bag structurally contains
// `runs.updateAutopilotRunFields`, `isPidAlive`, and `now`, an
// `AutopilotRunsDeps` value STRUCTURALLY SATISFIES `SweepReaderDeps` (TS
// structural typing), so the `autopilot-runs-deps` test fixture still
// type-checks when it passes the full deps bag as the sweeper's third arg.
// Mirrors `run-projections.ts` owning its own `ProjectionDeps` (#1183) — each
// Module owns its deps surface, neither drags the other's bag in.
// ---------------------------------------------------------------------------

/** The single run-hash write the sweeper performs. */
interface SweepReaderRunFacade {
  updateAutopilotRunFields(
    runId: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void>;
}

export interface SweepReaderDeps {
  runs: SweepReaderRunFacade;
  /**
   * Liveness probe used by the dead-pid sweeper. Same field name as
   * `AutopilotRunsDeps.isPidAlive` / `ProjectionDeps.isPidAlive` (by
   * convention, not interface inheritance) and defaults to the same
   * `isPidAlive` imported from `run-projections.ts`. Injecting it makes the
   * sweeper's `running`→`killed`/`crash` branch reachable on a synthetic row
   * without spawning/killing a real PID.
   */
  isPidAlive: (pid: number) => boolean;
  /** Epoch-MS clock. Defaults to `Date.now`. */
  now: () => number;
}

const defaultSweepReaderDeps: SweepReaderDeps = {
  runs: {
    updateAutopilotRunFields,
  },
  isPidAlive,
  now: Date.now,
};

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

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
 * Other read surfaces that scan autopilot run rows (e.g. the
 * active-dispatches aggregator's autopilot sub-source, issue #888) apply the
 * SAME liveness rule via the composed readers below rather than trusting
 * `status: running` verbatim — a crashed run that never POSTed its run-end
 * would otherwise linger as a phantom in-flight dispatch until the 7-day TTL.
 */
export async function sweepRunIfDead(
  runId: string,
  row: Record<string, string>,
  deps: SweepReaderDeps = defaultSweepReaderDeps,
): Promise<{ row: Record<string, string>; swept: boolean }> {
  if (row.status !== "running") return { row, swept: false };
  const pid = Number(row.pid || "0");
  if (deps.isPidAlive(pid)) return { row, swept: false };

  const endedEpoch =
    Number(row.last_heartbeat_epoch || "0") ||
    Number(row.started_epoch || "0") ||
    Math.floor(deps.now() / 1000);

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

  await deps.runs.updateAutopilotRunFields(runId, fields, RUN_TTL_SECONDS);

  const mutated = {
    ...row,
    ...fields,
  };
  return { row: mutated, swept: true };
}

// ---------------------------------------------------------------------------
// Composed readers — load/derive paired with the sweep
// ---------------------------------------------------------------------------

/**
 * Composed read-and-sweep reader (issue #2189): load a run hash via the
 * leaf Redis accessor (`getAutopilotRun`) and then apply the canonical
 * dead-pid sweeper (`sweepRunIfDead`), returning the SWEPT row.
 *
 * This names the read→sweep idiom the high-level readers in `runs.ts` do
 * inline (`getCurrentLifecycle`/`getCurrentRun`/`getRun`/`listRuns`), so a
 * caller that only wants "a run row that already had the stale-pid rule
 * applied" can inject this single reader instead of orchestrating the
 * two-step itself.
 *
 * Its first consumer is the active-dispatches aggregator's autopilot
 * sub-source: by defaulting `getAutopilotRunRow` to THIS function, the
 * aggregator drops its separate `sweepAutopilotRun` dep and its explicit
 * sweep call, restoring the "pure aggregator — no Redis writes in the
 * aggregation layer" family contract. The write side-effect (the dead-pid
 * `running`→`killed`/`crash` promotion) now lives behind the injected
 * reader, not in the aggregator body.
 *
 * Both `getAutopilotRun` and `sweepRunIfDead` are local to this module, so
 * this introduces NO new dependency edge — in particular the leaf adapter
 * `src/redis/autopilot-runs.ts` is untouched and gains no import of
 * `src/autopilot/`, so no cycle is created. `getAutopilotRun` keeps its
 * pure-read semantics (this composes it; it does not change it), so the
 * other `getAutopilotRun` callers (`digest-format.ts`, `api/agents.ts`) are
 * unaffected and no row is double-swept.
 */
export async function readAndSweepAutopilotRun(
  runId: string,
): Promise<{ row: Record<string, string>; swept: boolean }> {
  const row = await getAutopilotRun(runId);
  return sweepRunIfDead(runId, row);
}

/**
 * Compose the dead-pid sweep with lifecycle derivation in ONE reader
 * (issue #2549). Every high-level reader of an Autopilot Run must call
 * `sweepRunIfDead(runId, row)` *before* `deriveLifecycleState(...)`, or it
 * derives a stale `running` lifecycle from a dead-pid row. Before this
 * function that ordering was duplicated at four call sites and enforced only
 * by convention — `deriveLifecycleState`'s signature gives a reader no way to
 * know it is only correct after a sweep. This names the sweep→derive sequence
 * so a caller cannot forget the sweep half.
 *
 * Takes the row the caller already loaded (the readers each apply their own
 * `!row.started` guard with caller-specific not-found/idle semantics, so the
 * read stays at the call site) and returns the swept row's derived lifecycle.
 * `sweepRunIfDead` is idempotent — a terminal row is never re-swept — so this
 * never double-sweeps. `deriveLifecycleState` stays a pure function: the
 * composition lives here, in the Redis-touching reader, not inside the
 * projection (the route layer and projection tests keep pinning the pure
 * derivation directly).
 */
export async function readLifecycleState(
  runId: string,
  row: Record<string, string>,
): Promise<AutopilotLifecycle> {
  const sweepResult = await sweepRunIfDead(runId, row);
  return deriveLifecycleState(sweepResult.row);
}

/**
 * Composed read-side companion to {@link readLifecycleState} for the readers
 * that project the SWEPT row through something other than the lifecycle
 * derivation (`projectRunView` / `projectRunDigest`). Names the
 * sweep-then-return-row half of the same two-step contract so those readers
 * stop replicating the inline `sweepRunIfDead(...).row` dance.
 *
 * Like {@link readLifecycleState}, it takes the already-loaded row (so each
 * caller keeps its own `!row.started` guard semantics) and relies on
 * `sweepRunIfDead`'s idempotence — no row is swept twice.
 */
export async function sweepLoadedRow(
  runId: string,
  row: Record<string, string>,
): Promise<Record<string, string>> {
  const sweepResult = await sweepRunIfDead(runId, row);
  return sweepResult.row;
}
