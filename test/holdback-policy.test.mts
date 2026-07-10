/**
 * Unit tests for `src/holdback-policy.ts` — the pure Outcome-Holdback
 * tier-enrollment policy (issue #3095, anchoring the module extracted in
 * #2671).
 *
 * The module owns two deterministic predicates over env-read constants:
 *   - `isEnrolledTier`     — which tiers enroll in an Outcome Holdback watch.
 *   - `windowCyclesForTier` — how long the watch window runs for a tier.
 *
 * Both are pure tier arithmetic — no Redis, no filesystem, no event bus — so
 * these are pure unit tests with no fixture. They pin the tier-membership +
 * monotonic-window contract the module's docstring commits to (#741,
 * ADR-0015 monotonic ladder) so a future edit can't silently break which
 * merges get an Outcome Holdback watch, or invert the window ordering.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isEnrolledTier,
  windowCyclesForTier,
  HOLDBACK_WINDOW_CYCLES,
  HOLDBACK_WINDOW_CYCLES_T3,
} from "../src/holdback-policy.ts";

describe("holdback-policy — isEnrolledTier (tier-membership contract)", () => {
  test("T1 (prompt-shaped) does not enroll", () => {
    assert.equal(isEnrolledTier(1), false);
  });

  test("T2, T3, T4 enroll (the carry-up tiers)", () => {
    assert.equal(isEnrolledTier(2), true);
    assert.equal(isEnrolledTier(3), true);
    assert.equal(isEnrolledTier(4), true);
  });

  test("null / undefined never enroll (unresolvable tier is 'no signal')", () => {
    assert.equal(isEnrolledTier(null), false);
    assert.equal(isEnrolledTier(undefined), false);
  });

  test("tiers outside the {2,3,4} set (0, 5, negatives) do not enroll", () => {
    assert.equal(isEnrolledTier(0), false);
    assert.equal(isEnrolledTier(5), false);
    assert.equal(isEnrolledTier(-1), false);
  });
});

describe("holdback-policy — windowCyclesForTier (monotonic + floor contract)", () => {
  test("T2 returns the floor window (HOLDBACK_WINDOW_CYCLES)", () => {
    assert.equal(windowCyclesForTier(2), HOLDBACK_WINDOW_CYCLES);
  });

  test("T3 is at least the T2 floor and matches the configured T3 window", () => {
    const t3 = windowCyclesForTier(3);
    assert.equal(t3, Math.max(HOLDBACK_WINDOW_CYCLES_T3, HOLDBACK_WINDOW_CYCLES));
    assert.ok(t3 >= windowCyclesForTier(2), "T3 window must be >= T2 window");
  });

  test("window is monotonic non-decreasing across T2 <= T3 <= T4", () => {
    const t2 = windowCyclesForTier(2);
    const t3 = windowCyclesForTier(3);
    const t4 = windowCyclesForTier(4);
    assert.ok(t2 <= t3, `T2 (${t2}) must be <= T3 (${t3})`);
    assert.ok(t3 <= t4, `T3 (${t3}) must be <= T4 (${t4})`);
  });

  test("T1 / null / undefined fall back to the T2 floor", () => {
    assert.equal(windowCyclesForTier(1), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(null), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(undefined), HOLDBACK_WINDOW_CYCLES);
  });

  test("all windows are finite non-negative integers (floor-clamped)", () => {
    for (const tier of [1, 2, 3, 4, null, undefined] as const) {
      const w = windowCyclesForTier(tier);
      assert.ok(Number.isFinite(w), `window for tier ${tier} must be finite`);
      assert.ok(w >= 0, `window for tier ${tier} must be non-negative`);
    }
  });
});
