/**
 * Direct unit tests for `computeGreenLight` (issue #1875).
 *
 * `computeGreenLight` + its policy constants were extracted from the HTTP
 * router (`src/api/design-concepts.ts`) to their domain home
 * (`src/design-concept-identity.ts`) so the pure function can be exercised WITHOUT
 * Redis or an Express server. These tests assert the green-light criterion
 * (issue #736: ≥7 of the trailing 10 snapshot days produced a concept) at
 * the function boundary — the edge cases the HTTP-only test
 * (`test/design-concept-snapshots-api.test.mts`) could only reach through a
 * full round-trip:
 *
 *   - exactly 7 green days   → greenLightReady:true
 *   - 6 green days           → greenLightReady:false
 *   - window boundary at 10  → days past the window do not count
 *   - zero-production streak  → all metrics 0, not ready
 *   - quiet day inside window → idle-tolerant (#736)
 *   - custom threshold/window args honoured
 *
 * Pure function — no Redis connection, no HTTP, no `beforeEach`/`after`
 * fixtures. The whole file runs in milliseconds.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// `computeGreenLight` + its policy constants are pure identity/policy logic and
// live in the identity Module (issue #2033); issue #2124 retired the
// persistence Module's back-compat re-export, so import them from their home.
import {
  computeGreenLight,
  GREEN_LIGHT_WINDOW_DAYS,
  GREEN_LIGHT_REQUIRED_DAYS,
} from "../src/design-concept-identity.ts";

/** Build a newest-first snapshot list from a count array (index 0 = newest). */
function snaps(counts: number[]): Array<{ date: string; count: number }> {
  return counts.map((count, i) => ({ date: `day-${i}`, count }));
}

describe("computeGreenLight (#1875 — direct pure-function tests)", () => {
  test("policy constants are the #736 thresholds (7 of last 10)", () => {
    assert.equal(GREEN_LIGHT_WINDOW_DAYS, 10);
    assert.equal(GREEN_LIGHT_REQUIRED_DAYS, 7);
  });

  test("empty snapshot list → all-zero metrics, not ready", () => {
    const m = computeGreenLight([]);
    assert.equal(m.consecutiveGreenDays, 0);
    assert.equal(m.greenDaysInWindow, 0);
    assert.equal(m.windowDays, 10);
    assert.equal(m.requiredGreenDays, 7);
    assert.equal(m.greenLightReady, false);
  });

  test("exactly 7 consecutive green days → greenLightReady:true", () => {
    const m = computeGreenLight(snaps([1, 1, 1, 1, 1, 1, 1]));
    assert.equal(m.consecutiveGreenDays, 7);
    assert.equal(m.greenDaysInWindow, 7);
    assert.equal(m.greenLightReady, true);
  });

  test("6 consecutive green days → NOT yet green-light", () => {
    const m = computeGreenLight(snaps([1, 1, 1, 1, 1, 1]));
    assert.equal(m.consecutiveGreenDays, 6);
    assert.equal(m.greenDaysInWindow, 6);
    assert.equal(m.greenLightReady, false);
  });

  test("zero-production streak → all metrics 0, not ready", () => {
    const m = computeGreenLight(snaps([0, 0, 0, 0, 0]));
    assert.equal(m.consecutiveGreenDays, 0);
    assert.equal(m.greenDaysInWindow, 0);
    assert.equal(m.greenLightReady, false);
  });

  test("#736 idle-tolerant: a quiet day inside a productive window stays green-light", () => {
    // 9 green of the trailing 10 days (one quiet day at index 3). The
    // consecutive run breaks at the quiet day, but the window count >= 7.
    const m = computeGreenLight(snaps([1, 1, 1, 0, 1, 1, 1, 1, 1, 1]));
    assert.equal(m.greenDaysInWindow, 9);
    assert.equal(m.greenLightReady, true, "9 of 10 green days must satisfy the gate");
    // consecutiveGreenDays stops at the first zero (the 3 newest days).
    assert.equal(m.consecutiveGreenDays, 3);
  });

  test("#736 idle-tolerant: 4 quiet days in the window blocks green-light", () => {
    // 6 green of 10 ⇒ < 7 ⇒ not ready.
    const m = computeGreenLight(snaps([1, 1, 1, 0, 0, 1, 1, 1, 0, 0]));
    assert.equal(m.greenDaysInWindow, 6);
    assert.equal(m.greenLightReady, false);
  });

  test("window boundary: green days past the 10-day window do not count", () => {
    // 6 green inside the window, then 5 more green days at indices 10-14
    // that fall OUTSIDE the trailing-10 window. greenDaysInWindow must stay
    // at 6 (not ready) even though 11 total days are green.
    const counts = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const m = computeGreenLight(snaps(counts));
    assert.equal(m.greenDaysInWindow, 6, "only the trailing 10 days count");
    assert.equal(m.greenLightReady, false);
    // consecutiveGreenDays still walks the whole list from newest (6 here).
    assert.equal(m.consecutiveGreenDays, 6);
  });

  test("custom windowDays / requiredGreenDays args are honoured", () => {
    // Override the policy: 3 of last 5.
    const m = computeGreenLight(snaps([1, 0, 1, 1, 0, 1, 1]), 5, 3);
    assert.equal(m.windowDays, 5);
    assert.equal(m.requiredGreenDays, 3);
    // Trailing 5 days: [1,0,1,1,0] → 3 green ⇒ meets the custom threshold.
    assert.equal(m.greenDaysInWindow, 3);
    assert.equal(m.greenLightReady, true);
  });
});
