/**
 * Regression test for learning auto-promotion threshold (issue #172).
 *
 * Bug: The learning system required 5 occurrences before auto-promoting a
 * pattern to the agent feedback file. This meant the system repeated the
 * same mistake 4 times before learning.
 *
 * Fix: Lower PROMOTION_THRESHOLD from 5 to 3 so patterns promote faster.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/constants.ts";

describe("learning promotion threshold (issue #172)", () => {
  test("PROMOTION_THRESHOLD is 3", () => {
    assert.equal(PROMOTION_THRESHOLD, 3);
  });

  test("a pattern with exactly 3 hits meets the threshold", () => {
    const hitCount = 3;
    assert.ok(
      hitCount >= PROMOTION_THRESHOLD,
      "3 hits should meet the promotion threshold",
    );
  });

  test("a pattern with 2 hits does NOT meet the threshold", () => {
    const hitCount = 2;
    assert.ok(
      hitCount < PROMOTION_THRESHOLD,
      "2 hits should not meet the promotion threshold",
    );
  });
});
