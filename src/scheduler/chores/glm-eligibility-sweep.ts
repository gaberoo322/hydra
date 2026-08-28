/**
 * GLM eligibility sweep chore (issue #3756, ADR-0032 as amended by #3753).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`). It is the
 * PRODUCER of the `glm-eligible` issue label: #3687 built the consumer half
 * (`deriveBoardState` in `src/autopilot/board-state.ts` and
 * `scripts/autopilot/collect-state.sh` both SUBTRACT a `glm-eligible` issue from
 * the Opus `ready_for_agent` authoring pool), but nothing anywhere APPLIED the
 * label — so a drainer shipped today would wake into a permanently empty queue.
 * This sweep is that missing producer.
 *
 * #3665 first assigned the label to "the Opus brain during its existing
 * triage/labeling pass". That premise is false (see #3753): `ready-for-agent`
 * is stamped from several independent producers with no shared triage
 * chokepoint, so per-producer labelling is opt-in and drifts the moment a new
 * producer appears. Broad opt-out is instead naturally written as "what is
 * missing the label?" — a single periodic sweep that reconciles the open board
 * against that predicate. It is structurally the same job as the sibling
 * `worktree-orphan-prune` chore: periodically reconcile a set against a predicate.
 *
 * Predicate (ADR-0032): label every OPEN orchestrator issue that carries
 * `ready-for-agent` and lacks `glm-eligible`, skipping any issue carrying
 * `glm-withhold` (the sticky opt-out — the brain judges this single issue
 * genuinely needs frontier capability) or `target-backlog` (Target-scope
 * routing, not orchestrator work). The label is written through the seam
 * `addIssueLabel` (`src/github/issues.ts`, issue #3755) — never a direct `gh`
 * shell-out from the chore (github-seam-check forbids it).
 *
 * Fail-closed (issue body): if the board read fails or returns anything the
 * chore cannot fully trust, label NOTHING — never a partial or guessed pass. A
 * down `gh` therefore degrades to "the drainer wakes into a queue that is one
 * tick stale", not to wrongly-labelled issues.
 *
 * Safety of broad labelling (ADR-0032, #3754): this is safe to land broadly
 * because the drainer is not yet heartbeating — its liveness gate is stale, so
 * `deriveBoardState` does NOT subtract `glm-eligible` and Opus keeps seeing the
 * full board. The partition only goes live when the drainer first heartbeats
 * (#3689). This sweep is decoupled from that gate: it labels; #3754's fallback
 * decides whether the label is subtracted — do not couple them.
 *
 * No Redis time-guard: the sweep is intrinsically idempotent (a labelled issue
 * no longer lacks `glm-eligible`, so the next tick skips it), so an hourly tick
 * against an all-labelled set is a guaranteed no-op (mirroring
 * `worktree-orphan-prune` and `wiring-liveness`).
 *
 * NEVER THROWS (CLAUDE.md fail-loud + chore never-throw convention): the board
 * read and the label write both return result objects, and this wrapper
 * additionally try/catches so a fault routes to a logged `0` rather than an
 * exception. Combined with `runChore`'s try/catch in the registry, there is no
 * path by which this chore can abort the housekeeping run.
 *
 * Observability (issue body): the chore logs the count labelled per run "so the
 * beachhead report (#3690) and the operator can see the pool forming",
 * including the candidate pool size for context. A steady-state tick with
 * nothing new to label logs `labelled: 0, candidates: 0`.
 *
 * ## Randomized A/B arm assignment (issue #4125, epic #4123, beta)
 *
 * Once a row passes the (unchanged) `isGlmEligibleCandidate` predicate above,
 * it is no longer unconditionally labelled `glm-eligible`. Instead it is coin-
 * flipped into one of two arms:
 *   - **treatment** (default ~50%, see {@link GlmEligibilitySweepDeps.controlFraction}):
 *     applies `glm-eligible` exactly as before. The drainer picks it up.
 *   - **control** (~50%): applies `glm-ab-control` instead. Per #4124 the
 *     drainer skips it, this sweep's predicate never re-enrolls it, and it
 *     stays in the Opus `ready_for_agent` pool.
 *
 * A SECOND guard, independent of the label-based predicate, prevents
 * re-assignment: before flipping, the sweep looks up the candidate's durable
 * assignment-log record (`getGlmAbAssignment`, `src/redis/autopilot.ts`). A
 * found-or-unreadable lookup means "treat as already assigned" — skip the
 * flip entirely this tick — which closes the crash window where a row's log
 * write succeeded but its label write did not (see ordering below).
 *
 * **Ordering is log-then-label, not label-then-log.** The assignment-log
 * write happens FIRST; the label write is gated on its success. A crash
 * between the two steps must leave the SAFE half undone: if the log write
 * fails, NEITHER label is applied (fail-closed, matching the issue's own
 * invariant) — the row is unlabelled-and-unlogged, which the next tick
 * correctly treats as a first assignment. The reverse ordering would risk a
 * labelled-but-unlogged row, which is unanalysable and can never self-heal.
 *
 * The assignment log is the experiment's durable source of truth (label
 * history is mutable and lossy — an operator or another chore can add/remove
 * labels later), and its per-issue record shape is designed to be read
 * directly by a downstream per-arm analysis (siblings #4126 gamma, #4127
 * delta) without re-deriving arms from label history.
 */

import { randomUUID } from "node:crypto";

import { logger } from "../../logger.ts";
import { ORCH_BOARD_LABELS } from "../../board-labels.ts";
import {
  addIssueLabel,
  listOpenIssues,
  isIssueReadFailure,
  isIssueLabelWriteFailure,
  type IssueReadResult,
  type IssueRow,
} from "../../github/issues.ts";
import {
  getGlmAbAssignment,
  recordGlmAbAssignment,
  isGlmAbAssignmentWriteFailure,
  type GlmAbArm,
} from "../../redis/autopilot.ts";
import { getGlmAbControlFraction } from "../../cost/index.ts";

/**
 * External touchpoints of the GLM eligibility sweep, injected so the chore is
 * unit-testable without spawning a real `gh`. In production every dep defaults
 * to the live seam (`src/github/issues.ts`, issue #3755): the read
 * `listOpenIssues` (one `gh issue list --state open` fetch, each row carrying
 * its full label set) and the write `addIssueLabel` (the ONE narrow
 * issue-mutation surface — add one label to one issue). Exposing them here also
 * turns the Module's Interface into an honest statement of what the chore
 * depends on externally.
 */
export interface GlmEligibilitySweepDeps {
  /** Read the open orchestrator board. Defaults to the seam's `listOpenIssues`. */
  listOpenIssues?: typeof listOpenIssues;
  /** Add one label to one issue. Defaults to the seam's `addIssueLabel`. */
  addIssueLabel?: typeof addIssueLabel;
  /**
   * Look up a candidate's durable A/B assignment-log record (issue #4125).
   * Defaults to the seam's `getGlmAbAssignment` (`src/redis/autopilot.ts`).
   */
  getGlmAbAssignment?: typeof getGlmAbAssignment;
  /**
   * Durably record a new A/B assignment (issue #4125). Defaults to the
   * seam's `recordGlmAbAssignment` (`src/redis/autopilot.ts`).
   */
  recordGlmAbAssignment?: typeof recordGlmAbAssignment;
  /**
   * Randomness source for the coin flip, uniform on `[0, 1)`. Defaults to
   * `Math.random`. Injectable so both arms are deterministically pinned by
   * tests (issue #4125 acceptance criterion: "no flaky real randomness in
   * the suite") — never called bare inline elsewhere in this module.
   */
  random?: () => number;
  /**
   * Control-arm assignment fraction in `[0, 1]`. Defaults to the live config
   * reader `getGlmAbControlFraction` (`src/cost/index.ts`, ramp default 0.5).
   * A roll below this fraction resolves to the CONTROL arm; fraction 0 means
   * every candidate resolves to TREATMENT — byte-identical to pre-#4125
   * behaviour.
   */
  controlFraction?: number;
  /** Returns the current instant as an ISO8601 string. Defaults to `() => new Date().toISOString()`; injectable for deterministic assignment-log timestamps in tests. */
  nowIso?: () => string;
  /**
   * Identifier for this sweep invocation, stamped on every assignment-log
   * record written during this run. Defaults to `randomUUID()`; injectable
   * so tests can assert the exact value written.
   */
  sweepRunId?: string;
}

/**
 * The eligibility predicate (ADR-0032, extended by issue #4124): true for an
 * issue that carries `ready-for-agent`, lacks `glm-eligible`, and carries
 * NONE of `glm-withhold` / `target-backlog` / `glm-ab-control`. Pure (no I/O)
 * so the predicate — including all skip labels — is pinned directly by a
 * unit test.
 *
 * `glm-ab-control` (issue #4124) is the LOAD-BEARING site for the A/B control
 * arm: without this skip, the sweep re-applies `glm-eligible` to a control
 * issue on the very next hourly tick and the experiment silently loses its
 * control group. Its routing effect is deliberately identical to
 * `glm-withhold`'s, even though the two labels mean different things (see
 * `ORCH_BOARD_LABELS.glm_ab_control`'s doc comment in `board-labels.ts`).
 *
 * The OPEN-ness precondition is satisfied by the caller reading the OPEN board
 * (`listOpenIssues` defaults to `--state open`); this predicate concerns itself
 * only with the label vocabulary, exactly as the issue's pinned predicate states.
 */
export function isGlmEligibleCandidate(row: IssueRow): boolean {
  const labels = new Set(row.labels);
  if (!labels.has(ORCH_BOARD_LABELS.ready_for_agent)) return false;
  if (labels.has(ORCH_BOARD_LABELS.glm_eligible)) return false;
  if (labels.has(ORCH_BOARD_LABELS.glm_withhold)) return false;
  if (labels.has(ORCH_BOARD_LABELS.target_backlog)) return false;
  if (labels.has(ORCH_BOARD_LABELS.glm_ab_control)) return false;
  return true;
}

/**
 * Resolve a coin-flip roll to an arm. `roll` is uniform on `[0, 1)`;
 * `controlFraction` gates the CONTROL share (issue #4125 Ramp): a roll below
 * the fraction resolves to control, so fraction 0 makes "roll < 0" never
 * true and every candidate resolves to treatment — byte-identical to
 * pre-#4125 behaviour. Pure so the ramp math is unit-testable without a real
 * randomness source.
 */
function resolveArm(roll: number, controlFraction: number): GlmAbArm {
  return roll < controlFraction ? "control" : "treatment";
}

/**
 * Run the GLM eligibility sweep chore. For every open `ready-for-agent`
 * orchestrator issue that lacks `glm-eligible` (skipping `glm-withhold` /
 * `target-backlog` / `glm-ab-control`, and any row already carrying a durable
 * assignment-log record), coin-flips it into the treatment (`glm-eligible`)
 * or control (`glm-ab-control`) arm, durably logs the assignment, and only
 * then applies the corresponding label (issue #4125). Returns the count of
 * issues LABELLED this tick — either arm — (0 when nothing was eligible / on
 * any fault). Never throws.
 *
 * Fail-closed: a board read that fails (`ok:false`) labels NOTHING — never a
 * partial or guessed pass; the failure code is logged so it is attributable.
 * Per-issue, an unreadable/erroring assignment-log lookup is treated as
 * "already assigned" (skip the flip) and a failed assignment-log write blocks
 * the label write for that row entirely — see the module docstring's
 * "Randomized A/B arm assignment" section for the full ordering rationale.
 *
 * A per-issue label-write failure (or a throw) is logged and does NOT abort the
 * remaining issues: the sweep is idempotent, so an unlabelled issue is retried
 * on the next tick, and only successfully-written labels count toward the return.
 *
 * Returns the labelled count so the registry / a test can observe whether the
 * chore did work this invocation, and logs it every run so the beachhead report
 * (#3690) and the operator can watch the drainer queue form.
 */
export async function runGlmEligibilitySweep(
  deps: GlmEligibilitySweepDeps = {},
): Promise<number> {
  const readBoard = deps.listOpenIssues ?? listOpenIssues;
  const addLabel = deps.addIssueLabel ?? addIssueLabel;
  const lookupAssignment = deps.getGlmAbAssignment ?? getGlmAbAssignment;
  const writeAssignment = deps.recordGlmAbAssignment ?? recordGlmAbAssignment;
  const random = deps.random ?? Math.random;
  const controlFraction = deps.controlFraction ?? getGlmAbControlFraction();
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const sweepRunId = deps.sweepRunId ?? randomUUID();

  try {
    const board: IssueReadResult<IssueRow> = await readBoard();
    // Fail-closed: an unreadable board labels nothing — not a partial pass, not
    // a guess. Log the code so the failure is attributable; return 0.
    if (isIssueReadFailure(board)) {
      logger.error(
        { code: board.code },
        "glm-eligibility-sweep: board read failed; labelling nothing (fail-closed, issue #3756)",
      );
      return 0;
    }

    const candidates = board.rows.filter(isGlmEligibleCandidate);

    let labelled = 0;
    for (const row of candidates) {
      try {
        // Second, independent guard (issue #4125): a row already carrying a
        // durable assignment-log record (or an unreadable lookup) is treated
        // as already assigned and never re-flipped — this closes the crash
        // window between a successful log write and a subsequently failed
        // label write that the label-based predicate alone cannot see.
        const lookup = await lookupAssignment(row.number);
        if (lookup.alreadyAssigned) {
          continue;
        }

        const arm = resolveArm(random(), controlFraction);
        const label =
          arm === "control"
            ? ORCH_BOARD_LABELS.glm_ab_control
            : ORCH_BOARD_LABELS.glm_eligible;

        // Log-then-label (issue #4125): the assignment-log write happens
        // FIRST and the label write is gated on its success, so a crash
        // between the two steps leaves only the label missing — a
        // detectable, non-corrupting edge case — rather than a
        // labelled-but-unlogged, unanalysable one.
        const logRes = await writeAssignment({
          issue: row.number,
          arm,
          assignedAt: nowIso(),
          sweepRunId,
        });
        if (isGlmAbAssignmentWriteFailure(logRes)) {
          logger.error(
            { issue: row.number, code: logRes.code, message: logRes.message },
            "glm-eligibility-sweep: assignment-log write failed; not labelling this tick (fail-closed, issue #4125)",
          );
          continue;
        }

        const res = await addLabel(row.number, label);
        if (res.ok) {
          labelled++;
        } else if (isIssueLabelWriteFailure(res)) {
          // A single write failure does not abort the sweep — the sweep is
          // idempotent, so an unlabelled issue is retried on the next tick. Log
          // the code + stderr so the failure is attributable.
          logger.error(
            { issue: row.number, code: res.code, stderr: res.stderr },
            "glm-eligibility-sweep: label write failed for issue",
          );
        }
      } catch (err: any) {
        // Defense in depth: the real read/write never throw, but a fault on
        // ONE issue must not abort the rest. Log with context and continue.
        logger.error(
          { err, issue: row.number },
          "glm-eligibility-sweep: assignment/label write threw for issue",
        );
      }
    }

    // Log the per-run labelled count every tick (issue body) so the beachhead
    // report (#3690) and the operator can see the drainer pool forming.
    logger.info(
      { labelled, candidates: candidates.length, sweepRunId },
      "glm-eligibility-sweep: labelled glm-eligible/glm-ab-control issues (issue #3756, #4125)",
    );
    return labelled;
  } catch (err: any) {
    // Defense in depth: the read and the write never throw, but a never-throw
    // chore must not leak an exception even if a dep does. Fail loud, return 0.
    logger.error({ err }, "glm-eligibility-sweep failed");
    return 0;
  }
}
