/**
 * Regression tests for src/task-machine.ts — pure Task state machine.
 *
 * No Redis or I/O required — all functions are pure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  transition,
  canTransitionTo,
  isTerminal,
  TERMINAL_STATES,
  VALID_TARGETS,
} from "../src/task-machine.ts";
import type { TaskState, TaskEvent } from "../src/task-machine.ts";

describe("task-machine transition()", () => {
  // -------------------------------------------------------------------------
  // Valid transitions — every edge in the state machine
  // -------------------------------------------------------------------------

  const validCases: Array<[TaskState, TaskEvent, TaskState]> = [
    ["proposed",      "approve",     "approved"],
    ["proposed",      "abandon",     "abandoned"],
    ["approved",      "start",       "in-progress"],
    ["approved",      "abandon",     "abandoned"],
    ["in-progress",   "change-code", "changed-code"],
    ["in-progress",   "block",       "blocked"],
    ["in-progress",   "fail",        "failed"],
    ["in-progress",   "abandon",     "abandoned"],
    ["changed-code",  "verify",      "verified"],
    ["changed-code",  "fail",        "failed"],
    ["changed-code",  "abandon",     "abandoned"],
    ["verified",      "merge",       "merged"],
    ["verified",      "fail",        "failed"],
    ["blocked",       "unblock",     "approved"],
    ["blocked",       "abandon",     "abandoned"],
  ];

  for (const [from, event, to] of validCases) {
    test(`${from} + ${event} → ${to}`, () => {
      const result = transition(from, event);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.state, to);
    });
  }

  // -------------------------------------------------------------------------
  // Invalid transitions
  // -------------------------------------------------------------------------

  test("double-transition: merged + merge is rejected (terminal re-entry)", () => {
    const result = transition("merged", "merge" as TaskEvent);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /terminal/);
  });

  test("terminal re-entry: failed + fail is rejected", () => {
    const result = transition("failed", "fail" as TaskEvent);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /terminal/);
  });

  test("terminal re-entry: abandoned + abandon is rejected", () => {
    const result = transition("abandoned", "abandon" as TaskEvent);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /terminal/);
  });

  test("skip-ahead: proposed + merge is rejected", () => {
    const result = transition("proposed", "merge" as TaskEvent);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not valid/);
  });

  test("backward: verified + start is rejected", () => {
    const result = transition("verified", "start" as TaskEvent);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not valid/);
  });

  test("wrong event: approved + verify is rejected", () => {
    const result = transition("approved", "verify" as TaskEvent);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not valid/);
  });
});

describe("task-machine canTransitionTo()", () => {
  test("proposed → approved is valid", () => {
    const result = canTransitionTo("proposed", "approved");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.state, "approved");
  });

  test("proposed → merged is rejected (skip-ahead)", () => {
    const result = canTransitionTo("proposed", "merged");
    assert.equal(result.ok, false);
  });

  test("merged → failed is rejected (terminal)", () => {
    const result = canTransitionTo("merged", "failed");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /terminal/);
  });

  test("blocked → approved (unblock path)", () => {
    const result = canTransitionTo("blocked", "approved");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.state, "approved");
  });

  test("in-progress → changed-code", () => {
    const result = canTransitionTo("in-progress", "changed-code");
    assert.equal(result.ok, true);
  });

  test("changed-code → verified", () => {
    const result = canTransitionTo("changed-code", "verified");
    assert.equal(result.ok, true);
  });

  test("verified → merged", () => {
    const result = canTransitionTo("verified", "merged");
    assert.equal(result.ok, true);
  });
});

describe("task-machine isTerminal()", () => {
  test("merged is terminal", () => assert.equal(isTerminal("merged"), true));
  test("failed is terminal", () => assert.equal(isTerminal("failed"), true));
  test("abandoned is terminal", () => assert.equal(isTerminal("abandoned"), true));
  test("proposed is not terminal", () => assert.equal(isTerminal("proposed"), false));
  test("in-progress is not terminal", () => assert.equal(isTerminal("in-progress"), false));
  test("verified is not terminal", () => assert.equal(isTerminal("verified"), false));
  test("blocked is not terminal", () => assert.equal(isTerminal("blocked"), false));
});

describe("task-machine VALID_TARGETS", () => {
  test("all 9 states are present in VALID_TARGETS", () => {
    const allStates: TaskState[] = [
      "proposed", "approved", "in-progress", "changed-code",
      "verified", "blocked", "merged", "failed", "abandoned",
    ];
    for (const state of allStates) {
      assert.ok(state in VALID_TARGETS, `Missing state: ${state}`);
    }
  });

  test("terminal states have empty target arrays", () => {
    for (const state of TERMINAL_STATES) {
      assert.deepEqual(VALID_TARGETS[state], [], `${state} should have no targets`);
    }
  });
});
