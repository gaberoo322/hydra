/**
 * Unit coverage for the wiring-liveness chore (issue #2287).
 *
 * Self-contained top-level describe with its own lifecycle (CLAUDE.md
 * no-nested-shared-teardown rule). Touches no Redis, no live systemctl — the
 * list-timers reader is injected as a fake and the manifest loader is injected
 * or pointed at a temp fixture file. Covers the four distinct verdicts the
 * design concept pins: PRESENT/FRESH (ok), MISSING, STALE, and the
 * NOT-YET-FIRED false-positive guard — plus malformed-manifest (typed error,
 * not a throw) and host-probe-failure routing.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseLivenessYaml,
  loadLivenessManifest,
  diffTimers,
  evaluateOutputs,
  runWiringLiveness,
  type WiringLivenessResult,
  type OutputSourceReader,
  type OutputSeriesResult,
} from "../src/scheduler/chores/wiring-liveness.ts";
import type { TimerRecord, ProbeResult } from "../src/host-probe/probe.ts";
import type { LivenessEntry, OutputEntry } from "../src/schemas/liveness.ts";

/** Build a TimerRecord; `lastMs` is epoch-MS, converted to the micros the seam emits. */
function liveTimer(unit: string, lastMs: number | null): TimerRecord {
  return { unit, last: lastMs === null ? 0 : lastMs * 1000, next: 0 };
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

describe("wiring-liveness: YAML-subset parser", () => {
  test("parses entries with comments and quoted descriptions", () => {
    const raw = [
      "# header comment",
      "entries:",
      "  - unit: a.timer  # trailing comment",
      "    type: timer",
      "    maxStaleMinutes: 60",
      '    description: "has # hash inside quotes"',
      "  - unit: b.timer",
      "    type: timer",
      "    maxStaleMinutes: 120",
    ].join("\n");
    const res = parseLivenessYaml(raw);
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(res.value.entries?.length, 2);
    assert.equal(res.value.entries?.[0].unit, "a.timer");
    assert.equal(res.value.entries?.[0].maxStaleMinutes, 60);
    assert.equal(res.value.entries?.[0].description, "has # hash inside quotes");
    assert.equal(res.value.entries?.[1].unit, "b.timer");
  });

  test("accumulates errors on unknown top-level key, never throws", () => {
    const res = parseLivenessYaml("bogus:\n  - unit: x.timer");
    assert.equal(res.ok, false);
    assert.ok(res.errors.length > 0);
  });
});

describe("wiring-liveness: manifest load + schema validation", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "wiring-liveness-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads a valid manifest", async () => {
    const p = join(dir, "valid.yaml");
    await writeFile(
      p,
      "entries:\n  - unit: a.timer\n    type: timer\n    maxStaleMinutes: 60\n",
      "utf-8",
    );
    const res = await loadLivenessManifest(p);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.manifest.entries.length, 1);
      const entry = res.manifest.entries[0];
      assert.equal(entry.type, "timer");
      if (entry.type === "timer") assert.equal(entry.unit, "a.timer");
    }
  });

  test("malformed manifest yields a typed reason, not a throw", async () => {
    const p = join(dir, "bad.yaml");
    // maxStaleMinutes is a string here — schema requires a positive number.
    await writeFile(
      p,
      'entries:\n  - unit: a.timer\n    type: timer\n    maxStaleMinutes: "not-a-number"\n',
      "utf-8",
    );
    const res = await loadLivenessManifest(p);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /schema validation failed/);
  });

  test("missing file yields a typed reason, not a throw", async () => {
    const res = await loadLivenessManifest(join(dir, "does-not-exist.yaml"));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /cannot read manifest/);
  });
});

describe("wiring-liveness: diffTimers verdicts", () => {
  const NOW = 1_700_000_000_000; // realistic epoch-ms reference

  test("present and fresh => ok, zero alerts", () => {
    const entries = [timerEntry("a.timer", 60)];
    const live = [liveTimer("a.timer", NOW - 30 * 60_000)]; // 30m ago, window 60m
    const res = diffTimers(entries, live, NOW);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.stale, []);
    assert.deepEqual(res.notYetFired, []);
    assert.equal(res.verdicts[0].status, "ok");
  });

  test("declared but absent from live set => missing", () => {
    const entries = [timerEntry("gone.timer", 60)];
    const res = diffTimers(entries, [], NOW);
    assert.deepEqual(res.missing, ["gone.timer"]);
    assert.equal(res.verdicts[0].status, "missing");
  });

  test("present but staler than window => stale", () => {
    const entries = [timerEntry("a.timer", 60)];
    const live = [liveTimer("a.timer", NOW - 120 * 60_000)]; // 120m ago, window 60m
    const res = diffTimers(entries, live, NOW);
    assert.deepEqual(res.stale, ["a.timer"]);
    assert.equal(res.verdicts[0].status, "stale");
  });

  test("FALSE-POSITIVE GUARD: present but never fired (last:0) => not-yet-fired, NOT stale", () => {
    const entries = [timerEntry("fresh-install.timer", 60)];
    const live = [liveTimer("fresh-install.timer", null)]; // last == 0
    const res = diffTimers(entries, live, NOW);
    assert.deepEqual(res.notYetFired, ["fresh-install.timer"]);
    assert.deepEqual(res.stale, [], "a never-fired timer must NOT be flagged stale");
    assert.deepEqual(res.missing, [], "a never-fired timer is present, not missing");
    assert.equal(res.verdicts[0].status, "not-yet-fired");
  });

  test("mixed manifest classifies each entry independently", () => {
    const entries = [
      timerEntry("ok.timer", 60),
      timerEntry("missing.timer", 60),
      timerEntry("stale.timer", 60),
      timerEntry("new.timer", 60),
    ];
    const live = [
      liveTimer("ok.timer", NOW - 10 * 60_000),
      liveTimer("stale.timer", NOW - 999 * 60_000),
      liveTimer("new.timer", null),
    ];
    const res = diffTimers(entries, live, NOW);
    assert.deepEqual(res.missing, ["missing.timer"]);
    assert.deepEqual(res.stale, ["stale.timer"]);
    assert.deepEqual(res.notYetFired, ["new.timer"]);
  });
});

describe("wiring-liveness: runWiringLiveness (never-throws)", () => {
  const NOW = 1_700_000_000_000;
  const okManifest = {
    ok: true as const,
    manifest: { entries: [timerEntry("a.timer", 60)] },
  };

  test("all-present/all-fresh => evaluated, zero alerts", async () => {
    const res = await runWiringLiveness({
      loadManifest: async () => okManifest,
      readTimers: async (): Promise<ProbeResult<TimerRecord[]>> => ({
        ok: true,
        data: [liveTimer("a.timer", NOW - 10 * 60_000)],
      }),
      now: () => NOW,
    });
    assert.equal(res.evaluated, true);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.stale, []);
  });

  test("flags missing + stale", async () => {
    const res = await runWiringLiveness({
      loadManifest: async () => ({
        ok: true,
        manifest: { entries: [timerEntry("a.timer", 60), timerEntry("gone.timer", 60)] },
      }),
      readTimers: async (): Promise<ProbeResult<TimerRecord[]>> => ({
        ok: true,
        data: [liveTimer("a.timer", NOW - 999 * 60_000)],
      }),
      now: () => NOW,
    });
    assert.equal(res.evaluated, true);
    assert.deepEqual(res.missing, ["gone.timer"]);
    assert.deepEqual(res.stale, ["a.timer"]);
  });

  test("manifest load failure => evaluated:false with reason, never throws", async () => {
    const res = await runWiringLiveness({
      loadManifest: async () => ({ ok: false, reason: "manifest parse errors: line 1" }),
      readTimers: async (): Promise<ProbeResult<TimerRecord[]>> => ({ ok: true, data: [] }),
    });
    assert.equal(res.evaluated, false);
    assert.match(res.reason ?? "", /manifest parse errors/);
  });

  test("host-probe failure => evaluated:false with reason, never throws", async () => {
    const res = await runWiringLiveness({
      loadManifest: async () => okManifest,
      readTimers: async (): Promise<ProbeResult<TimerRecord[]>> => ({
        ok: false,
        code: "host-probe-timeout",
      }),
    });
    assert.equal(res.evaluated, false);
    assert.match(res.reason ?? "", /host-probe-timeout/);
  });

  test("a throwing dep is caught => evaluated:false, never propagates", async () => {
    const res: WiringLivenessResult = await runWiringLiveness({
      loadManifest: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(res.evaluated, false);
    assert.match(res.reason ?? "", /boom/);
  });
});

// ===========================================================================
// Slice 2 (#2288): output check — semantic live-but-inert detection.
// ===========================================================================

describe("wiring-liveness: YAML-subset parser (output + nested minOverRuns)", () => {
  test("parses an output entry with a nested minOverRuns mapping", () => {
    const raw = [
      "entries:",
      "  - type: output",
      "    source: /api/scanner/latest",
      "    jsonPath: funnelBreakdown.registryPairs",
      "    minOverRuns:",
      "      value: 0",
      "      runs: 3",
      '    description: "scanner funnel gate"',
    ].join("\n");
    const res = parseLivenessYaml(raw);
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(res.value.entries?.length, 1);
    const e = res.value.entries?.[0] as Record<string, unknown>;
    assert.equal(e.type, "output");
    assert.equal(e.source, "/api/scanner/latest");
    assert.equal(e.jsonPath, "funnelBreakdown.registryPairs");
    assert.deepEqual(e.minOverRuns, { value: 0, runs: 3 });
    assert.equal(e.description, "scanner funnel gate");
  });

  test("parses a mixed manifest of timer and output entries", () => {
    const raw = [
      "entries:",
      "  - unit: a.timer",
      "    type: timer",
      "    maxStaleMinutes: 60",
      "  - type: output",
      "    source: /api/x",
      "    jsonPath: a.b",
      "    minOverRuns:",
      "      value: 5",
      "      runs: 2",
    ].join("\n");
    const res = parseLivenessYaml(raw);
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(res.value.entries?.length, 2);
    assert.equal(res.value.entries?.[0].type, "timer");
    assert.equal(res.value.entries?.[1].type, "output");
    assert.deepEqual(res.value.entries?.[1].minOverRuns, { value: 5, runs: 2 });
  });
});

describe("wiring-liveness: output manifest load + schema validation", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "wiring-liveness-output-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads a valid output entry into the discriminated union", async () => {
    const p = join(dir, "output.yaml");
    await writeFile(
      p,
      [
        "entries:",
        "  - type: output",
        "    source: /api/scanner/latest",
        "    jsonPath: funnelBreakdown.registryPairs",
        "    minOverRuns:",
        "      value: 0",
        "      runs: 3",
        "",
      ].join("\n"),
      "utf-8",
    );
    const res = await loadLivenessManifest(p);
    assert.equal(res.ok, true);
    if (res.ok) {
      const entry = res.manifest.entries[0];
      assert.equal(entry.type, "output");
      if (entry.type === "output") {
        assert.equal(entry.source, "/api/scanner/latest");
        assert.equal(entry.jsonPath, "funnelBreakdown.registryPairs");
        assert.equal(entry.minOverRuns.value, 0);
        assert.equal(entry.minOverRuns.runs, 3);
      }
    }
  });

  test("output entry missing minOverRuns yields a typed reason, not a throw", async () => {
    const p = join(dir, "bad-output.yaml");
    await writeFile(
      p,
      [
        "entries:",
        "  - type: output",
        "    source: /api/x",
        "    jsonPath: a.b",
        "",
      ].join("\n"),
      "utf-8",
    );
    const res = await loadLivenessManifest(p);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /schema validation failed/);
  });

  test("output entry with non-integer runs is rejected", async () => {
    const p = join(dir, "bad-runs.yaml");
    await writeFile(
      p,
      [
        "entries:",
        "  - type: output",
        "    source: /api/x",
        "    jsonPath: a.b",
        "    minOverRuns:",
        "      value: 0",
        "      runs: 2.5",
        "",
      ].join("\n"),
      "utf-8",
    );
    const res = await loadLivenessManifest(p);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /schema validation failed/);
  });
});

describe("wiring-liveness: evaluateOutputs verdicts", () => {
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

describe("wiring-liveness: runWiringLiveness (output integration)", () => {
  const NOW = 1_700_000_000_000;
  const freshTimers = async (): Promise<ProbeResult<TimerRecord[]>> => ({
    ok: true,
    data: [liveTimer("a.timer", NOW - 10 * 60_000)],
  });

  test("flags a below-floor output source alongside healthy timers", async () => {
    const res = await runWiringLiveness({
      loadManifest: async () => ({
        ok: true,
        manifest: {
          entries: [
            timerEntry("a.timer", 60),
            outputEntry("/api/scanner/latest", "funnelBreakdown.registryPairs", 0, 3),
          ],
        },
      }),
      readTimers: freshTimers,
      readOutput: fakeReader([0, 0, 0]),
      now: () => NOW,
    });
    assert.equal(res.evaluated, true);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.stale, []);
    assert.deepEqual(res.belowFloor, ["/api/scanner/latest"]);
  });

  test("recovered output source clears the alert (no sticky false-positive)", async () => {
    const res = await runWiringLiveness({
      loadManifest: async () => ({
        ok: true,
        manifest: {
          entries: [outputEntry("/api/scanner/latest", "funnelBreakdown.registryPairs", 0, 3)],
        },
      }),
      readTimers: freshTimers,
      readOutput: fakeReader([0, 0, 12]),
      now: () => NOW,
    });
    assert.equal(res.evaluated, true);
    assert.deepEqual(res.belowFloor, []);
    assert.equal(res.outputVerdicts[0].status, "ok");
  });

  test("default reader (no injection) marks output UNREADABLE, never below-floor", async () => {
    const res = await runWiringLiveness({
      loadManifest: async () => ({
        ok: true,
        manifest: {
          entries: [outputEntry("/api/scanner/latest", "funnelBreakdown.registryPairs", 0, 3)],
        },
      }),
      readTimers: freshTimers,
      now: () => NOW,
    });
    assert.equal(res.evaluated, true);
    assert.deepEqual(res.belowFloor, []);
    assert.deepEqual(res.unreadable, ["/api/scanner/latest"]);
    assert.equal(res.outputVerdicts[0].status, "unreadable");
  });
});
