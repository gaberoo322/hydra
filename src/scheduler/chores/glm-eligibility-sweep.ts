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
 */

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
}

/**
 * The eligibility predicate (ADR-0032): true for an issue that carries
 * `ready-for-agent`, lacks `glm-eligible`, and carries NEITHER `glm-withhold`
 * NOR `target-backlog`. Pure (no I/O) so the predicate — including both skip
 * labels — is pinned directly by a unit test.
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
  return true;
}

/**
 * Run the GLM eligibility sweep chore. Labels every open `ready-for-agent`
 * orchestrator issue that lacks `glm-eligible` (skipping `glm-withhold` /
 * `target-backlog`) and returns the count labelled this tick (0 when nothing was
 * eligible / on any fault). Never throws.
 *
 * Fail-closed: a board read that fails (`ok:false`) labels NOTHING — never a
 * partial or guessed pass; the failure code is logged so it is attributable.
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
        const res = await addLabel(row.number, ORCH_BOARD_LABELS.glm_eligible);
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
        // Defense in depth: the real write never throws, but a fault on ONE
        // issue must not abort the rest. Log with context and continue.
        logger.error(
          { err, issue: row.number },
          "glm-eligibility-sweep: label write threw for issue",
        );
      }
    }

    // Log the per-run labelled count every tick (issue body) so the beachhead
    // report (#3690) and the operator can see the drainer pool forming.
    logger.info(
      { labelled, candidates: candidates.length },
      "glm-eligibility-sweep: labelled glm-eligible issues (issue #3756)",
    );
    return labelled;
  } catch (err: any) {
    // Defense in depth: the read and the write never throw, but a never-throw
    // chore must not leak an exception even if a dep does. Fail loud, return 0.
    logger.error({ err }, "glm-eligibility-sweep failed");
    return 0;
  }
}
