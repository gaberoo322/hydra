/**
 * Unit tests for the pure Outcome Holdback regression policy
 * (`src/outcome-regression.ts`, issue #3237).
 *
 * The whole module is pure — no Redis, no filesystem, no event bus (the
 * Redis-touching coordinator half lives in `src/holdback.ts`). So every helper
 * is exercised here with plain in-memory structs:
 *   - `isOutcomeRegressed` — the single-outcome regression predicate
 *   - `detectRegressions`  — the baseline↔current diff
 *   - `decideHoldback`     — the branching policy (passed / watching /
 *                            cap-reached / revert), with an injected `nowMs`
 *
 * `snapshotLeadingOutcomes` is NOT covered here: it reaches into `loadOutcomes`
 * / `getOutcomeValue` (the outcome adapter), which is the loader Module's
 * concern and is exercised via `test/outcomes*.test.mts`. This file stays
 * Redis-free and adapter-free by design, mirroring the module's own boundary.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isOutcomeRegressed,
  detectRegressions,
  decideHoldback,
  type DecideHoldbackInput,
} from "../src/outcome-regression.ts";
import type { HoldbackBaseline } from "../src/redis/holdback.ts";

// ---------------------------------------------------------------------------
// isOutcomeRegressed — single-outcome predicate
// ---------------------------------------------------------------------------

describe("isOutcomeRegressed — direction: up", () => {
  test("regresses when current drops below baseline by more than epsilon", () => {
    assert.equal(isOutcomeRegressed(0.5, 0.3, "up", 0.05), true);
  });

  test("no regression on a favorable rise", () => {
    assert.equal(isOutcomeRegressed(0.5, 0.7, "up", 0.05), false);
  });

  test("no regression when the drop is within epsilon (no-move)", () => {
    // delta = -0.04, epsilon 0.05 → treated as no-move.
    assert.equal(isOutcomeRegressed(0.5, 0.46, "up", 0.05), false);
  });

  test("no regression when the drop exactly equals epsilon (strict >)", () => {
    // favorableDelta = -0.05, regression requires < -0.05 → not a regression.
    assert.equal(isOutcomeRegressed(0.5, 0.45, "up", 0.05), false);
  });

  test("regresses when the drop is just past epsilon", () => {
    assert.equal(isOutcomeRegressed(0.5, 0.449, "up", 0.05), true);
  });
});

describe("isOutcomeRegressed — direction: down", () => {
  test("regresses when current rises above baseline by more than epsilon", () => {
    // lower is favorable; a rise is unfavorable.
    assert.equal(isOutcomeRegressed(0.2, 0.4, "down", 0.05), true);
  });

  test("no regression on a favorable fall", () => {
    assert.equal(isOutcomeRegressed(0.2, 0.1, "down", 0.05), false);
  });

  test("no regression when the rise is within epsilon", () => {
    assert.equal(isOutcomeRegressed(0.2, 0.24, "down", 0.05), false);
  });
});

describe("isOutcomeRegressed — no-data + non-finite guards", () => {
  test("null baseline is never a regression", () => {
    assert.equal(isOutcomeRegressed(null, 0.1, "up", 0.05), false);
  });

  test("null current is never a regression", () => {
    assert.equal(isOutcomeRegressed(0.5, null, "up", 0.05), false);
  });

  test("both null is never a regression", () => {
    assert.equal(isOutcomeRegressed(null, null, "up", 0.05), false);
  });

  test("NaN baseline is treated as no-data, not a regression", () => {
    assert.equal(isOutcomeRegressed(NaN, 0.1, "up", 0.05), false);
  });

  test("Infinity current is treated as no-data, not a regression", () => {
    assert.equal(isOutcomeRegressed(0.5, Infinity, "up", 0.05), false);
  });

  test("a non-finite epsilon falls back to a 0 tolerance", () => {
    // epsilon NaN → eps 0, so any unfavorable move regresses.
    assert.equal(isOutcomeRegressed(0.5, 0.4999, "up", NaN), true);
  });

  test("a negative epsilon is treated by magnitude (abs)", () => {
    // |−0.05| = 0.05 tolerance; a 0.04 drop is within tolerance → no regression.
    assert.equal(isOutcomeRegressed(0.5, 0.46, "up", -0.05), false);
  });
});

// ---------------------------------------------------------------------------
// detectRegressions — baseline ↔ current diff, matched by name
// ---------------------------------------------------------------------------

describe("detectRegressions", () => {
  test("returns the regressed outcomes with baseline+current populated", () => {
    const baseline = [
      { name: "accuracy", direction: "up" as const, noiseEpsilon: 0.02, value: 0.6 },
      { name: "latency", direction: "down" as const, noiseEpsilon: 5, value: 100 },
    ];
    const current = [
      { name: "accuracy", value: 0.4 }, // dropped → regressed (up)
      { name: "latency", value: 90 }, // fell → favorable (down), no regression
    ];
    const regressions = detectRegressions(baseline, current);
    assert.equal(regressions.length, 1);
    assert.equal(regressions[0].name, "accuracy");
    assert.equal(regressions[0].baseline, 0.6);
    assert.equal(regressions[0].current, 0.4);
    assert.equal(regressions[0].direction, "up");
    assert.equal(regressions[0].noiseEpsilon, 0.02);
  });

  test("returns [] when nothing regressed", () => {
    const baseline = [
      { name: "accuracy", direction: "up" as const, noiseEpsilon: 0.02, value: 0.6 },
    ];
    const current = [{ name: "accuracy", value: 0.65 }];
    assert.deepEqual(detectRegressions(baseline, current), []);
  });

  test("an outcome present in baseline but absent from current is skipped (no-data)", () => {
    const baseline = [
      { name: "accuracy", direction: "up" as const, noiseEpsilon: 0.02, value: 0.6 },
    ];
    const current: Array<{ name: string; value: number | null }> = [];
    assert.deepEqual(detectRegressions(baseline, current), []);
  });

  test("a null current value is skipped (no-data, not a synthetic regression)", () => {
    const baseline = [
      { name: "accuracy", direction: "up" as const, noiseEpsilon: 0.02, value: 0.6 },
    ];
    const current = [{ name: "accuracy", value: null }];
    assert.deepEqual(detectRegressions(baseline, current), []);
  });

  test("a null baseline value is skipped", () => {
    const baseline = [
      { name: "accuracy", direction: "up" as const, noiseEpsilon: 0.02, value: null },
    ];
    const current = [{ name: "accuracy", value: 0.1 }];
    assert.deepEqual(detectRegressions(baseline, current), []);
  });

  test("detects multiple regressions across mixed directions", () => {
    const baseline = [
      { name: "accuracy", direction: "up" as const, noiseEpsilon: 0.02, value: 0.6 },
      { name: "cost", direction: "down" as const, noiseEpsilon: 1, value: 10 },
    ];
    const current = [
      { name: "accuracy", value: 0.4 }, // dropped → regressed (up)
      { name: "cost", value: 20 }, // rose → regressed (down)
    ];
    const names = detectRegressions(baseline, current).map((r) => r.name).sort();
    assert.deepEqual(names, ["accuracy", "cost"]);
  });
});

// ---------------------------------------------------------------------------
// decideHoldback — the branching policy
// ---------------------------------------------------------------------------

function baselineFixture(
  overrides: Partial<HoldbackBaseline> = {},
): HoldbackBaseline {
  return {
    commitSha: "abc123",
    prNumber: 42,
    tier: 3,
    enrolledAt: 1_000_000,
    windowCycles: 2,
    leading: [
      { name: "accuracy", direction: "up", noiseEpsilon: 0.02, value: 0.6 },
    ],
    ...overrides,
  };
}

describe("decideHoldback", () => {
  test("no regression + window elapsed → passed", () => {
    // window = 2 cycles * default 1h = 2h; enrolledAt + 3h has elapsed.
    const input: DecideHoldbackInput = {
      baseline: baselineFixture(),
      current: [{ name: "accuracy", value: 0.65 }], // favorable rise
      revertCount: 0,
      nowMs: 1_000_000 + 3 * 60 * 60 * 1000,
    };
    const d = decideHoldback(input);
    assert.equal(d.decision, "passed");
    assert.equal(d.commitSha, "abc123");
  });

  test("no regression + window NOT elapsed → watching", () => {
    const input: DecideHoldbackInput = {
      baseline: baselineFixture(),
      current: [{ name: "accuracy", value: 0.65 }],
      revertCount: 0,
      nowMs: 1_000_000 + 30 * 60 * 1000, // 30min < 2h window
    };
    const d = decideHoldback(input);
    assert.equal(d.decision, "watching");
    assert.equal(d.commitSha, "abc123");
  });

  test("regression under the cap → revert (carries prNumber + regressedOutcomes)", () => {
    const input: DecideHoldbackInput = {
      baseline: baselineFixture(),
      current: [{ name: "accuracy", value: 0.3 }], // dropped → regressed
      revertCount: 0,
      nowMs: 1_000_000,
    };
    const d = decideHoldback(input);
    assert.equal(d.decision, "revert");
    if (d.decision === "revert") {
      assert.equal(d.commitSha, "abc123");
      assert.equal(d.prNumber, 42);
      assert.deepEqual(d.regressedOutcomes, ["accuracy"]);
    }
  });

  test("regression AT the per-day cap → cap-reached (revert suppressed)", () => {
    // Default HOLDBACK_MAX_REVERTS_PER_DAY = 3.
    const input: DecideHoldbackInput = {
      baseline: baselineFixture(),
      current: [{ name: "accuracy", value: 0.3 }],
      revertCount: 3,
      nowMs: 1_000_000,
    };
    const d = decideHoldback(input);
    assert.equal(d.decision, "cap-reached");
    if (d.decision === "cap-reached") {
      assert.deepEqual(d.regressedOutcomes, ["accuracy"]);
    }
  });

  test("regression above the cap → cap-reached", () => {
    const input: DecideHoldbackInput = {
      baseline: baselineFixture(),
      current: [{ name: "accuracy", value: 0.3 }],
      revertCount: 5,
      nowMs: 1_000_000,
    };
    assert.equal(decideHoldback(input).decision, "cap-reached");
  });

  test("regression takes priority over an elapsed window (never 'passed' while regressed)", () => {
    const input: DecideHoldbackInput = {
      baseline: baselineFixture(),
      current: [{ name: "accuracy", value: 0.3 }],
      revertCount: 0,
      nowMs: 1_000_000 + 100 * 60 * 60 * 1000, // long past the window
    };
    assert.equal(decideHoldback(input).decision, "revert");
  });

  test("defaults nowMs to Date.now() when omitted (elapsed window → passed)", () => {
    // enrolledAt=0 with a 1-cycle window is ~1h; real Date.now() is far later.
    const input: DecideHoldbackInput = {
      baseline: baselineFixture({ enrolledAt: 0, windowCycles: 1 }),
      current: [{ name: "accuracy", value: 0.65 }],
      revertCount: 0,
      // nowMs omitted → Date.now()
    };
    assert.equal(decideHoldback(input).decision, "passed");
  });

  test("null prNumber flows through the revert decision", () => {
    const input: DecideHoldbackInput = {
      baseline: baselineFixture({ prNumber: null }),
      current: [{ name: "accuracy", value: 0.3 }],
      revertCount: 0,
      nowMs: 1_000_000,
    };
    const d = decideHoldback(input);
    assert.equal(d.decision, "revert");
    if (d.decision === "revert") assert.equal(d.prNumber, null);
  });
});

describe("decideHoldback — window mapping honours HYDRA_HOLDBACK_CYCLE_MS", () => {
  const KEY = "HYDRA_HOLDBACK_CYCLE_MS";
  let saved: string | undefined;

  // The env var is read per-call inside cycleDurationMs(); snapshot + restore
  // around each case so a set value cannot leak into a sibling test.
  test("a larger cycle length keeps a clean window 'watching' longer", () => {
    saved = process.env[KEY];
    process.env[KEY] = String(10 * 60 * 60 * 1000); // 10h/cycle
    try {
      const input: DecideHoldbackInput = {
        baseline: baselineFixture({ windowCycles: 2 }), // window now 20h
        current: [{ name: "accuracy", value: 0.65 }],
        revertCount: 0,
        nowMs: 1_000_000 + 5 * 60 * 60 * 1000, // 5h < 20h
      };
      assert.equal(decideHoldback(input).decision, "watching");
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });
});
