/**
 * Regression tests for the builder-health stagnation detector (issue #3287,
 * epic #3285). `computeStagnation` is a pure, dependency-free reducer — tested
 * directly with hand-built series. Covers the five acceptance criteria and the
 * seven ADR-0028 invariants from the approved design concept (issue-3287).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computeStagnation,
  type StagnationOptions,
} from "../src/aggregators/builder-health-stagnation.ts";

// A conservative baseline of options; individual cases override.
const OPTS = (o: Partial<StagnationOptions>): StagnationOptions => ({
  direction: "down",
  band: 0.05,
  sustain: 3,
  minBaselineCycles: 5,
  baselineWindow: 50,
  ...o,
});

describe("computeStagnation — cold-start suppression (AC2)", () => {
  test("series shorter than minBaselineCycles returns 'warming', not a breach", () => {
    const r = computeStagnation([0.9, 0.1, 0.05, 0.02], OPTS({ minBaselineCycles: 5 }));
    assert.equal(r.state, "warming");
    assert.equal(r.sustainedCycles, 0);
    assert.equal(r.baseline, null);
    assert.equal(r.current, 0.02); // still reports the newest value
  });

  test("empty series returns 'warming' with null current + baseline", () => {
    const r = computeStagnation([], OPTS({ minBaselineCycles: 5 }));
    assert.equal(r.state, "warming");
    assert.equal(r.current, null);
    assert.equal(r.baseline, null);
    assert.equal(r.sustainedCycles, 0);
  });

  test("exactly minBaselineCycles of history is NOT warming", () => {
    const r = computeStagnation([0.8, 0.8, 0.8, 0.8, 0.8], OPTS({ minBaselineCycles: 5 }));
    assert.notEqual(r.state, "warming");
  });
});

describe("computeStagnation — sustain requirement (AC1)", () => {
  const flat = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8];

  test("a single sub-band excursion does NOT breach", () => {
    const series = [...flat, 0.5]; // one bad cycle at the end
    const r = computeStagnation(series, OPTS({ sustain: 3, band: 0.1 }));
    assert.equal(r.sustainedCycles, 1);
    assert.equal(r.state, "ok");
  });

  test("sustain-1 worse cycles is still 'ok'; exactly sustain flips to 'breach'", () => {
    const two = computeStagnation([...flat, 0.5, 0.45], OPTS({ sustain: 3, band: 0.1 }));
    assert.equal(two.sustainedCycles, 2);
    assert.equal(two.state, "ok");

    const three = computeStagnation([...flat, 0.5, 0.45, 0.4], OPTS({ sustain: 3, band: 0.1 }));
    assert.equal(three.sustainedCycles, 3);
    assert.equal(three.state, "breach");
  });

  test("a recovered most-recent cycle resets the consecutive count to 0", () => {
    // three bad cycles, then a recovery -> counting from newest stops at 0.
    const series = [...flat, 0.5, 0.45, 0.4, 0.85];
    const r = computeStagnation(series, OPTS({ sustain: 3, band: 0.1 }));
    assert.equal(r.sustainedCycles, 0);
    assert.equal(r.state, "ok");
  });
});

describe("computeStagnation — strict band boundary / flat-at-baseline (AC3)", () => {
  test("a signal flat at its own baseline returns 'ok' (documented blind spot)", () => {
    const r = computeStagnation([0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7], OPTS({ band: 0.05, sustain: 2 }));
    assert.equal(r.state, "ok");
    assert.equal(r.sustainedCycles, 0);
    assert.ok(Math.abs((r.baseline ?? NaN) - 0.7) < 1e-9);
    assert.equal(r.current, 0.7);
  });

  test("a value exactly `band` away from baseline is NOT worse (strict)", () => {
    // baseline of the preceding flat run is 0.8; current is exactly 0.8 - band.
    const series = [0.8, 0.8, 0.8, 0.8, 0.8, 0.75];
    const r = computeStagnation(series, OPTS({ band: 0.05, sustain: 1 }));
    assert.equal(r.sustainedCycles, 0);
    assert.equal(r.state, "ok");
  });

  test("a value strictly beyond `band` IS worse", () => {
    const series = [0.8, 0.8, 0.8, 0.8, 0.8, 0.74];
    const r = computeStagnation(series, OPTS({ band: 0.05, sustain: 1 }));
    assert.equal(r.sustainedCycles, 1);
    assert.equal(r.state, "breach");
  });
});

describe("computeStagnation — direction awareness (AC4)", () => {
  test("a falling autonomy series (direction 'down') breaches", () => {
    // steady ~0.9, then a sustained fall.
    const series = [0.9, 0.9, 0.9, 0.9, 0.9, 0.6, 0.55, 0.5];
    const r = computeStagnation(series, OPTS({ direction: "down", band: 0.1, sustain: 3 }));
    assert.equal(r.state, "breach");
    assert.equal(r.sustainedCycles, 3);
  });

  test("a falling series does NOT breach when direction is 'up'", () => {
    const series = [0.9, 0.9, 0.9, 0.9, 0.9, 0.6, 0.55, 0.5];
    const r = computeStagnation(series, OPTS({ direction: "up", band: 0.1, sustain: 3 }));
    assert.equal(r.state, "ok");
    assert.equal(r.sustainedCycles, 0);
  });

  test("a rising rework series (direction 'up') breaches", () => {
    // steady ~0.1 rework, then a sustained climb.
    const series = [0.1, 0.1, 0.1, 0.1, 0.1, 0.4, 0.45, 0.5];
    const r = computeStagnation(series, OPTS({ direction: "up", band: 0.1, sustain: 3 }));
    assert.equal(r.state, "breach");
    assert.equal(r.sustainedCycles, 3);
  });

  test("a rising series does NOT breach when direction is 'down'", () => {
    const series = [0.1, 0.1, 0.1, 0.1, 0.1, 0.4, 0.45, 0.5];
    const r = computeStagnation(series, OPTS({ direction: "down", band: 0.1, sustain: 3 }));
    assert.equal(r.state, "ok");
    assert.equal(r.sustainedCycles, 0);
  });
});

describe("computeStagnation — baseline excludes the current point (ADR-0028 Decision 2)", () => {
  test("the excursion under test never dilutes its own baseline", () => {
    // If the current point were included, the baseline would be pulled toward
    // the low values and the breach would be muted. Excluding it keeps the
    // baseline high so the drop is detected.
    const series = [1.0, 1.0, 1.0, 1.0, 1.0, 0.5];
    const r = computeStagnation(series, OPTS({ band: 0.1, sustain: 1 }));
    // reported baseline is the mean of the preceding flat run, not blended.
    assert.equal(r.baseline, 1.0);
    assert.equal(r.current, 0.5);
    assert.equal(r.sustainedCycles, 1);
    assert.equal(r.state, "breach");
  });

  test("baselineWindow bounds how far back the trailing mean reaches", () => {
    // With a window of 2, only the two preceding values feed the baseline.
    const series = [0.0, 0.0, 1.0, 1.0, 0.5];
    const r = computeStagnation(
      series,
      OPTS({ band: 0.1, sustain: 1, baselineWindow: 2, minBaselineCycles: 3 }),
    );
    // baseline for current is mean of [1.0, 1.0] = 1.0 (the far-back zeros are
    // outside the window).
    assert.equal(r.baseline, 1.0);
    assert.equal(r.state, "breach");
  });
});

describe("computeStagnation — purity + robustness (never throws)", () => {
  test("does not throw on a malformed option bag and falls back to defaults", () => {
    const r = computeStagnation(
      [0.8, 0.8, 0.8, 0.8, 0.8, 0.4],
      // @ts-expect-error deliberately malformed to exercise the fallback path
      { direction: "sideways", band: NaN, sustain: 0, minBaselineCycles: -1, baselineWindow: 0 },
    );
    // direction falls back to 'down', band->0, sustain->1, minBaselineCycles->1,
    // baselineWindow->default. A drop below a zero-band baseline breaches.
    assert.equal(r.state, "breach");
    assert.equal(r.sustainedCycles, 1);
  });

  test("does not mutate the input series", () => {
    const series = [0.8, 0.8, 0.8, 0.8, 0.8, 0.4, 0.35];
    const copy = [...series];
    computeStagnation(series, OPTS({}));
    assert.deepEqual(series, copy);
  });
});
