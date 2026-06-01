/**
 * Unit tests for the tier → merge-policy predicates (ADR-0019 / issue #799).
 *
 * These pin the two invariants the design-concept artifact requires:
 *   - `permitsBreakingChange(tier)` is logically equivalent to `tier >= 2`,
 *     preserving design-concept gateCheck rule 4 (a breaking change on a
 *     path classifying to tier < 2 is rejected).
 *   - `isAutoMergeTier(tier)` is true iff `tier in {1, 2, 3}` and false for
 *     tier 0 — fixing the calibration-trend Tier-0 mismodel (was `tier <= 2`).
 *
 * NUMBERING: predicates stay on the legacy 0|1|2|3 numbering per ADR-0019
 * decision 4 — they take a plain `number`, including 0, which the live
 * `Tier` type (1|2|3|4) cannot express.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isAutoMergeTier, permitsBreakingChange } from "../src/tier-policy.ts";

describe("isAutoMergeTier — auto-merge boundary (legacy 0|1|2|3)", () => {
  test("tier 0 (Verifier Core / operator-only) is NOT an auto-merge tier", () => {
    // The defect being fixed: the old `tier <= 2` test would have
    // returned true here, mismodelling an operator-merged Tier-0 PR.
    assert.equal(isAutoMergeTier(0), false);
  });

  test("tiers 1, 2, 3 are auto-merge tiers", () => {
    assert.equal(isAutoMergeTier(1), true);
    assert.equal(isAutoMergeTier(2), true);
    assert.equal(isAutoMergeTier(3), true);
  });

  test("equivalent to `tier in {1,2,3}` across a wide range", () => {
    for (let t = -2; t <= 6; t++) {
      assert.equal(isAutoMergeTier(t), t >= 1 && t <= 3, `tier ${t}`);
    }
  });
});

describe("permitsBreakingChange — breaking-change floor (tier >= 2)", () => {
  test("tier 0 and 1 do NOT permit a breaking change", () => {
    assert.equal(permitsBreakingChange(0), false);
    assert.equal(permitsBreakingChange(1), false);
  });

  test("tier 2 and above permit a breaking change", () => {
    assert.equal(permitsBreakingChange(2), true);
    assert.equal(permitsBreakingChange(3), true);
    assert.equal(permitsBreakingChange(4), true);
  });

  test("logically equivalent to `tier >= 2` across a wide range", () => {
    for (let t = -2; t <= 6; t++) {
      assert.equal(permitsBreakingChange(t), t >= 2, `tier ${t}`);
    }
  });
});
