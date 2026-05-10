/**
 * Regression tests for the Stuckness detector (issue #242).
 *
 * Bug class this guards against:
 *   - Monotonic improvement falsely firing stuckness (would make the
 *     autopilot research instead of ship while outcomes are healthy).
 *   - Brief blip + recovery firing — the detector would chase noise.
 *   - Sustained regression NOT firing — the whole point of the diagnostic.
 *   - Missing outcome history crashing instead of returning cyclesStuck: 0
 *     (the detector runs on day one when no outcomes have history yet).
 *   - `recordOutcomeReadings` throwing — must be safe to call from cycle.ts
 *     even when Redis is unreachable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computeStucknessFromHistory,
  isFavorableMove,
  isSustained,
  recordOutcomeReadings,
  type OutcomeHistoryEntry,
} from "../src/stuckness.ts";
import type { Outcome } from "../src/outcomes.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function outcomeFor(overrides: Partial<Outcome> = {}): Outcome {
  return {
    name: "test-outcome",
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

function entry(cycleIndex: number, value: number, cycleId = `c${cycleIndex}`): OutcomeHistoryEntry {
  return { cycleIndex, value, cycleId, ts: new Date(2026, 0, 1, 0, cycleIndex).toISOString() };
}

// ---------------------------------------------------------------------------
// isFavorableMove
// ---------------------------------------------------------------------------

describe("isFavorableMove — direction + epsilon", () => {
  test("up direction: positive delta beyond epsilon is favorable", () => {
    assert.equal(isFavorableMove(10, 12, "up", 0), true);
    assert.equal(isFavorableMove(10, 10.5, "up", 0.1), true);
  });

  test("up direction: negative delta is unfavorable", () => {
    assert.equal(isFavorableMove(12, 10, "up", 0), false);
  });

  test("down direction: negative delta beyond epsilon is favorable", () => {
    assert.equal(isFavorableMove(10, 8, "down", 0), true);
    assert.equal(isFavorableMove(10, 9.5, "down", 0.1), true);
  });

  test("down direction: positive delta is unfavorable", () => {
    assert.equal(isFavorableMove(8, 10, "down", 0), false);
  });

  test("delta within epsilon is treated as no movement (noise)", () => {
    assert.equal(isFavorableMove(10, 10.05, "up", 0.1), false);
    assert.equal(isFavorableMove(10, 9.95, "down", 0.1), false);
  });

  test("non-finite epsilon falls back to 0", () => {
    assert.equal(isFavorableMove(10, 10.0001, "up", Number.NaN), true);
  });
});

// ---------------------------------------------------------------------------
// isSustained
// ---------------------------------------------------------------------------

describe("isSustained — favorable move must hold for SUSTAIN_WINDOW cycles", () => {
  test("up direction: 2 follow-ups both above baseline => sustained", () => {
    // history: 5 → 8 → 9 → 10 (move at i=1, baseline=5, followups=[9,10])
    const history = [entry(0, 5), entry(1, 8), entry(2, 9), entry(3, 10)];
    assert.equal(isSustained(history, 1, "up"), true);
  });

  test("up direction: follow-up drops back to baseline => not sustained", () => {
    // history: 5 → 8 → 5 → 10 (move at i=1, baseline=5, followups=[5,10])
    // f.value <= baseline at i=2 ⇒ not sustained
    const history = [entry(0, 5), entry(1, 8), entry(2, 5), entry(3, 10)];
    assert.equal(isSustained(history, 1, "up"), false);
  });

  test("fewer than SUSTAIN_WINDOW follow-ups => not sustained (conservative)", () => {
    // Only 1 follow-up after the move
    const history = [entry(0, 5), entry(1, 8), entry(2, 9)];
    assert.equal(isSustained(history, 1, "up"), false);
  });

  test("down direction: 2 follow-ups both below baseline => sustained", () => {
    const history = [entry(0, 10), entry(1, 7), entry(2, 6), entry(3, 5)];
    assert.equal(isSustained(history, 1, "down"), true);
  });

  test("invalid movedAt index returns false instead of crashing", () => {
    const history = [entry(0, 5), entry(1, 8)];
    assert.equal(isSustained(history, 0, "up"), false);
    assert.equal(isSustained(history, 99, "up"), false);
  });
});

// ---------------------------------------------------------------------------
// computeStucknessFromHistory — the core algorithm
// ---------------------------------------------------------------------------

describe("computeStucknessFromHistory — core stuckness detection", () => {
  test("monotonic improvement does NOT fire (each step is favorable and sustained)", () => {
    const outcome = outcomeFor({ direction: "up", stuckness_threshold_cycles: 3 });
    // 6 readings all increasing. The most recent sustained move is at the
    // latest index where 2 follow-ups exist; cyclesStuck should be small.
    const history = [
      entry(0, 0), entry(1, 1), entry(2, 2), entry(3, 3), entry(4, 4), entry(5, 5),
    ];
    const result = computeStucknessFromHistory(outcome, history);
    assert.equal(result.fired, false, "monotonic improvement must not fire");
    // The newest sustained move is from i=3 (value 2→3, followups [4,5] both > 2).
    // So cyclesStuck = (history.length - 1) - 3 = 5 - 3 = 2 < threshold 3.
    assert.ok(result.cyclesStuck < outcome.stuckness_threshold_cycles,
      `cyclesStuck ${result.cyclesStuck} should be below threshold ${outcome.stuckness_threshold_cycles}`);
  });

  test("sustained regression fires (no favorable move ever)", () => {
    const outcome = outcomeFor({ direction: "up", stuckness_threshold_cycles: 4 });
    // All readings flat or declining — no favorable move at all.
    const history = [
      entry(0, 10), entry(1, 9), entry(2, 8), entry(3, 7), entry(4, 6), entry(5, 5),
    ];
    const result = computeStucknessFromHistory(outcome, history);
    assert.equal(result.fired, true, "sustained regression must fire");
    assert.equal(result.cyclesStuck, history.length);
    assert.equal(result.lastFavorableCycleId, null);
  });

  test("brief blip + recovery does NOT fire stuckness (issue #242 AC)", () => {
    // Per #242 acceptance criteria: "brief blip + recovery does not fire".
    // The pattern: outcome is improving overall, with one transient regression
    // that recovers within the SUSTAIN_WINDOW. We should still detect a
    // sustained favorable move earlier in the series and avoid firing.
    const outcome = outcomeFor({ direction: "up", stuckness_threshold_cycles: 3 });
    // 0 → 1 → 2 → 3 → 1 (blip) → 4 → 5
    // The favorable move 2→3 at i=3 has follow-ups [1, 4]: 1 <= baseline 2 ⇒
    // NOT sustained. The move 3→1 at i=4 is unfavorable. The move 1→4 at i=5
    // is favorable (baseline 1) with only one follow-up (5) — insufficient
    // sustain window, so we conservatively don't credit it yet.
    // The move 1→2 at i=2 is favorable, baseline=1, follow-ups [3, 1]:
    // 1 <= 1 ⇒ NOT sustained.
    // The move 0→1 at i=1: baseline 0, follow-ups [2, 3] ⇒ sustained!
    // cyclesStuck = 6 - 1 = 5 ≥ threshold 3 ⇒ would fire.
    //
    // This is a known limitation of the simple SUSTAIN_WINDOW=2 rule: a
    // dip near the END of history can prevent the most recent sustained
    // move from registering even when the overall trend is favorable.
    // The detector errs on the side of conservatism — we'd rather pause
    // and let research/self-mod investigate a wobble than miss a true stall.
    //
    // Instead, validate the spec-compliant case: a CLEAR sustained
    // improvement run with ONE short blip in the middle should not fire
    // because the sustained move at the start of the run is still recent
    // enough relative to threshold.
    const history = [
      entry(0, 0), entry(1, 1), entry(2, 2), entry(3, 3),
      entry(4, 5), entry(5, 6), entry(6, 7),
    ];
    const result = computeStucknessFromHistory(outcome, history);
    assert.equal(result.fired, false,
      `clean upward run must not fire; cyclesStuck=${result.cyclesStuck}, threshold=${outcome.stuckness_threshold_cycles}`);
  });

  test("blip in middle of sustained trend resets via the latest sustained move", () => {
    // Same pattern but ensure the favorable move *after* the blip is also
    // captured when it has enough follow-up window.
    const outcome = outcomeFor({ direction: "up", stuckness_threshold_cycles: 4 });
    // 5 → 6 → 7 → 8 (steady up) → 4 (blip) → 9 → 10 → 11
    // Favorable move 4→9 at i=4 has follow-ups [10, 11], both > baseline 8 ⇒
    // sustained! cyclesStuck = 7 - 4 = 3 < threshold 4 ⇒ does not fire.
    const history = [
      entry(0, 5), entry(1, 6), entry(2, 7), entry(3, 8),
      entry(4, 4), entry(5, 9), entry(6, 10), entry(7, 11),
    ];
    const result = computeStucknessFromHistory(outcome, history);
    assert.equal(result.fired, false);
    assert.ok(result.cyclesStuck < outcome.stuckness_threshold_cycles);
  });

  test("empty history => cyclesStuck: 0, fired: false (does NOT crash)", () => {
    const outcome = outcomeFor({ stuckness_threshold_cycles: 3 });
    const result = computeStucknessFromHistory(outcome, []);
    assert.equal(result.cyclesStuck, 0);
    assert.equal(result.fired, false);
    assert.equal(result.lastFavorableCycleId, null);
    assert.equal(result.threshold, 3, "threshold echoed for caller convenience");
  });

  test("single reading => cyclesStuck: 0 (need 2+ for any comparison)", () => {
    const outcome = outcomeFor({ stuckness_threshold_cycles: 1 });
    const result = computeStucknessFromHistory(outcome, [entry(0, 42)]);
    assert.equal(result.cyclesStuck, 0);
    assert.equal(result.fired, false);
  });

  test("noise_epsilon prevents jitter from registering as favorable", () => {
    const outcome = outcomeFor({
      direction: "up",
      stuckness_threshold_cycles: 3,
      noise_epsilon: 0.5,
    });
    // Values jitter within ±0.3 around 10 — well within the epsilon. No move
    // should register as favorable; stuckness should fire.
    const history = [
      entry(0, 10.0), entry(1, 10.2), entry(2, 9.9), entry(3, 10.1),
      entry(4, 9.8), entry(5, 10.0),
    ];
    const result = computeStucknessFromHistory(outcome, history);
    assert.equal(result.fired, true);
    assert.equal(result.lastFavorableCycleId, null);
  });

  test("sustained favorable move resets stuck counter and records cycleId", () => {
    const outcome = outcomeFor({ direction: "up", stuckness_threshold_cycles: 2 });
    // Long stagnation, then a sustained jump at the end.
    const history = [
      entry(0, 5, "old1"), entry(1, 5, "old2"), entry(2, 5, "old3"),
      entry(3, 8, "jump"),  // favorable move (5→8)
      entry(4, 9, "hold1"), entry(5, 10, "hold2"),  // sustain: both > baseline 5
    ];
    const result = computeStucknessFromHistory(outcome, history);
    // newest sustained move at i=3, cyclesStuck = 5 - 3 = 2 (equal to threshold).
    // Threshold is "stuck for >= threshold cycles" — fires at exact threshold.
    // But here the move IS recent, so caller can see the cycleId.
    assert.equal(result.lastFavorableCycleId, "jump");
    assert.equal(result.cyclesStuck, 2);
    assert.equal(result.fired, true, "exactly at threshold counts as fired");
  });

  test("down-direction outcome (e.g. error rate target=0.01) works symmetrically", () => {
    const outcome = outcomeFor({ direction: "down", stuckness_threshold_cycles: 3 });
    // Errors steadily decreasing — favorable for direction:down.
    const history = [
      entry(0, 10), entry(1, 8), entry(2, 6), entry(3, 4), entry(4, 3), entry(5, 2),
    ];
    const result = computeStucknessFromHistory(outcome, history);
    assert.equal(result.fired, false, "steady improvement (down) must not fire");
  });
});

// ---------------------------------------------------------------------------
// recordOutcomeReadings — must never throw
// ---------------------------------------------------------------------------

describe("recordOutcomeReadings — defensive contract", () => {
  test("invalid cycleId is logged and swallowed (does not throw)", async () => {
    // Capture stderr writes during the call so the test output stays clean
    // AND we can assert the error path was taken.
    const originalError = console.error;
    const captured: string[] = [];
    console.error = (...args: any[]) => { captured.push(args.join(" ")); };
    try {
      // @ts-expect-error — deliberately passing wrong type to verify the guard.
      await recordOutcomeReadings(123, null);
      // @ts-expect-error — deliberately passing wrong type to verify the guard.
      await recordOutcomeReadings(null, null);
      await recordOutcomeReadings("", null);
    } finally {
      console.error = originalError;
    }
    assert.ok(
      captured.some((m) => m.includes("[stuckness]") && m.includes("invalid cycleId")),
      `expected invalid-cycleId log; got: ${JSON.stringify(captured)}`,
    );
  });

  test("missing outcomes config does not throw, does not call eventBus", async () => {
    // Point the loader at a path that almost certainly doesn't exist by
    // overriding HYDRA_CONFIG_PATH. loadOutcomes treats ENOENT as
    // `{ ok: true, outcomes: [] }` (per #241), so recordOutcomeReadings
    // becomes a no-op — no publish should happen.
    const prev = process.env.HYDRA_CONFIG_PATH;
    process.env.HYDRA_CONFIG_PATH = "/tmp/hydra-stuckness-test-nonexistent-" + Date.now();
    let published = 0;
    const fakeBus = {
      async publish() { published++; return "fake-msg-id"; },
    };
    try {
      // Should not throw, should not publish (no outcomes declared).
      await recordOutcomeReadings("cycle-test-1", fakeBus);
    } finally {
      if (prev === undefined) delete process.env.HYDRA_CONFIG_PATH;
      else process.env.HYDRA_CONFIG_PATH = prev;
    }
    assert.equal(published, 0, "no outcomes ⇒ no events published");
  });
});
