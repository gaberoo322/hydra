/**
 * Regression tests for issue #456 — grounding parser silently returns
 * `{passed:0, failed:0, total:0}` when `npm test` exits 0 but its output
 * contains no recognisable vitest/jest summary line.
 *
 * Before this fix, `/api/tasks/grounding/latest` reported "0 tests ran"
 * indistinguishable from "the harness crashed without erroring" or "the
 * loader silently no-op'd". Downstream metrics (priorities aggregator,
 * stuckness inputs) treated the zero as ground truth.
 *
 * The fix adds a `recognised` flag on the parse result and propagates it
 * into a `testReport.parseStatus` field on the grounding snapshot. A
 * 0-exit + unrecognised-output run is now `parseStatus: "unrecognised"`
 * instead of being silently coerced to "0 tests passed".
 *
 * Previously these tests accessed parseTestCounts via the `_testing`
 * escape-hatch export on grounding.ts. Now that it lives in grounding-parser.ts
 * it is imported directly — no escape hatch needed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseTestCounts } from "../src/grounding-parser.ts";

describe("parseTestCounts.recognised flag (issue #456)", () => {
  test("vitest output with summary → recognised: true, passed: 42", () => {
    const stdout = `
 Test Files  3 passed (3)
      Tests  42 passed (42)
   Start at  17:06:32`;
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.recognised, true);
    assert.equal(counts.passed, 42);
    assert.equal(counts.failed, 0);
  });

  test("empty stdout + empty stderr → recognised: false, passed: 0", () => {
    // This is the silent-no-op shape: npm test exited 0 but emitted nothing
    // the parser knows how to read. Before #456 this was indistinguishable
    // from "ran 0 tests"; after #456 the recognised flag exposes the gap.
    const counts = parseTestCounts("", "");
    assert.equal(
      counts.recognised,
      false,
      "empty output must be flagged as unrecognised — this is the #456 silent-no-op",
    );
    assert.equal(counts.passed, 0);
    assert.equal(counts.failed, 0);
    assert.equal(counts.total, 0);
  });

  test("jest format → recognised: true, passed: 42", () => {
    const stdout = "Tests:       42 passed, 42 total";
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.recognised, true);
    assert.equal(counts.passed, 42);
    assert.equal(counts.total, 42);
  });

  test("non-test exit-0 output (e.g. 'npm WARN deprecated foo') → recognised: false", () => {
    // Realistic silent-no-op cause: a misconfigured `npm test` script that
    // resolves to a no-op shell command. Exit 0, no test runner output,
    // no summary line. Should be flagged unrecognised, not coerced to 0/0/0.
    const stdout = "npm WARN deprecated some-package@1.0.0: please upgrade\n";
    const counts = parseTestCounts(stdout, "");
    assert.equal(
      counts.recognised,
      false,
      "no summary line means the parser couldn't read the test result",
    );
    assert.equal(counts.passed, 0);
    assert.equal(counts.failed, 0);
  });

  test("stderr-only output is still recognised when summary appears there", () => {
    // Vitest sometimes emits the summary on stderr depending on the host.
    // The recognised flag should look at both streams (parser already does).
    const counts = parseTestCounts(
      "",
      "\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n",
    );
    assert.equal(counts.recognised, true);
    assert.equal(counts.passed, 5);
  });

  test("mixed passed + failed counts → recognised: true", () => {
    const stdout = `
 Test Files  70 passed | 2 failed (72)
      Tests  631 passed | 2 failed (633)`;
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.recognised, true);
    assert.equal(counts.passed, 631);
    assert.equal(counts.failed, 2);
    assert.equal(counts.total, 633);
  });

  test("regression (2026-04-06): ANSI-laden vitest summary stays recognised", () => {
    // The 2026-04-06 grounding bug fixture — ANSI escape codes wrapped
    // around the styled chunks. parseTestCounts() must still report
    // recognised: true here, not just on plain text.
    const stdout =
      "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m72 passed\x1b[39m\x1b[22m\x1b[90m (72)\x1b[39m\n" +
      "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m633 passed\x1b[39m\x1b[22m\x1b[90m (633)\x1b[39m";
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.recognised, true);
    assert.equal(counts.passed, 633);
  });

  test("null/undefined input → recognised: false (silent-no-op shape)", () => {
    // Defensive: if a caller passes null for either stream, treat as
    // unrecognised rather than silently returning 0/0/0 with recognised:true.
    const counts = parseTestCounts(null, null);
    assert.equal(counts.recognised, false);
    assert.equal(counts.passed, 0);
  });
});
