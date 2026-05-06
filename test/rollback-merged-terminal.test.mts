/**
 * Regression test for post-merge rollback vs terminal task state (issue #112).
 *
 * Bug: When post-merge regression detection triggered an auto-rollback,
 * post-merge.ts called tracker.transitionTask(taskId, "failed") — but the
 * task had already reached the terminal "merged" state. The task machine
 * correctly rejected this as an illegal transition, leaving rolled-back
 * cycles untracked in the task system with inaccurate metrics.
 *
 * Fix: Skip the task state transition when rolling back a merged task.
 * Record the rollback in metrics only (rolledBack: true, tasksRolledBack: 1)
 * and the prior-failure queue via reportOutcome.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canTransitionTo, isTerminal, TERMINAL_STATES } from "../src/task-machine.ts";

describe("rollback of merged task (issue #112)", () => {
  test("merged is a terminal state", () => {
    assert.ok(isTerminal("merged"), "merged should be terminal");
    assert.ok(TERMINAL_STATES.has("merged"), "TERMINAL_STATES should include merged");
  });

  test("merged → failed is an illegal transition", () => {
    const result = canTransitionTo("merged", "failed");
    assert.strictEqual(result.ok, false, "transition from merged to failed should be rejected");
    assert.ok(
      !result.ok && result.reason.includes("terminal"),
      `rejection reason should mention terminal state, got: ${!result.ok ? result.reason : "ok"}`,
    );
  });

  test("merged has no outbound transitions", () => {
    const states = ["proposed", "approved", "in-progress", "changed-code", "verified", "blocked", "failed", "abandoned"] as const;
    for (const target of states) {
      const result = canTransitionTo("merged", target);
      assert.strictEqual(result.ok, false, `merged → ${target} should be illegal`);
    }
  });

  test("other terminal states also reject transitions", () => {
    for (const terminal of ["failed", "abandoned"] as const) {
      const result = canTransitionTo(terminal, "merged");
      assert.strictEqual(result.ok, false, `${terminal} → merged should be illegal`);
    }
  });
});
