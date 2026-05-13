/**
 * Regression test for issue #340 — scheduler-level wedged-workspace halt.
 *
 * On 2026-05-12, 10 consecutive cycles abandoned because the target repo was
 * stuck on `feature/cycle-2026-05-12-0712-slug`. The `classifyWedgedWorkspaceState`
 * helper drives the scheduler's halt threshold so the same incident stops at
 * ~3 cycles ($60 wasted) instead of 10 ($280 wasted).
 *
 * Mirrors the structure of classifyNoOpMergeState (issue #222) — pure function,
 * no Redis, no scheduler-state coupling.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — runtime export from scheduler.ts, surfaced for tests
import { classifyWedgedWorkspaceState, WEDGED_WORKSPACE_HALT_THRESHOLD } from "../src/scheduler.ts";

describe("classifyWedgedWorkspaceState (issue #340)", () => {
  test("ok when no consecutive wedged cycles", () => {
    assert.equal(classifyWedgedWorkspaceState(0), "ok");
  });

  test("ok at exactly 1 consecutive wedged cycle (single wedge can be transient)", () => {
    // One wedged cycle is not yet a pattern — could be a single failed
    // executor cleanup that recovers next cycle.
    assert.equal(classifyWedgedWorkspaceState(1), "ok");
  });

  test("alert at 2 consecutive wedged cycles", () => {
    // Two cycles wedged on the same branch is the moment we start logging
    // an error and publishing an alert event — operator may want to act.
    assert.equal(classifyWedgedWorkspaceState(2), "alert");
  });

  test("alert at threshold-1 (below halt)", () => {
    const halt = WEDGED_WORKSPACE_HALT_THRESHOLD;
    assert.equal(classifyWedgedWorkspaceState(halt - 1), "alert");
  });

  test("halt at the configured threshold", () => {
    assert.equal(classifyWedgedWorkspaceState(WEDGED_WORKSPACE_HALT_THRESHOLD), "halt");
  });

  test("halt above the configured threshold", () => {
    assert.equal(classifyWedgedWorkspaceState(WEDGED_WORKSPACE_HALT_THRESHOLD + 1), "halt");
    assert.equal(classifyWedgedWorkspaceState(10), "halt"); // the 2026-05-12 incident count
  });

  test("respects a caller-supplied threshold (testability)", () => {
    assert.equal(classifyWedgedWorkspaceState(5, 10), "alert");
    assert.equal(classifyWedgedWorkspaceState(10, 10), "halt");
    assert.equal(classifyWedgedWorkspaceState(11, 10), "halt");
  });

  test("regression (#340): 2026-05-12 ten-cycle incident would be halted at threshold", () => {
    // The 2026-05-12 incident wedged for 10 cycles. With a default halt
    // threshold of 3, the scheduler would have halted after cycle 3 —
    // saving ~7 cycles of wasted planner spend.
    const incidentLength = 10;
    let firstHaltAt = -1;
    for (let i = 1; i <= incidentLength; i++) {
      if (classifyWedgedWorkspaceState(i) === "halt") {
        firstHaltAt = i;
        break;
      }
    }
    assert.equal(firstHaltAt, WEDGED_WORKSPACE_HALT_THRESHOLD);
    assert.ok(firstHaltAt < incidentLength, "halt must fire before the incident reaches 10 cycles");
  });
});
