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
import type { GlmAbAssignmentRecord } from "../src/redis/autopilot.ts";

// The label vocabulary under test, resolved once from the board-labels leaf so a
// rename is a one-constant edit, not a parallel edit here.
const RFA = ORCH_BOARD_LABELS.ready_for_agent;
const GLM_ELIGIBLE = ORCH_BOARD_LABELS.glm_eligible;
const GLM_WITHHOLD = ORCH_BOARD_LABELS.glm_withhold;
const TARGET_BACKLOG = ORCH_BOARD_LABELS.target_backlog;
const GLM_AB_CONTROL = ORCH_BOARD_LABELS.glm_ab_control;

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

/**
 * Deterministic A/B deps for wiring tests that predate issue #4125: an absent
 * assignment-log lookup, a successful log write, and `controlFraction: 0` so
 * every candidate resolves to TREATMENT — byte-identical to pre-#4125
 * behaviour (the issue's own acceptance criterion). Individual tests override
 * whichever field they're exercising.
 */
function cleanAbDeps(): Pick<
  GlmEligibilitySweepDeps,
  "getGlmAbAssignment" | "recordGlmAbAssignment" | "controlFraction" | "random"
> {
  return {
    getGlmAbAssignment: async () => ({
      alreadyAssigned: false,
      record: null,
      reason: "absent",
    }),
    recordGlmAbAssignment: async () => ({ ok: true }),
    controlFraction: 0,
    random: () => 0.999,
  };
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

  test("skipped: carries glm-ab-control (issue #4124, the A/B control-arm marker)", () => {
    // Load-bearing case (#4124): without this skip, the sweep re-applies
    // glm-eligible to a control issue on the very next tick and the
    // experiment silently loses its control group.
    assert.equal(isGlmEligibleCandidate(row(9, [RFA, GLM_AB_CONTROL])), false);
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
      ...cleanAbDeps(),
      listOpenIssues: async () =>
        okBoard([
          row(11, [RFA]), // eligible
          row(12, [RFA, GLM_ELIGIBLE]), // already labelled -> skip
          row(13, [RFA, GLM_WITHHOLD]), // withheld -> skip
          row(14, [RFA, TARGET_BACKLOG]), // target routing -> skip
          row(15, [RFA]), // eligible
          row(16, []), // no ready-for-agent -> skip
          row(17, [RFA, GLM_AB_CONTROL]), // A/B control arm -> skip
        ]),
      addIssueLabel: async (n, label) => {
        assert.equal(
          label,
          GLM_ELIGIBLE,
          "with controlFraction 0, the only label ever written is glm-eligible",
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
      ...cleanAbDeps(),
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
      ...cleanAbDeps(),
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

// ---------------------------------------------------------------------------
// runGlmEligibilitySweep — randomized A/B arm assignment (issue #4125)
// ---------------------------------------------------------------------------

describe("glm-eligibility-sweep — A/B arm assignment (issue #4125)", () => {
  test("controlFraction 0 => every candidate resolves to treatment (byte-identical to pre-#4125)", async () => {
    const applied: Array<{ issue: number; label: string }> = [];
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      controlFraction: 0,
      random: () => 0, // even the lowest possible roll must still be treatment at fraction 0
      listOpenIssues: async () => okBoard([row(101, [RFA]), row(102, [RFA])]),
      addIssueLabel: async (n, label) => {
        applied.push({ issue: n, label });
        return { ok: true };
      },
    });

    assert.equal(count, 2);
    assert.deepEqual(applied, [
      { issue: 101, label: GLM_ELIGIBLE },
      { issue: 102, label: GLM_ELIGIBLE },
    ]);
  });

  test("controlFraction 1 => every candidate resolves to control", async () => {
    const applied: Array<{ issue: number; label: string }> = [];
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      controlFraction: 1,
      random: () => 0.999, // even the highest possible roll must still be control at fraction 1
      listOpenIssues: async () => okBoard([row(111, [RFA]), row(112, [RFA])]),
      addIssueLabel: async (n, label) => {
        applied.push({ issue: n, label });
        return { ok: true };
      },
    });

    assert.equal(count, 2);
    assert.deepEqual(applied, [
      { issue: 111, label: GLM_AB_CONTROL },
      { issue: 112, label: GLM_AB_CONTROL },
    ]);
  });

  test("both branches of the coin flip are deterministically pinned by an injected randomness source", async () => {
    const applied: Array<{ issue: number; label: string }> = [];
    const rolls: Record<number, number> = { 121: 0.1, 122: 0.9 }; // fraction 0.5: 121 -> control, 122 -> treatment
    let current = 0;
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      controlFraction: 0.5,
      random: () => {
        current += 1;
        return current === 1 ? rolls[121] : rolls[122];
      },
      listOpenIssues: async () => okBoard([row(121, [RFA]), row(122, [RFA])]),
      addIssueLabel: async (n, label) => {
        applied.push({ issue: n, label });
        return { ok: true };
      },
    });

    assert.equal(count, 2);
    assert.deepEqual(applied, [
      { issue: 121, label: GLM_AB_CONTROL },
      { issue: 122, label: GLM_ELIGIBLE },
    ]);
  });

  test("a row already present in the assignment log (label write previously failed) is never re-flipped", async () => {
    const flipped: number[] = [];
    const applied: Array<{ issue: number; label: string }> = [];
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      random: () => {
        flipped.push(Date.now());
        return 0.1;
      },
      getGlmAbAssignment: async (issue) =>
        issue === 131
          ? {
              alreadyAssigned: true,
              record: {
                issue: 131,
                arm: "control",
                assignedAt: "2026-08-01T00:00:00.000Z",
                sweepRunId: "prior-run",
              },
              reason: "found",
            }
          : { alreadyAssigned: false, record: null, reason: "absent" },
      recordGlmAbAssignment: async () => ({ ok: true }),
      listOpenIssues: async () => okBoard([row(131, [RFA]), row(132, [RFA])]),
      addIssueLabel: async (n, label) => {
        applied.push({ issue: n, label });
        return { ok: true };
      },
    });

    assert.equal(count, 1, "only the un-logged row is labelled this tick");
    assert.deepEqual(
      applied,
      [{ issue: 132, label: GLM_ELIGIBLE }],
      "issue 131 already has a log record and is never coin-flipped or labelled again",
    );
    assert.equal(flipped.length, 1, "the coin was only flipped for the un-logged row");
  });

  test("an unreadable assignment-log lookup is treated as already-assigned (fail-closed, under-labelling not double-flip)", async () => {
    const applied: Array<{ issue: number; label: string }> = [];
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      getGlmAbAssignment: async () => ({
        alreadyAssigned: true,
        record: null,
        reason: "unreadable",
      }),
      listOpenIssues: async () => okBoard([row(141, [RFA])]),
      addIssueLabel: async (n, label) => {
        applied.push({ issue: n, label });
        return { ok: true };
      },
    });

    assert.equal(count, 0);
    assert.deepEqual(applied, [], "an unreadable lookup blocks the flip and the label entirely");
  });

  test("fail-closed: a failed assignment-log write blocks the label write for that row (no re-assignment risk)", async () => {
    const applied: Array<{ issue: number; label: string }> = [];
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      recordGlmAbAssignment: async (record) =>
        record.issue === 151
          ? { ok: false, code: "glm-ab-assignment-write-failed", message: "redis down" }
          : { ok: true },
      listOpenIssues: async () => okBoard([row(151, [RFA]), row(152, [RFA])]),
      addIssueLabel: async (n, label) => {
        applied.push({ issue: n, label });
        return { ok: true };
      },
    });

    assert.equal(count, 1, "only the successfully-logged row is labelled");
    assert.deepEqual(
      applied,
      [{ issue: 152, label: GLM_ELIGIBLE }],
      "issue 151's log write failed, so NEITHER label was applied to it",
    );
  });

  test("the assignment log is written BEFORE the label (log-then-label ordering)", async () => {
    const order: string[] = [];
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      recordGlmAbAssignment: async () => {
        order.push("log");
        return { ok: true };
      },
      listOpenIssues: async () => okBoard([row(161, [RFA])]),
      addIssueLabel: async () => {
        order.push("label");
        return { ok: true };
      },
    });

    assert.equal(count, 1);
    assert.deepEqual(order, ["log", "label"], "the assignment-log write precedes the label write");
  });

  test("each assignment record carries the issue, resolved arm, an ISO8601 timestamp, and the sweep run id", async () => {
    const records: GlmAbAssignmentRecord[] = [];
    const count = await runGlmEligibilitySweep({
      ...cleanAbDeps(),
      controlFraction: 1,
      nowIso: () => "2026-08-28T00:00:00.000Z",
      sweepRunId: "sweep-run-42",
      recordGlmAbAssignment: async (record) => {
        records.push(record);
        return { ok: true };
      },
      listOpenIssues: async () => okBoard([row(171, [RFA])]),
      addIssueLabel: async () => ({ ok: true }),
    });

    assert.equal(count, 1);
    assert.deepEqual(records, [
      {
        issue: 171,
        arm: "control",
        assignedAt: "2026-08-28T00:00:00.000Z",
        sweepRunId: "sweep-run-42",
      },
    ]);
  });
});
