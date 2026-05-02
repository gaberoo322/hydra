/**
 * Regression tests for zero-output stall detection (issue #24).
 *
 * Bug: The scheduler had no circuit breaker for cycles that churn without
 * producing merges. After issue #24, consecutive non-merge cycles trigger
 * an alert at threshold 5 (with exponential backoff) and a hard-stop at
 * threshold 8 (pausing the scheduler entirely).
 *
 * These tests verify the pure logic: backoff calculation, alert gating,
 * stall-state classification, and status field exposure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeStallBackoffMs,
  shouldSendStallAlert,
  classifyStallState,
  formatDuration,
} from "../src/scheduler.ts";

// Constants mirrored from scheduler.ts for assertion targets.
// If the source values change, tests will fail — that's intentional.
const COOLDOWN_ON_ERROR_MS = 60_000;
const MAX_STALL_BACKOFF_MS = 30 * 60 * 1000;
const STALL_ALERT_THRESHOLD = 5;
const ZERO_OUTPUT_THRESHOLD = 8;

describe("computeStallBackoffMs", () => {
  test("returns base cooldown at the alert threshold (exponent 0)", () => {
    const ms = computeStallBackoffMs(STALL_ALERT_THRESHOLD); // 5
    assert.equal(ms, COOLDOWN_ON_ERROR_MS); // 2^0 * 60s = 60s
  });

  test("doubles for each consecutive non-merge beyond threshold", () => {
    const ms6 = computeStallBackoffMs(6); // exponent 1
    assert.equal(ms6, COOLDOWN_ON_ERROR_MS * 2); // 120s

    const ms7 = computeStallBackoffMs(7); // exponent 2
    assert.equal(ms7, COOLDOWN_ON_ERROR_MS * 4); // 240s
  });

  test("caps at MAX_STALL_BACKOFF_MS (30 minutes)", () => {
    // exponent 20 would be 2^20 * 60s = enormous — must be capped
    const ms = computeStallBackoffMs(STALL_ALERT_THRESHOLD + 20);
    assert.equal(ms, MAX_STALL_BACKOFF_MS);
  });

  test("backoff sequence is monotonically increasing up to the cap", () => {
    let prev = 0;
    for (let i = STALL_ALERT_THRESHOLD; i < STALL_ALERT_THRESHOLD + 15; i++) {
      const ms = computeStallBackoffMs(i);
      assert.ok(ms >= prev, `backoff at ${i} (${ms}) should be >= previous (${prev})`);
      assert.ok(ms <= MAX_STALL_BACKOFF_MS, `backoff at ${i} should not exceed cap`);
      prev = ms;
    }
  });
});

describe("shouldSendStallAlert", () => {
  test("returns false below the alert threshold", () => {
    for (let i = 0; i < STALL_ALERT_THRESHOLD; i++) {
      assert.equal(shouldSendStallAlert(i), false, `should not alert at ${i}`);
    }
  });

  test("returns true at exactly the alert threshold (first hit)", () => {
    assert.equal(shouldSendStallAlert(STALL_ALERT_THRESHOLD), true);
  });

  test("returns false for non-milestone counts above threshold", () => {
    // 6 is not a multiple of 5, and exponent != 0
    assert.equal(shouldSendStallAlert(6), false);
    assert.equal(shouldSendStallAlert(7), false);
    assert.equal(shouldSendStallAlert(8), false);
    assert.equal(shouldSendStallAlert(9), false);
  });

  test("returns true every 5 consecutive non-merges", () => {
    assert.equal(shouldSendStallAlert(10), true);
    assert.equal(shouldSendStallAlert(15), true);
    assert.equal(shouldSendStallAlert(20), true);
  });
});

describe("classifyStallState", () => {
  test("returns 'ok' when below alert threshold", () => {
    assert.equal(classifyStallState(0), "ok");
    assert.equal(classifyStallState(4), "ok");
  });

  test("returns 'alert' at threshold and below hard-stop", () => {
    assert.equal(classifyStallState(5), "alert");
    assert.equal(classifyStallState(6), "alert");
    assert.equal(classifyStallState(7), "alert");
  });

  test("returns 'hard-stop' at the zero-output threshold", () => {
    assert.equal(classifyStallState(ZERO_OUTPUT_THRESHOLD), "hard-stop");
  });

  test("returns 'hard-stop' above the zero-output threshold", () => {
    assert.equal(classifyStallState(ZERO_OUTPUT_THRESHOLD + 5), "hard-stop");
  });
});

describe("formatDuration (stall context)", () => {
  test("formats seconds for short backoffs", () => {
    assert.equal(formatDuration(30_000), "30s");
  });

  test("formats minutes for medium backoffs", () => {
    assert.equal(formatDuration(60_000), "1m");
    assert.equal(formatDuration(120_000), "2m");
  });

  test("formats hours for long backoffs", () => {
    assert.equal(formatDuration(MAX_STALL_BACKOFF_MS), "30m");
  });
});

describe("stall detection integration invariants", () => {
  test("alert threshold is strictly less than hard-stop threshold", () => {
    assert.ok(
      STALL_ALERT_THRESHOLD < ZERO_OUTPUT_THRESHOLD,
      `alert threshold (${STALL_ALERT_THRESHOLD}) must be < hard-stop (${ZERO_OUTPUT_THRESHOLD})`,
    );
  });

  test("backoff at hard-stop boundary is meaningful (> 1 minute)", () => {
    // At consecutiveNonMerges = 7 (one before hard-stop), backoff should
    // be substantial enough to give the operator time to intervene.
    const ms = computeStallBackoffMs(ZERO_OUTPUT_THRESHOLD - 1);
    assert.ok(ms >= COOLDOWN_ON_ERROR_MS, `backoff before hard-stop should be >= base cooldown`);
  });

  test("counter reset on merge means next cycle starts at 0", () => {
    // Simulates the reset logic: after a merge, consecutiveNonMerges = 0,
    // so classifyStallState returns "ok" and no backoff applies.
    const afterMerge = 0;
    assert.equal(classifyStallState(afterMerge), "ok");
    assert.equal(shouldSendStallAlert(afterMerge), false);
  });

  test("full stall progression from 0 to hard-stop", () => {
    // Walk through the entire lifecycle of a stall scenario
    const states: string[] = [];
    const alerts: boolean[] = [];

    for (let i = 0; i <= ZERO_OUTPUT_THRESHOLD; i++) {
      states.push(classifyStallState(i));
      alerts.push(shouldSendStallAlert(i));
    }

    // First STALL_ALERT_THRESHOLD cycles should be "ok"
    for (let i = 0; i < STALL_ALERT_THRESHOLD; i++) {
      assert.equal(states[i], "ok", `cycle ${i} should be ok`);
      assert.equal(alerts[i], false, `cycle ${i} should not alert`);
    }

    // Alert range
    for (let i = STALL_ALERT_THRESHOLD; i < ZERO_OUTPUT_THRESHOLD; i++) {
      assert.equal(states[i], "alert", `cycle ${i} should be alert`);
    }

    // First alert fires
    assert.equal(alerts[STALL_ALERT_THRESHOLD], true, "first alert should fire");

    // Hard-stop
    assert.equal(states[ZERO_OUTPUT_THRESHOLD], "hard-stop");
  });
});
