/**
 * Isolated unit coverage for the GLM eligibility sweep housekeeping chore
 * (issue #3756, ADR-0032).
 *
 * The chore is a thin scheduled wrapper over the read seam (`listOpenIssues`)
 * and the write seam (`addIssueLabel`, #3755). These cases pin the chore's
 * contract in isolation — no live `gh`, no Redis — by injecting fakes and
 * asserting the predicate, the wiring (only eligible issues are labelled, in
 * board order), the fail-closed rule, and the never-throw guard.
 *
 * Top-level describes with no shared-Redis lifecycle: the chore takes every
 * side-effecting dependency through its injectable deps bag, so nothing here
 * touches a shared connection.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runGlmEligibilitySweep,
  isGlmEligibleCandidate,
  type GlmEligibilitySweepDeps,
} from "../src/scheduler/chores/glm-eligibility-sweep.ts";
import { ORCH_BOARD_LABELS } from "../src/board-labels.ts";
import type { IssueRow, IssueReadResult } from "../src/github/issues.ts";

// The label vocabulary under test, resolved once from the board-labels leaf so a
// rename is a one-constant edit, not a parallel edit here.
const RFA = ORCH_BOARD_LABELS.ready_for_agent;
const GLM_ELIGIBLE = ORCH_BOARD_LABELS.glm_eligible;
const GLM_WITHHOLD = ORCH_BOARD_LABELS.glm_withhold;
const TARGET_BACKLOG = ORCH_BOARD_LABELS.target_backlog;

/** Build an IssueRow with sane defaults; override what the case cares about. */
function row(number: number, labels: string[]): IssueRow {
  return {
    number,
    title: `Issue #${number}`,
    url: `https://github.com/gaberoo322/hydra/issues/${number}`,
    createdAt: "",
    labels,
    body: "",
    state: "OPEN",
  };
}

/** Success-arm board read fixture. */
function okBoard(rows: IssueRow[]): IssueReadResult<IssueRow> {
  return { ok: true, rows };
}

/** Failure-arm board read fixture (the fail-closed trigger). */
function failedBoard(): IssueReadResult<IssueRow> {
  return { ok: false, code: "gh-failed" };
}

// ---------------------------------------------------------------------------
// isGlmEligibleCandidate — the pure predicate (covers both skip labels)
// ---------------------------------------------------------------------------

describe("glm-eligibility-sweep — predicate (issue #3756)", () => {
  test("eligible: ready-for-agent and nothing else", () => {
    assert.equal(isGlmEligibleCandidate(row(1, [RFA])), true);
  });

  test("skipped: already carries glm-eligible", () => {
    assert.equal(isGlmEligibleCandidate(row(2, [RFA, GLM_ELIGIBLE])), false);
  });

  test("skipped: carries glm-withhold (the sticky opt-out)", () => {
    assert.equal(isGlmEligibleCandidate(row(3, [RFA, GLM_WITHHOLD])), false);
  });

  test("skipped: carries target-backlog", () => {
    assert.equal(isGlmEligibleCandidate(row(4, [RFA, TARGET_BACKLOG])), false);
  });

  test("skipped: no ready-for-agent", () => {
    assert.equal(isGlmEligibleCandidate(row(5, [GLM_ELIGIBLE])), false);
    assert.equal(isGlmEligibleCandidate(row(6, [])), false);
  });

  test("skipped: both opt-out labels together", () => {
    assert.equal(isGlmEligibleCandidate(row(7, [RFA, GLM_WITHHOLD, TARGET_BACKLOG])), false);
  });

  test("glm-withhold withholds even when the issue looks otherwise eligible", () => {
    // An issue that is ready-for-agent, lacks glm-eligible, but is withheld —
    // the brain judged it needs frontier capability; the sweep must NOT relabel.
    assert.equal(isGlmEligibleCandidate(row(8, [RFA, GLM_WITHHOLD])), false);
  });
});

// ---------------------------------------------------------------------------
// runGlmEligibilitySweep — the chore wrapper (wiring + fail-closed + never-throw)
// ---------------------------------------------------------------------------

describe("glm-eligibility-sweep — chore wiring (issue #3756)", () => {
  test("labels each eligible issue through the seam addIssueLabel, in board order, and returns the count", async () => {
    const labelled: number[] = [];
    const deps: GlmEligibilitySweepDeps = {
      listOpenIssues: async () =>
        okBoard([
          row(11, [RFA]), // eligible
          row(12, [RFA, GLM_ELIGIBLE]), // already labelled -> skip
          row(13, [RFA, GLM_WITHHOLD]), // withheld -> skip
          row(14, [RFA, TARGET_BACKLOG]), // target routing -> skip
          row(15, [RFA]), // eligible
          row(16, []), // no ready-for-agent -> skip
        ]),
      addIssueLabel: async (n, label) => {
        assert.equal(
          label,
          GLM_ELIGIBLE,
          "the only label ever written is glm-eligible",
        );
        labelled.push(n);
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.deepEqual(
      labelled,
      [11, 15],
      "only the two eligible issues are labelled, in board order",
    );
    assert.equal(count, 2, "the returned count is the number of successful writes");
  });

  test("fail-closed: an unreadable board labels nothing and returns 0", async () => {
    let writes = 0;
    const deps: GlmEligibilitySweepDeps = {
      listOpenIssues: async () => failedBoard(),
      addIssueLabel: async () => {
        writes++;
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(count, 0);
    assert.equal(writes, 0, "no label is written when the board read failed");
  });

  test("a per-issue write failure is skipped, not fatal — successful writes still count", async () => {
    const deps: GlmEligibilitySweepDeps = {
      listOpenIssues: async () =>
        okBoard([row(21, [RFA]), row(22, [RFA]), row(23, [RFA])]),
      addIssueLabel: async (n) => {
        // Issue 22 fails (e.g. transient gh 5xx); the other two succeed.
        if (n === 22) return { ok: false, code: "gh-failed", stderr: "HTTP 500" };
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(
      count,
      2,
      "the two successful writes count; the failed one does not abort the sweep",
    );
  });

  test("never throws — a throwing board read folds to a logged 0", async () => {
    const count = await runGlmEligibilitySweep({
      listOpenIssues: async () => {
        throw new Error("gh blew up");
      },
      addIssueLabel: async () => {
        throw new Error("write must not be reached when the read throws");
      },
    });

    assert.equal(count, 0, "a thrown read fault is caught and returns 0, not propagated");
  });

  test("never throws — a throwing write on one issue does not abort the rest", async () => {
    const labelled: number[] = [];
    const count = await runGlmEligibilitySweep({
      listOpenIssues: async () =>
        okBoard([row(31, [RFA]), row(32, [RFA]), row(33, [RFA])]),
      addIssueLabel: async (n) => {
        if (n === 32) throw new Error("transient");
        labelled.push(n);
        return { ok: true };
      },
    });

    assert.deepEqual(labelled, [31, 33], "the issues around the throwing one still get labelled");
    assert.equal(count, 2, "the two successful writes around the throw count");
  });

  test("an empty eligible board is a no-op that returns 0", async () => {
    let writes = 0;
    const deps: GlmEligibilitySweepDeps = {
      listOpenIssues: async () => okBoard([row(41, [GLM_ELIGIBLE]), row(42, [TARGET_BACKLOG])]),
      addIssueLabel: async () => {
        writes++;
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(count, 0);
    assert.equal(writes, 0, "nothing is labelled when no row is eligible");
  });
});
