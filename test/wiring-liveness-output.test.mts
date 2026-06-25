/**
 * Unit coverage for the wiring-liveness OUTPUT-check seam (issue #2456;
 * extracted from `test/wiring-liveness.test.mts`, originally landed by #2288).
 *
 * Self-contained top-level describes with their own lifecycle (CLAUDE.md
 * no-nested-shared-teardown rule). Touches no Redis, no live systemctl, no
 * network — the output-source reader is injected as a deterministic fake. Covers
 * the verdicts the design concept pins for the output path: BELOW-FLOOR
 * (the live-but-inert signal), AT-FLOOR, RECOVERED (no sticky false-positive),
 * trailing-window-only, not-enough-history, and UNREADABLE (reader failure,
 * distinct from a floor hit). Imports the evaluator directly from the focused
 * module so the test names the concept it owns rather than piggybacking on the
 * timer-check suite.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateOutputs,
  type OutputSourceReader,
  type OutputSeriesResult,
} from "../src/scheduler/chores/wiring-liveness-output.ts";
import type { LivenessEntry, OutputEntry } from "../src/schemas/liveness.ts";

function timerEntry(unit: string, maxStaleMinutes: number): LivenessEntry {
  return { unit, type: "timer", maxStaleMinutes };
}

function outputEntry(
  source: string,
  jsonPath: string,
  value: number,
  runs: number,
): OutputEntry {
  return { type: "output", source, jsonPath, minOverRuns: { value, runs } };
}

/** A deterministic source reader returning a fixed series (most-recent-LAST). */
function fakeReader(values: number[]): OutputSourceReader {
  return async (): Promise<OutputSeriesResult> => ({ ok: true, values });
}

describe("wiring-liveness-output: evaluateOutputs verdicts", () => {
  test("BELOW-FLOOR: every value in the window at the floor => flagged", async () => {
    // The seed regression: registryPairs pinned at 0 across the last 3 runs.
    const entries = [outputEntry("/api/scanner/latest", "funnelBreakdown.registryPairs", 0, 3)];
    const res = await evaluateOutputs(entries, fakeReader([0, 0, 0]));
    assert.deepEqual(res.belowFloor, ["/api/scanner/latest"]);
    assert.deepEqual(res.unreadable, []);
    assert.equal(res.outputVerdicts[0].status, "below-floor");
  });

  test("AT-FLOOR (non-zero floor): values equal to the floor count as a hit", async () => {
    const entries = [outputEntry("/api/x", "a.b", 5, 3)];
    const res = await evaluateOutputs(entries, fakeReader([5, 4, 5]));
    assert.deepEqual(res.belowFloor, ["/api/x"]);
    assert.equal(res.outputVerdicts[0].status, "below-floor");
  });

  test("RECOVERED: one value above the floor in the window clears the alert", async () => {
    // Most-recent value is above the floor => OK, no sticky false-positive.
    const entries = [outputEntry("/api/scanner/latest", "funnelBreakdown.registryPairs", 0, 3)];
    const res = await evaluateOutputs(entries, fakeReader([0, 0, 7]));
    assert.deepEqual(res.belowFloor, []);
    assert.equal(res.outputVerdicts[0].status, "ok");
    if (res.outputVerdicts[0].status === "ok") {
      assert.equal(res.outputVerdicts[0].latest, 7);
    }
  });

  test("only the trailing `runs` values matter: an old zero outside the window is ignored", async () => {
    // window=3, series=[0, 9, 9, 9] => last 3 are all above floor => OK.
    const entries = [outputEntry("/api/x", "a.b", 0, 3)];
    const res = await evaluateOutputs(entries, fakeReader([0, 9, 9, 9]));
    assert.deepEqual(res.belowFloor, []);
    assert.equal(res.outputVerdicts[0].status, "ok");
  });

  test("not enough history (series shorter than runs) => OK, never flagged", async () => {
    const entries = [outputEntry("/api/x", "a.b", 0, 3)];
    const res = await evaluateOutputs(entries, fakeReader([0, 0]));
    assert.deepEqual(res.belowFloor, []);
    assert.equal(res.outputVerdicts[0].status, "ok");
  });

  test("reader failure => UNREADABLE, distinct from a floor hit", async () => {
    const entries = [outputEntry("/api/x", "a.b", 0, 3)];
    const read: OutputSourceReader = async () => ({ ok: false, reason: "source 503" });
    const res = await evaluateOutputs(entries, read);
    assert.deepEqual(res.belowFloor, []);
    assert.deepEqual(res.unreadable, ["/api/x"]);
    assert.equal(res.outputVerdicts[0].status, "unreadable");
  });

  test("timer entries are ignored by the output evaluator", async () => {
    const res = await evaluateOutputs([timerEntry("a.timer", 60)], fakeReader([0, 0, 0]));
    assert.deepEqual(res.belowFloor, []);
    assert.deepEqual(res.unreadable, []);
    assert.deepEqual(res.outputVerdicts, []);
  });
});
