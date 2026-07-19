/**
 * Autopilot **run-lifecycle state machine** — the pure, zero-I/O derivation
 * cluster split out of `run-projections.ts` (issue #3106).
 *
 * `run-projections.ts` mixed two structurally distinct concerns: the
 * Redis-touching **projection coordinator** (`fetchTurnsWithJoins` /
 * `projectRunView` / `projectRunDigest`) and this pure **state-machine
 * cluster**. A caller browsing "where does the autopilot lifecycle state
 * machine live?" now lands here, in a leaf named for it, with no transitive
 * coupling to the projection coordinator's `ProjectionDeps` reader bag.
 *
 * This leaf owns three pure derivations (no Redis, no clock beyond
 * caller-supplied input, no `await`):
 *
 *   - `deriveLifecycleState` — discriminated running/crashed/ended/idle
 *     derivation from a raw run-row hash (#888)
 *   - `summarizeTerminationHealth` — clean-termination-rate rollup over an
 *     already-fetched run-digest array, with the starvation alarm bit
 *     (#1352 / #1815 / #1847)
 *   - `deriveInflightSlotSeed` — pipeline-slot occupancy from the in-flight
 *     subagent dispatch ledger (#1352 Problem A)
 *
 * plus the supporting constants (`WEDGE_AGE_THRESHOLD_S`, the starvation
 * thresholds, `CLEAN_TERM_REASONS`) and types (`AutopilotLifecycle`,
 * `AutopilotLifecycleState`, `InflightSlotSeed`).
 *
 * Follows the `retro-dispatch-classifier.ts` + `retro-dispatch-types.ts`
 * extraction precedent (issue #3090 / PR #3094): pure state-machine logic
 * separated from the I/O coordinator that calls it. `run-projections.ts`
 * imports DOWN from this leaf for the `WEDGE_AGE_THRESHOLD_S` constant it still
 * references and re-exports that constant for the #2125 back-compat migration
 * window; the lifecycle-type re-exports it once carried were retired once every
 * caller migrated to importing them from this leaf directly (issue #3147).
 *
 * The pid-liveness probe defaults to the canonical {@link isLivePid} predicate
 * in the focused `process-probe.ts` leaf (extracted in issue #3503) — the same
 * source the `isPidAlive` alias in `run-projections.ts` re-exports — but
 * `deriveLifecycleState` takes it as an OPTIONAL injectable `pidCheck` param
 * (issue #3503, Invariant 4). Production callers pass a single argument and get
 * the real `kill -0` probe; tests inject a stub predicate, at which point this
 * leaf's zero-I/O claim is literally true (no `process.kill` syscall runs).
 * Importing the OS probe from a process-domain leaf (not a worktree-management
 * module) keeps this reader's cross-module edge conceptually appropriate.
 */

import { classBySkill } from "../taxonomy/classes.ts";
import {
  epochFromIsoOrNow,
  type SubagentDispatch,
} from "../redis/dispatches.ts";
import { isLivePid, type LivePidCheck } from "../process-probe.ts";
import { numberOrDefault } from "./run-result.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Wedge-detection threshold for the read-time projection. Older
 * autopilots that hang past 10 minutes between turns get
 * `wedge_likely: true` on the response. Read-only metadata; no Redis
 * write follows. Consumed by `projectRunView` in `run-projections.ts`
 * (imported DOWN from this leaf).
 */
export const WEDGE_AGE_THRESHOLD_S = 600;

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
 *
 * The `pidCheck` param is the ONE point of impurity — the `kill -0` OS probe.
 * It defaults to the real {@link isLivePid}, so production callers pass a
 * single argument and behave byte-identically; tests inject a deterministic
 * stub predicate (`() => true` / `() => false`) to remove OS pid-recycling
 * flakiness and make the module-header zero-I/O claim literally true. The
 * default keeps every existing single-arg call site (the route layer, the
 * raw projections, `sweep-reader.ts`) unchanged — this is an additive
 * `extend`, not a breaking change (issue #3503, Invariant 4).
 */
export function deriveLifecycleState(
  row: Record<string, string> | null | undefined,
  pidCheck: LivePidCheck = isLivePid,
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
    if (pidCheck(pid)) {
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
// Moved here from `runs.ts` (issue #1964) into `run-projections.ts`, then into
// this pure leaf (issue #3106): `summarizeTerminationHealth` is a pure
// analytical projection over an already-fetched run-digest array (no Redis, no
// clock, no await), so its home is this zero-I/O state-machine leaf, not the
// I/O projection coordinator. Callers import it from here directly (via the
// back-compat re-export relay in `run-projections.ts`, #2125).
// ---------------------------------------------------------------------------

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
// Moved here from `runs.ts` (issue #1993) into `run-projections.ts`, then into
// this pure leaf (issue #3106): `deriveInflightSlotSeed` is a pure function
// over the in-flight subagent dispatch ledger (no Redis, no clock, no await —
// the async `readInflightSlotSeed` wrapper in `run-reads.ts` does the Redis read),
// so its home is this zero-I/O state-machine leaf, not the I/O projection
// coordinator. Callers import both symbols from here directly (via the
// back-compat re-export relay in `run-projections.ts`, #2125).
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
