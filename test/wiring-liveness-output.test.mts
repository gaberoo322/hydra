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
  productionOutputReader,
  extractNumericPath,
  type OutputSourceReader,
  type OutputSeriesResult,
} from "../src/scheduler/chores/wiring-liveness-output.ts";
import type { LivenessEntry, OutputEntry } from "../src/schemas/liveness.ts";

/** A minimal `Response`-like stand-in for the injected fetch. */
function fakeResponse(opts: {
  ok: boolean;
  status?: number;
  json?: unknown;
  jsonThrows?: boolean;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => {
      if (opts.jsonThrows) throw new Error("not JSON");
      return opts.json;
    },
  } as unknown as Response;
}

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

describe("wiring-liveness-output: extractNumericPath", () => {
  test("extracts a finite number at a dotted path", () => {
    assert.equal(extractNumericPath({ funnelBreakdown: { registryPairs: 42 } }, "funnelBreakdown.registryPairs"), 42);
  });
  test("missing path => undefined", () => {
    assert.equal(extractNumericPath({ funnelBreakdown: {} }, "funnelBreakdown.registryPairs"), undefined);
  });
  test("non-numeric leaf => undefined", () => {
    assert.equal(extractNumericPath({ a: { b: "12" } }, "a.b"), undefined);
  });
  test("non-finite leaf (NaN) => undefined", () => {
    assert.equal(extractNumericPath({ a: { b: Number.NaN } }, "a.b"), undefined);
  });
  test("descending through a non-object => undefined (never throws)", () => {
    assert.equal(extractNumericPath({ a: 5 }, "a.b.c"), undefined);
    assert.equal(extractNumericPath(null, "a"), undefined);
  });
});

describe("wiring-liveness-output: productionOutputReader (issue #2578)", () => {
  const entry = outputEntry("/api/scanner/latest", "funnelBreakdown.registryPairs", 0, 3);

  test("happy path: appends the fresh observation and returns the trailing series", async () => {
    const appends: number[] = [];
    const reader = productionOutputReader({
      fetchImpl: async () => fakeResponse({ ok: true, json: { funnelBreakdown: { registryPairs: 7 } } }),
      appendObservation: async (_s, _p, v) => {
        appends.push(v);
      },
      // Reader returns the accumulated series (most-recent-LAST), here including
      // the just-appended value.
      readSeries: async () => [3, 5, 7],
    });
    const res = await reader(entry);
    assert.deepEqual(appends, [7]);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.values, [3, 5, 7]);
  });

  test("non-2xx => {ok:false}, no append", async () => {
    let appended = 0;
    const reader = productionOutputReader({
      fetchImpl: async () => fakeResponse({ ok: false, status: 503 }),
      appendObservation: async () => {
        appended += 1;
      },
      readSeries: async () => [],
    });
    const res = await reader(entry);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /HTTP 503/);
    assert.equal(appended, 0);
  });

  test("network error => {ok:false}, no append", async () => {
    let appended = 0;
    const reader = productionOutputReader({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      appendObservation: async () => {
        appended += 1;
      },
      readSeries: async () => [],
    });
    const res = await reader(entry);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /fetch failed/);
    assert.equal(appended, 0);
  });

  test("malformed JSON => {ok:false}, no append", async () => {
    let appended = 0;
    const reader = productionOutputReader({
      fetchImpl: async () => fakeResponse({ ok: true, jsonThrows: true }),
      appendObservation: async () => {
        appended += 1;
      },
      readSeries: async () => [],
    });
    const res = await reader(entry);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /malformed JSON/);
    assert.equal(appended, 0);
  });

  test("missing/non-numeric jsonPath => {ok:false}, no append (Target outage never fabricates a zero)", async () => {
    let appended = 0;
    const reader = productionOutputReader({
      fetchImpl: async () => fakeResponse({ ok: true, json: { funnelBreakdown: {} } }),
      appendObservation: async () => {
        appended += 1;
      },
      readSeries: async () => [],
    });
    const res = await reader(entry);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /non-numeric jsonPath/);
    assert.equal(appended, 0);
  });

  test("a single accumulated value yields a short series => evaluateOutputs stays OK (young source)", async () => {
    // End-to-end through the pure evaluator: the reader has only one observation,
    // so the runs:3 window is not full and the verdict is OK, not below-floor.
    const reader = productionOutputReader({
      fetchImpl: async () => fakeResponse({ ok: true, json: { funnelBreakdown: { registryPairs: 0 } } }),
      appendObservation: async () => {},
      readSeries: async () => [0],
    });
    const res = await evaluateOutputs([entry], reader);
    assert.deepEqual(res.belowFloor, []);
    assert.equal(res.outputVerdicts[0].status, "ok");
  });
});
