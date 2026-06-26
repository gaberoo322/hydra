/**
 * Regression test: `projectReflectionHealth` (issue #2467) — the pure tally
 * behind `GET /learning/reflection-health`.
 *
 * The recurring #1912/#2450/#2467 false alarm is reading a flat 100%-`none`
 * `reflectionMatchSource` distribution as broken telemetry when it is the
 * HONEST steady state of an empty reflection store (reflections are produced
 * only on a non-merged failure, so a high-merge-rate run serves nothing). This
 * surface exists to make the honest-none distinguishable from a genuinely-
 * broken deposit. The projection is a PURE function over already-read cycle
 * rows — no Redis — so these cases pin the verdict logic directly without a
 * connection (this is a NEW top-level describe with no shared-Redis teardown,
 * per the CLAUDE.md authoring rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { projectReflectionHealth } = await import("../src/api/learning.ts");

describe("projectReflectionHealth — reflection-deposit health verdict (#2467)", () => {
  test("empty window → no-data verdict", () => {
    const report = projectReflectionHealth([]);
    assert.equal(report.sampleSize, 0);
    assert.equal(report.verdict, "no-data");
    assert.equal(report.reflectionSourcesPresent, 0);
    assert.deepEqual(report.distribution, {});
  });

  test("all-none with no deposit served → all-none-empty-store (NOT an alarm)", () => {
    // The honest steady state: every cycle bucketed 'none', and not one carried
    // a present reflectionSources deposit. This is the #2467 false-alarm case —
    // it MUST verdict as the explicitly-not-an-alarm token.
    const cycles = [
      { reflectionMatchSource: "none", reflectionSources: "" },
      { reflectionMatchSource: "none" }, // field absent entirely
      { reflectionMatchSource: "none", reflectionSources: "none" }, // #2209 sentinel
    ];
    const report = projectReflectionHealth(cycles);
    assert.equal(report.sampleSize, 3);
    assert.equal(report.verdict, "all-none-empty-store");
    assert.equal(report.reflectionSourcesPresent, 0, "sentinel + empty + absent all count as no deposit");
    assert.deepEqual(report.distribution, { none: 3 });
    assert.match(report.note, /Expected, not an alarm/);
  });

  test("a present deposit that still buckets 'none' → served-but-bucketed-none", () => {
    // A deposit landed (non-empty, non-sentinel reflectionSources) yet the
    // derived bucket is still 'none' — the genuine false-none worth an eye.
    const cycles = [
      { reflectionMatchSource: "none", reflectionSources: "per-anchor" },
      { reflectionMatchSource: "none", reflectionSources: "" },
    ];
    const report = projectReflectionHealth(cycles);
    assert.equal(report.verdict, "served-but-bucketed-none");
    assert.equal(report.reflectionSourcesPresent, 1);
    assert.deepEqual(report.distribution, { none: 2 });
  });

  test("any non-none bucket present → healthy", () => {
    const cycles = [
      { reflectionMatchSource: "both", reflectionSources: "per-anchor,by-file" },
      { reflectionMatchSource: "none", reflectionSources: "" },
      { reflectionMatchSource: "by-anchor", reflectionSources: "per-anchor" },
    ];
    const report = projectReflectionHealth(cycles);
    assert.equal(report.verdict, "healthy");
    assert.equal(report.sampleSize, 3);
    assert.equal(report.reflectionSourcesPresent, 2);
    assert.deepEqual(report.distribution, { both: 1, none: 1, "by-anchor": 1 });
  });

  test("rows with a missing reflectionMatchSource default to the 'none' bucket", () => {
    // The projection stays total over any input shape — an undefined bucket is
    // tallied as 'none' (mirroring deriveReflectionMatchSource's empty default).
    const report = projectReflectionHealth([{}, { reflectionMatchSource: "" }]);
    assert.deepEqual(report.distribution, { none: 2 });
    assert.equal(report.verdict, "all-none-empty-store");
  });
});
