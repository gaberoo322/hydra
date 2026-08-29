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
 * ## A/B arm assignment (issue #4125, ADR-0032 slice beta)
 *
 * This is the single well-defined entry point into the glm-eligible
 * population (see module docstring above), so it is also where the A/B coin
 * flip happens — gated by TWO independent guards, not one:
 *
 *   (a) the pre-existing label predicate (`isGlmEligibleCandidate`,
 *       unchanged from #4124) — a row already carrying `glm-eligible` or
 *       `glm-ab-control` never reaches this section at all; and
 *   (b) a lookup against the durable assignment log via
 *       {@link getGlmAbAssignment} (`src/redis/autopilot.ts`) — closes the
 *       crash window between a successful log write and a subsequently
 *       failed label write, where guard (a) alone would let the row be
 *       coin-flipped a SECOND time.
 *
 * Sequencing per candidate: LOOKUP first, then (only if absent) ROLL, then
 * LOG-WRITE, then LABEL-WRITE — each gated on the previous step's success:
 *
 *   1. `getGlmAbAssignment(issue)`. A read FAILURE is treated the SAME as
 *      "already assigned" — skip this issue entirely this tick (no roll, no
 *      write); the safe failure direction is under-labelling, never a
 *      possible double coin flip.
 *   2. A record FOUND (the crash-window case) is left UNTOUCHED this tick —
 *      no re-roll, and deliberately NO auto-repair of the missing label
 *      either (that was considered and rejected as unrequested scope; see
 *      the design-concept artifact's rejectedAlternatives). It is a rare,
 *      logged, non-corrupting edge case, not something this slice repairs.
 *   3. Absent a record: roll the arm and durably log it via
 *      {@link recordGlmAbAssignment} BEFORE writing either label. A log
 *      write FAILURE is fail-closed: NEITHER label is applied this tick, and
 *      the issue is retried from scratch (fresh lookup, fresh roll) next
 *      tick since it is still a bare `isGlmEligibleCandidate` match with no
 *      durable record.
 *   4. Only once the log write succeeds does the sweep write the
 *      corresponding label (`glm-ab-control` for control, the pre-existing
 *      `glm-eligible` for treatment).
 *
 * The ramp fraction (`getGlmAbAssignmentFraction`, `src/cost/config.ts`) is
 * the probability of the CONTROL arm; at the default 0.5 roughly half of
 * newly-eligible issues go to each arm. At fraction 0, `random() < 0` can
 * never be true (both `Math.random()` and any well-behaved injected
 * generator return a value in `[0, 1)`), so every issue is treatment —
 * byte-identical to pre-#4125 behaviour.
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
  isGlmAbAssignmentReadFailure,
  isGlmAbAssignmentWriteFailure,
  type GlmAbArm,
  type GlmAbAssignmentRecord,
} from "../../redis/autopilot.ts";
import { getGlmAbAssignmentFraction } from "../../cost/config.ts";

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
   * Look up whether an issue already has a durable GLM A/B assignment — the
   * READ-path guard (issue #4125). Defaults to the seam's
   * `getGlmAbAssignment` (`src/redis/autopilot.ts`).
   */
  getGlmAbAssignment?: typeof getGlmAbAssignment;
  /**
   * Durably record a GLM A/B arm assignment — the WRITE-path guard (issue
   * #4125). Defaults to the seam's `recordGlmAbAssignment`
   * (`src/redis/autopilot.ts`).
   */
  recordGlmAbAssignment?: typeof recordGlmAbAssignment;
  /**
   * Source of randomness for the per-issue A/B coin flip, injected so tests
   * can pin both branches deterministically (issue #4125 — "no flaky real
   * randomness in the suite"). Must return a value in `[0, 1)`, matching
   * `Math.random()`'s contract. Defaults to `Math.random`.
   */
  random?: () => number;
  /**
   * Wall-clock source for each assignment record's `assignedAt` timestamp,
   * injected for deterministic tests. Defaults to `() => new Date()`.
   */
  now?: () => Date;
  /**
   * Fraction of newly-eligible issues routed to the control arm (issue
   * #4125). Defaults to the seam's `getGlmAbAssignmentFraction`
   * (`src/cost/config.ts`, env `HYDRA_GLM_AB_ASSIGNMENT_FRACTION`).
   */
  getAssignmentFraction?: () => number;
  /**
   * Identifier stamped on every assignment record this sweep run makes.
   * Defaults to a fresh UUID generated once per `runGlmEligibilitySweep`
   * call (issue #4125).
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
 * Run the GLM eligibility sweep chore. For every open `ready-for-agent`
 * orchestrator issue that lacks both `glm-eligible` and `glm-ab-control`
 * (skipping `glm-withhold` / `target-backlog`), rolls an A/B arm, durably
 * logs the assignment (issue #4125), and — only on a successful log write —
 * applies the corresponding label (`glm-eligible` for treatment,
 * `glm-ab-control` for control). Returns the count labelled this tick across
 * both arms (0 when nothing was eligible / on any fault). Never throws.
 *
 * Fail-closed at TWO levels: a board read that fails (`ok:false`) labels
 * NOTHING (unchanged from #3756); and, new in #4125, a per-issue assignment-
 * log write that fails also labels NOTHING for that issue — an unlogged
 * assignment is an unanalysable one, so neither label is guessed. Both
 * failure codes are logged so they are attributable.
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
  const recordAssignment = deps.recordGlmAbAssignment ?? recordGlmAbAssignment;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());
  const getAssignmentFraction = deps.getAssignmentFraction ?? getGlmAbAssignmentFraction;
  // One run ID per sweep invocation, shared across every assignment this
  // tick makes (issue #4125) — not per-issue.
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
        // GUARD (b) — the READ-path lookup (issue #4125). Runs BEFORE any
        // coin flip: guard (a) (isGlmEligibleCandidate, already applied via
        // the `candidates` filter above) only excludes a row carrying a
        // LABEL; this lookup additionally excludes a row that already has a
        // durable log record even if its label write previously failed.
        const lookup = await lookupAssignment(row.number);
        if (isGlmAbAssignmentReadFailure(lookup)) {
          // Fail-closed on the READ path: treat an unreadable lookup the
          // SAME as "already assigned" — skip, never coin-flip. The safe
          // failure direction is under-labelling, never a possible double
          // coin flip.
          logger.error(
            { issue: row.number, code: lookup.code, message: lookup.message },
            "glm-eligibility-sweep: A/B assignment lookup failed; treating as already-assigned (fail-closed, issue #4125)",
          );
          continue;
        }
        if (lookup.record) {
          // Crash-window case: a durable record exists but (since this row
          // still lacks glm-eligible/glm-ab-control per guard (a)) its label
          // write must have failed on a prior tick. Deliberately left
          // UNTOUCHED this tick — no re-roll, no auto-repair of the missing
          // label (an explicitly rejected alternative; see the
          // design-concept artifact). Logged so the gap is visible, not
          // silently repeated.
          logger.info(
            { issue: row.number, arm: lookup.record.arm },
            "glm-eligibility-sweep: assignment already logged without a matching label; leaving untouched this tick (issue #4125)",
          );
          continue;
        }

        // No existing record — safe to roll. `roll < fraction` means
        // fraction 0 can never route to control (Math.random() and any
        // well-behaved injected generator return a value in [0, 1)),
        // preserving byte-identical pre-#4125 behaviour.
        const arm: GlmAbArm = random() < getAssignmentFraction() ? "control" : "treatment";
        const candidate: GlmAbAssignmentRecord = {
          issue: row.number,
          arm,
          assignedAt: now().toISOString(),
          sweepRunId,
        };

        // GUARD (c) — the WRITE-path log, BEFORE either label.
        const logged = await recordAssignment(candidate);
        if (isGlmAbAssignmentWriteFailure(logged)) {
          // Fail-closed on the WRITE path: an unlogged assignment is an
          // unanalysable one. Apply NEITHER label; the issue is still a bare
          // isGlmEligibleCandidate match with no durable record, so it is
          // retried from scratch (fresh lookup, fresh roll) next tick.
          logger.error(
            { issue: row.number, code: logged.code, message: logged.message },
            "glm-eligibility-sweep: A/B assignment log write failed; labelling nothing for this issue (fail-closed, issue #4125)",
          );
          continue;
        }

        const label =
          arm === "control" ? ORCH_BOARD_LABELS.glm_ab_control : ORCH_BOARD_LABELS.glm_eligible;

        const res = await addLabel(row.number, label);
        if (res.ok) {
          labelled++;
        } else if (isIssueLabelWriteFailure(res)) {
          // A single write failure does not abort the sweep. Per guard (b)
          // above, the NEXT tick's lookup will find this issue's now-durable
          // record and leave it untouched (no auto-repair) rather than retry
          // the label — a rare, logged, non-corrupting edge case. Log the
          // code + stderr here so the failure is attributable.
          logger.error(
            { issue: row.number, code: res.code, stderr: res.stderr },
            "glm-eligibility-sweep: label write failed for issue",
          );
        }
      } catch (err: any) {
        // Defense in depth: the real reads/writes never throw, but a fault
        // on ONE issue must not abort the rest. Log with context and continue.
        logger.error(
          { err, issue: row.number },
          "glm-eligibility-sweep: A/B assignment or label step threw for issue",
        );
      }
    }

    // Log the per-run labelled count every tick (issue body) so the beachhead
    // report (#3690) and the operator can see the drainer pool forming.
    logger.info(
      { labelled, candidates: candidates.length },
      "glm-eligibility-sweep: labelled glm-eligible/glm-ab-control issues (issues #3756, #4125)",
    );
    return labelled;
  } catch (err: any) {
    // Defense in depth: the read and the write never throw, but a never-throw
    // chore must not leak an exception even if a dep does. Fail loud, return 0.
    logger.error({ err }, "glm-eligibility-sweep failed");
    return 0;
  }
}
