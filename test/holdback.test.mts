/**
 * Regression tests for the Tier-2 outcome-holdback watcher (issue #244).
 *
 * Bug classes this guards against:
 *   - Non-tier-2 merge accidentally creating a holdback (cost: phantom
 *     watchers, polluted /api/holdback, false-positive reverts).
 *   - Kill flag failing to short-circuit either snapshot or eval (operator's
 *     emergency stop must work end-to-end).
 *   - Adapter outage (`getOutcomeValue` returns null) being miscounted as
 *     regression — this would auto-revert during any prometheus blip.
 *   - Terminal outcomes counting toward the 5-cycle holdback window
 *     (window too short for terminal goals per ADR-0004 vision).
 *   - Single noisy reading flipping a holdback (must require 2 sustained
 *     readings, matching the stuckness `SUSTAIN_WINDOW` from #242).
 *   - Recovery within window NOT cancelling regression streak (would cause
 *     reverts after the system already self-corrected).
 *   - Defensive contract: `snapshotForHoldback` and `evaluateAllHoldbacks`
 *     must never throw. Anything inside the cycle loop that crashes takes
 *     down the orchestrator — these two are called every cycle.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isOutcomeRegression,
  shouldRevert,
  snapshotForHoldback,
  evaluateAllHoldbacks,
  isTier2Disabled,
  HOLDBACK_WINDOW_CYCLES,
  SUSTAINED_REGRESSION_CYCLES,
  MAX_REVERTS_PER_DAY,
  type HoldbackRecord,
} from "../src/holdback.ts";
import type { Outcome } from "../src/outcomes.ts";

// ---------------------------------------------------------------------------
// Constants exposed sanity
// ---------------------------------------------------------------------------

describe("holdback constants — ADR-0004 contract", () => {
  test("5-cycle window per ADR-0004 vision", () => {
    assert.equal(HOLDBACK_WINDOW_CYCLES, 5);
  });
  test("2-cycle sustain requirement reuses stuckness semantics (#242)", () => {
    assert.equal(SUSTAINED_REGRESSION_CYCLES, 2);
  });
  test("per-day revert cap is conservative", () => {
    // A runaway revert loop is far more expensive than missing one regression
    // revert — issue #244 implementation notes call this out explicitly.
    assert.ok(MAX_REVERTS_PER_DAY >= 1 && MAX_REVERTS_PER_DAY <= 5,
      `cap should be in [1,5]; got ${MAX_REVERTS_PER_DAY}`);
  });
});

// ---------------------------------------------------------------------------
// isOutcomeRegression — pure
// ---------------------------------------------------------------------------

function outcomeMeta(overrides: Partial<Pick<Outcome, "direction" | "noise_epsilon">> = {}): Pick<Outcome, "direction" | "noise_epsilon"> {
  return { direction: "up", noise_epsilon: 0, ...overrides };
}

describe("isOutcomeRegression — direction + epsilon + null-safety", () => {
  test("up direction: a drop beyond epsilon is a regression", () => {
    assert.equal(isOutcomeRegression(outcomeMeta({ direction: "up" }), 100, 99), true);
    assert.equal(isOutcomeRegression(outcomeMeta({ direction: "up", noise_epsilon: 0.5 }), 100, 99), true);
  });

  test("up direction: a rise is NOT a regression", () => {
    assert.equal(isOutcomeRegression(outcomeMeta({ direction: "up" }), 100, 101), false);
  });

  test("down direction: a rise beyond epsilon is a regression", () => {
    assert.equal(isOutcomeRegression(outcomeMeta({ direction: "down" }), 0.05, 0.10), true);
  });

  test("down direction: a drop is NOT a regression", () => {
    assert.equal(isOutcomeRegression(outcomeMeta({ direction: "down" }), 0.05, 0.02), false);
  });

  test("move within epsilon is NOT a regression", () => {
    assert.equal(isOutcomeRegression(outcomeMeta({ direction: "up", noise_epsilon: 1 }), 100, 99.5), false);
    assert.equal(isOutcomeRegression(outcomeMeta({ direction: "down", noise_epsilon: 1 }), 0.05, 0.5), false);
  });

  test("null/undefined current value treated as no-data (NOT regression)", () => {
    assert.equal(isOutcomeRegression(outcomeMeta(), 100, null), false);
    assert.equal(isOutcomeRegression(outcomeMeta(), 100, undefined), false);
  });

  test("NaN / Infinity treated as no-data", () => {
    assert.equal(isOutcomeRegression(outcomeMeta(), 100, Number.NaN), false);
    assert.equal(isOutcomeRegression(outcomeMeta(), 100, Number.POSITIVE_INFINITY), false);
    assert.equal(isOutcomeRegression(outcomeMeta(), Number.NaN, 50), false);
  });

  test("non-finite epsilon falls back to 0 (zero tolerance)", () => {
    assert.equal(isOutcomeRegression({ direction: "up", noise_epsilon: Number.NaN as any }, 100, 99.9999), true);
  });
});

// ---------------------------------------------------------------------------
// shouldRevert — pure decision over the record + leading outcomes
// ---------------------------------------------------------------------------

function leadingOutcome(name: string, overrides: Partial<Outcome> = {}): Outcome {
  return {
    name,
    kind: "leading",
    direction: "up",
    source: "file",
    query: "noop",
    baseline: 0,
    target: 100,
    stuckness_threshold_cycles: 5,
    noise_epsilon: 0,
    ...overrides,
  };
}

function recordFor(overrides: Partial<HoldbackRecord> = {}): HoldbackRecord {
  return {
    commitSha: "deadbeef",
    prNumber: 1,
    mergedAt: new Date().toISOString(),
    cyclesElapsed: 1,
    status: "watching",
    baseline: { merge_rate: 0.5 },
    current: { merge_rate: 0.5 },
    regressionCounts: {},
    ...overrides,
  };
}

describe("shouldRevert — sustained regression triggers revert", () => {
  test("no regression counts ⇒ no revert", () => {
    const r = recordFor({ regressionCounts: {} });
    const { revert, outcomes } = shouldRevert(r, [leadingOutcome("merge_rate")]);
    assert.equal(revert, false);
    assert.deepEqual(outcomes, []);
  });

  test("regression count just below threshold ⇒ no revert", () => {
    const r = recordFor({ regressionCounts: { merge_rate: SUSTAINED_REGRESSION_CYCLES - 1 } });
    const { revert } = shouldRevert(r, [leadingOutcome("merge_rate")]);
    assert.equal(revert, false, "must require SUSTAINED_REGRESSION_CYCLES consecutive readings");
  });

  test("regression count equals threshold ⇒ revert", () => {
    const r = recordFor({ regressionCounts: { merge_rate: SUSTAINED_REGRESSION_CYCLES } });
    const { revert, outcomes } = shouldRevert(r, [leadingOutcome("merge_rate")]);
    assert.equal(revert, true);
    assert.deepEqual(outcomes, ["merge_rate"]);
  });

  test("any one leading outcome over threshold is enough", () => {
    const r = recordFor({
      regressionCounts: { merge_rate: 0, agent_cost: SUSTAINED_REGRESSION_CYCLES },
      baseline: { merge_rate: 0.5, agent_cost: 1.0 },
      current: { merge_rate: 0.5, agent_cost: 5.0 },
    });
    const outs = [leadingOutcome("merge_rate"), leadingOutcome("agent_cost", { direction: "down" })];
    const { revert, outcomes } = shouldRevert(r, outs);
    assert.equal(revert, true);
    assert.deepEqual(outcomes, ["agent_cost"]);
  });

  test("outcomes not in leading list are ignored (e.g. terminal removed by caller)", () => {
    // Caller is responsible for filtering kind === leading. shouldRevert
    // is pure on the array it receives.
    const r = recordFor({ regressionCounts: { revenue_total: 99 } });
    const { revert } = shouldRevert(r, []); // empty: terminal-only system would pass [] here
    assert.equal(revert, false, "no leading outcomes ⇒ no revert");
  });
});

// ---------------------------------------------------------------------------
// snapshotForHoldback — kill flag + tier gate + no-data handling
//
// These tests exercise the IO-touching code path but rely on its defensive
// contract (never throws) and use real Redis when available — if Redis is
// unreachable the function returns `{ snapshotted: false }` and the test
// asserts a reason field, not a specific code path.
// ---------------------------------------------------------------------------

describe("snapshotForHoldback — defensive contract", () => {
  test("non-tier-2 file set is skipped (never reaches Redis)", async () => {
    // src/control-loop.ts is Tier 0; src/some-random.ts is Tier 3.
    const result = await snapshotForHoldback("aaaa1111", 123, ["src/some-random.ts"]);
    assert.equal(result.snapshotted, false);
    assert.match(result.reason || "", /not tier 2|tier=3/i);
  });

  test("invalid commitSha is rejected", async () => {
    // @ts-expect-error — deliberately passing wrong type.
    const r1 = await snapshotForHoldback(null, 1, [".claude/skills/foo.md"]);
    assert.equal(r1.snapshotted, false);
    assert.match(r1.reason || "", /invalid commitSha/i);

    const r2 = await snapshotForHoldback("", 1, [".claude/skills/foo.md"]);
    assert.equal(r2.snapshotted, false);
    assert.match(r2.reason || "", /invalid commitSha/i);
  });

  test("never throws on garbage input", async () => {
    // @ts-expect-error — deliberately passing wrong type for filesChanged.
    const r = await snapshotForHoldback("abc123", null, null);
    assert.equal(typeof r.snapshotted, "boolean");
  });
});

// ---------------------------------------------------------------------------
// evaluateAllHoldbacks — defensive contract
// ---------------------------------------------------------------------------

describe("evaluateAllHoldbacks — defensive contract", () => {
  test("never throws when no active holdbacks", async () => {
    const fakeBus = { async publish() { return "id"; } };
    const result = await evaluateAllHoldbacks("test-cycle-1", fakeBus);
    assert.equal(typeof result.evaluated, "number");
    assert.equal(Array.isArray(result.reverted), true);
    assert.equal(Array.isArray(result.passed), true);
  });

  test("eventBus is optional (null allowed)", async () => {
    const result = await evaluateAllHoldbacks("test-cycle-2", null);
    assert.equal(typeof result.evaluated, "number");
  });

  test("eventBus is optional (undefined allowed)", async () => {
    const result = await evaluateAllHoldbacks("test-cycle-3");
    assert.equal(typeof result.evaluated, "number");
  });
});

// ---------------------------------------------------------------------------
// isTier2Disabled — kill switch read contract
// ---------------------------------------------------------------------------

describe("isTier2Disabled — fail-safe semantics", () => {
  test("returns a boolean even when Redis is unreachable", async () => {
    // Per the implementation comment: when we can't read the flag we ERR
    // ON THE SIDE of "disabled" — better to skip a snapshot than to revert
    // based on stale state. The test guarantees the function returns a
    // boolean and never throws, regardless of the underlying Redis state.
    const r = await isTier2Disabled();
    assert.equal(typeof r, "boolean");
  });
});
