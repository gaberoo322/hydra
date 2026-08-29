/**
 * Isolated unit coverage for the GLM eligibility sweep housekeeping chore
 * (issue #3756, ADR-0032; A/B arm assignment added by issue #4125).
 *
 * The chore is a thin scheduled wrapper over the read seam (`listOpenIssues`),
 * the write seam (`addIssueLabel`, #3755), and — since #4125 — the durable
 * assignment-log seam (`recordGlmAbAssignment`, `src/redis/autopilot.ts`).
 * These cases pin the chore's contract in isolation — no live `gh`, no Redis
 * — by injecting fakes and asserting the predicate, the wiring (only eligible
 * issues are labelled, in board order), the fail-closed rules, the A/B coin
 * flip (both branches via injected randomness), the assign-once invariant,
 * and the never-throw guard.
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
import type {
  GlmAbAssignmentRecord,
  RecordGlmAbAssignmentResult,
} from "../src/redis/autopilot.ts";

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
 * A no-op assignment-log fake: always plants the caller's speculative record
 * as-is (mirrors a fresh `HSETNX` success). Used by every pre-#4125 wiring
 * case below so they exercise the label-writing plumbing without touching
 * Redis, while still going through the real A/B branch.
 */
const alwaysFreshAssignment = async (
  record: GlmAbAssignmentRecord,
): Promise<RecordGlmAbAssignmentResult> => ({
  ok: true,
  record,
  alreadyAssigned: false,
});

/**
 * Deterministic "always treatment" fixture (issue #4125): `random` returns a
 * value the coin flip can never route to control regardless of the
 * assignment fraction, so cases that predate the A/B split keep asserting
 * exactly one label (`glm-eligible`) without depending on real randomness or
 * a live Redis connection.
 */
function alwaysTreatmentDeps(): Pick<
  GlmEligibilitySweepDeps,
  "random" | "getAssignmentFraction" | "recordGlmAbAssignment" | "now" | "sweepRunId"
> {
  return {
    random: () => 1, // 1 < fraction is never true for fraction in [0, 1]
    getAssignmentFraction: () => 0.5,
    recordGlmAbAssignment: alwaysFreshAssignment,
    now: () => new Date("2026-08-29T00:00:00.000Z"),
    sweepRunId: "test-sweep-run",
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
      ...alwaysTreatmentDeps(),
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
          "with the always-treatment fixture, the only label ever written is glm-eligible",
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
      ...alwaysTreatmentDeps(),
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
      ...alwaysTreatmentDeps(),
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
      ...alwaysTreatmentDeps(),
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
      ...alwaysTreatmentDeps(),
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
      ...alwaysTreatmentDeps(),
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
// runGlmEligibilitySweep — A/B arm assignment + durable log (issue #4125)
// ---------------------------------------------------------------------------

describe("glm-eligibility-sweep — A/B arm assignment (issue #4125)", () => {
  test("both branches of the coin flip route to the matching label, via injected randomness", async () => {
    const labelsByIssue = new Map<number, string>();
    const loggedArms: Array<{ issue: number; arm: string; sweepRunId: string }> = [];

    const deps: GlmEligibilitySweepDeps = {
      listOpenIssues: async () => okBoard([row(101, [RFA]), row(102, [RFA])]),
      // roll < fraction -> control; fraction is fixed at 0.5 below.
      random: (() => {
        const rolls = [0.1, 0.9]; // issue 101 -> control, issue 102 -> treatment
        let i = 0;
        return () => rolls[i++];
      })(),
      getAssignmentFraction: () => 0.5,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      sweepRunId: "run-both-branches",
      recordGlmAbAssignment: async (record) => {
        loggedArms.push({
          issue: record.issue,
          arm: record.arm,
          sweepRunId: record.sweepRunId,
        });
        return { ok: true, record, alreadyAssigned: false };
      },
      addIssueLabel: async (n, label) => {
        labelsByIssue.set(n, label);
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(count, 2);
    assert.equal(labelsByIssue.get(101), GLM_AB_CONTROL, "roll 0.1 < 0.5 -> control arm");
    assert.equal(labelsByIssue.get(102), GLM_ELIGIBLE, "roll 0.9 >= 0.5 -> treatment arm");
    assert.deepEqual(
      loggedArms,
      [
        { issue: 101, arm: "control", sweepRunId: "run-both-branches" },
        { issue: 102, arm: "treatment", sweepRunId: "run-both-branches" },
      ],
      "one durable record per assignment, carrying issue/arm/sweepRunId",
    );
  });

  test("fraction 0 is byte-identical to pre-#4125 behaviour: every issue is treatment", async () => {
    const labels: string[] = [];
    const deps: GlmEligibilitySweepDeps = {
      listOpenIssues: async () => okBoard([row(111, [RFA]), row(112, [RFA])]),
      // Even a roll of exactly 0 must not route to control when fraction is 0.
      random: () => 0,
      getAssignmentFraction: () => 0,
      recordGlmAbAssignment: alwaysFreshAssignment,
      addIssueLabel: async (_n, label) => {
        labels.push(label);
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(count, 2);
    assert.deepEqual(labels, [GLM_ELIGIBLE, GLM_ELIGIBLE], "fraction 0 -> everything treatment");
  });

  test("assign-once: an issue already present in the assignment log is retried with the LOGGED arm, never re-randomised", async () => {
    // Simulate a prior tick that logged this issue as "control" but whose
    // label write then failed — so the issue is still a bare
    // isGlmEligibleCandidate match this tick.
    const existingRecord: GlmAbAssignmentRecord = {
      issue: 121,
      arm: "control",
      assignedAt: "2026-08-28T00:00:00.000Z",
      sweepRunId: "prior-run",
    };

    let recordCalls = 0;
    const deps: GlmEligibilitySweepDeps = {
      listOpenIssues: async () => okBoard([row(121, [RFA])]),
      // Rig the fresh roll to say "treatment" — if the sweep used this
      // instead of the logged record, the assertion below would catch it.
      random: () => 0.999,
      getAssignmentFraction: () => 0.5,
      recordGlmAbAssignment: async (candidate) => {
        recordCalls++;
        assert.equal(candidate.arm, "treatment", "the speculative roll is still treatment");
        // HSETNX-style: report the pre-existing record, ignoring the candidate.
        return { ok: true, record: existingRecord, alreadyAssigned: true };
      },
      addIssueLabel: async (n, label) => {
        assert.equal(n, 121);
        assert.equal(
          label,
          GLM_AB_CONTROL,
          "the label matches the LOGGED arm (control), not the fresh roll (treatment)",
        );
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(recordCalls, 1);
    assert.equal(count, 1);
  });

  test("fail-closed: a failed assignment-log write applies NEITHER label", async () => {
    let labelWrites = 0;
    const deps: GlmEligibilitySweepDeps = {
      ...alwaysTreatmentDeps(),
      listOpenIssues: async () => okBoard([row(131, [RFA])]),
      recordGlmAbAssignment: async () => ({
        ok: false,
        code: "glm-ab-assignment-write-failed",
        message: "redis unavailable",
      }),
      addIssueLabel: async () => {
        labelWrites++;
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(count, 0);
    assert.equal(labelWrites, 0, "no label is written when the assignment log write failed");
  });

  test("fail-closed does not abort the rest of the board: other issues still get assigned + labelled", async () => {
    const labelled: number[] = [];
    const deps: GlmEligibilitySweepDeps = {
      ...alwaysTreatmentDeps(),
      listOpenIssues: async () =>
        okBoard([row(141, [RFA]), row(142, [RFA]), row(143, [RFA])]),
      recordGlmAbAssignment: async (record) => {
        if (record.issue === 142) {
          return {
            ok: false,
            code: "glm-ab-assignment-write-failed",
            message: "transient redis error",
          };
        }
        return { ok: true, record, alreadyAssigned: false };
      },
      addIssueLabel: async (n) => {
        labelled.push(n);
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.deepEqual(labelled, [141, 143], "issue 142's failed log write skips only issue 142");
    assert.equal(count, 2);
  });

  test("glm-withhold enters neither arm: no assignment-log call and no label write", async () => {
    let recordCalls = 0;
    let labelWrites = 0;
    const deps: GlmEligibilitySweepDeps = {
      ...alwaysTreatmentDeps(),
      listOpenIssues: async () => okBoard([row(151, [RFA, GLM_WITHHOLD])]),
      recordGlmAbAssignment: async (record) => {
        recordCalls++;
        return { ok: true, record, alreadyAssigned: false };
      },
      addIssueLabel: async () => {
        labelWrites++;
        return { ok: true };
      },
    };

    const count = await runGlmEligibilitySweep(deps);

    assert.equal(count, 0);
    assert.equal(recordCalls, 0, "the withheld issue never reaches the coin flip");
    assert.equal(labelWrites, 0);
  });
});
