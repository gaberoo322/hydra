/**
 * Unit tests for the promotion/escalation decision predicate (issue #2178).
 *
 * `decideRecordActions` is the pure spine extracted from
 * `agent-memory.ts::recordPattern` — it answers "given a pattern's post-hit
 * state, which side effects should fire (promote / escalate)?" without any
 * Redis, filesystem, or `gh`. These tests exercise the two sub-decisions and
 * their composition directly, no store fixture needed — the exact leverage the
 * extraction buys (the prior surface was `recordPattern` with injected
 * Redis/escalation stubs).
 *
 * Issue #2962 — the third sub-decision, `writeFeedbackFile`, was retired with
 * the dead `config/feedback/to-*.md` mirror it gated. The cases that pinned it
 * were removed; promotion now yields exactly `{ promote, escalate }`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideRecordActions } from "../src/pattern-memory/decision.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/constants.ts";

const T = PROMOTION_THRESHOLD; // 3

describe("decideRecordActions — promotion sub-decision (issue #2178)", () => {
  test("does NOT promote below the threshold", () => {
    const d = decideRecordActions(
      { category: "some-cue", hitCount: T - 1, promoted: false },
      "memory",
      T,
    );
    assert.equal(d.promote, false);
  });

  test("promotes exactly at the threshold when not yet promoted", () => {
    const d = decideRecordActions(
      { category: "some-cue", hitCount: T, promoted: false },
      "memory",
      T,
    );
    assert.equal(d.promote, true);
  });

  test("promotion is one-shot — already-promoted patterns do not re-promote", () => {
    const d = decideRecordActions(
      { category: "some-cue", hitCount: T + 10, promoted: true },
      "memory",
      T,
    );
    assert.equal(d.promote, false);
  });

  test("metadata cue still promotes at its promotion threshold (issue #2962)", () => {
    // The retired writeFeedbackFile decision used to skip the file write for
    // metadata cues; promotion itself was never gated on cue kind. A metadata
    // cue at/above the promotion threshold still promotes.
    const d = decideRecordActions(
      { category: "acceptance-criterion-deferred", hitCount: 20, promoted: false },
      "memory",
      T,
    );
    assert.equal(d.promote, true);
  });

  test("friction namespace still promotes at the threshold (issue #2962)", () => {
    const d = decideRecordActions(
      { category: "some-cue", hitCount: T, promoted: false },
      "friction",
      T,
    );
    assert.equal(d.promote, true);
  });
});

describe("decideRecordActions — escalate sub-decision (issue #2178)", () => {
  test("escalates on the threshold-cross", () => {
    const d = decideRecordActions(
      { category: "some-cue", hitCount: T, promoted: false },
      "memory",
      T,
    );
    assert.equal(d.escalate, true);
  });

  test("does NOT escalate one hit below the threshold", () => {
    const d = decideRecordActions(
      { category: "some-cue", hitCount: T - 1, promoted: false },
      "memory",
      T,
    );
    assert.equal(d.escalate, false);
  });

  test("does NOT escalate between re-fire points, escalates again at +10", () => {
    const between = decideRecordActions(
      { category: "some-cue", hitCount: T + 5, promoted: true },
      "memory",
      T,
    );
    assert.equal(between.escalate, false, "T+5 is not a re-fire point");

    const refire = decideRecordActions(
      { category: "some-cue", hitCount: T + 10, promoted: true },
      "memory",
      T,
    );
    assert.equal(refire.escalate, true, "T+10 re-fires the escalation");
  });

  test("escalation honours the per-cue threshold override (issue #524)", () => {
    // acceptance-criterion-deferred raises the escalation bar to 20.
    const belowOverride = decideRecordActions(
      { category: "acceptance-criterion-deferred", hitCount: T, promoted: false },
      "memory",
      T,
    );
    assert.equal(
      belowOverride.escalate,
      false,
      "3 hits is below the deferred-cue's 20-hit escalation threshold",
    );

    const atOverride = decideRecordActions(
      { category: "acceptance-criterion-deferred", hitCount: 20, promoted: false },
      "memory",
      T,
    );
    assert.equal(atOverride.escalate, true, "20 hits crosses the override threshold");
  });

  test("never-escalate sentinel cue never escalates (issue #1789)", () => {
    const d = decideRecordActions(
      { category: "no-agent-spawn-tool-run-inline", hitCount: 999, promoted: true },
      "friction",
      T,
    );
    assert.equal(d.escalate, false);
  });
});

describe("decideRecordActions — promote and escalate are independent (issue #2178)", () => {
  test("a deferred metadata cue can promote without escalating", () => {
    // promote fires at 3 (hitCount >= threshold), but the cue's escalation
    // override (20) means escalate stays false — the two decisions diverge.
    const d = decideRecordActions(
      { category: "acceptance-criterion-deferred", hitCount: T, promoted: false },
      "memory",
      T,
    );
    assert.equal(d.promote, true);
    assert.equal(d.escalate, false);
  });

  test("escalation re-fires after promotion is already done", () => {
    const d = decideRecordActions(
      { category: "some-cue", hitCount: T + 10, promoted: true },
      "memory",
      T,
    );
    assert.equal(d.promote, false, "promotion is one-shot");
    assert.equal(d.escalate, true, "but escalation still re-fires at +10");
  });
});
