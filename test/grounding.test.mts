/**
 * Regression tests for src/grounding.mjs.
 *
 * Every test in this file corresponds to a real bug we shipped a patch for
 * during the 2026-04-07/08 debug session. If any of these fail, grounding
 * has regressed and the orchestrator will likely start reporting
 * "0 tests passing" in cycle logs again.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { _testing } from "../src/grounding.ts";

const { stripAnsi, truncate, parseTestCounts, parseFailingTests } = _testing;

describe("stripAnsi", () => {
  test("removes simple ANSI color codes", () => {
    assert.equal(stripAnsi("\x1b[32mhello\x1b[39m"), "hello");
  });

  test("removes compound ANSI sequences like vitest's bold+color+reset", () => {
    assert.equal(stripAnsi("\x1b[1m\x1b[32m633\x1b[39m\x1b[22m"), "633");
  });

  test("handles empty and null input", () => {
    assert.equal(stripAnsi(""), "");
    assert.equal(stripAnsi(null), "");
    assert.equal(stripAnsi(undefined), "");
  });

  test("passes through strings with no ANSI unchanged", () => {
    assert.equal(stripAnsi("plain text"), "plain text");
  });

  test("handles dim text escape sequences (\\x1b[2m)", () => {
    assert.equal(stripAnsi("\x1b[2m Test Files \x1b[22m"), " Test Files ");
  });
});

describe("truncate", () => {
  test("returns unchanged when shorter than limit", () => {
    assert.equal(truncate("short", 100), "short");
  });

  test("handles null/empty input", () => {
    assert.equal(truncate(null, 100), "");
    assert.equal(truncate("", 100), "");
  });

  test("preserves both head AND tail when truncating", () => {
    const input = "HEAD_MARKER" + "X".repeat(10000) + "TAIL_MARKER";
    const result = truncate(input, 2000);
    assert.ok(result.includes("HEAD_MARKER"), "head content should be preserved");
    assert.ok(result.includes("TAIL_MARKER"), "tail content should be preserved");
    assert.ok(result.includes("truncated"), "should include a truncation divider");
    assert.ok(result.length < input.length, "should be shorter than input");
  });

  test("regression (2026-04-08): vitest summary at end of long output is preserved", () => {
    // Before the head+tail fix, head-biased truncation at 10KB cut off the
    // "Tests 633 passed" summary which appears AFTER all progress lines,
    // causing parseTestCounts to return 0 for every cycle.
    const progress = "✓ src/file.test.ts (10 tests) 100ms\n".repeat(500);
    const summary =
      "\n Test Files  72 passed (72)\n      Tests  633 passed (633)\n";
    const fullOutput = progress + summary;
    assert.ok(fullOutput.length > 10000, "fixture must exceed truncation limit");

    const truncated = truncate(fullOutput, 10000);
    assert.ok(
      truncated.includes("633 passed"),
      "summary line must survive truncation — this is the 2026-04-08 grounding bug",
    );
  });
});

describe("parseTestCounts", () => {
  test("clean vitest summary produces correct counts", () => {
    const stdout = `
 Test Files  72 passed (72)
      Tests  633 passed (633)
   Start at  17:06:32`;
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.passed, 633);
    assert.equal(counts.failed, 0);
    assert.equal(counts.total, 633);
  });

  test("regression (2026-04-06): ANSI-laden vitest summary parses correctly", () => {
    // This is the EXACT byte sequence we captured from the orchestrator's
    // systemd-service context on 2026-04-08 when debugging the 0-tests bug.
    // TERM is unset, npm forwards FORCE_COLOR=1 to vitest, and vitest emits
    // ANSI escape codes around every styled chunk.
    const stdout =
      "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m72 passed\x1b[39m\x1b[22m\x1b[90m (72)\x1b[39m\n" +
      "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m633 passed\x1b[39m\x1b[22m\x1b[90m (633)\x1b[39m";

    const counts = parseTestCounts(stdout, "");
    assert.equal(
      counts.passed,
      633,
      "must parse 633 despite ANSI escape codes — this is the 2026-04-06 grounding bug",
    );
    assert.equal(counts.failed, 0);
  });

  test("regression (2026-04-08): head+tail truncated output still matches", () => {
    // Chain both regression fixtures: simulate a realistic long vitest
    // output that gets truncated, then parse. This exercises the full
    // pipeline that was broken for 2 days.
    const progress = "[progress line] ".repeat(1500);
    const summary =
      "\n Test Files  72 passed (72)\n      Tests  633 passed (633)\n";
    const truncated = truncate(progress + summary, 10000);
    const counts = parseTestCounts(truncated, "");
    assert.equal(
      counts.passed,
      633,
      "tail-preserved summary must be parseable",
    );
  });

  test("parses both passed and failed counts", () => {
    const stdout = `
 Test Files  70 passed | 2 failed (72)
      Tests  631 passed | 2 failed (633)`;
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.passed, 631);
    assert.equal(counts.failed, 2);
    assert.equal(counts.total, 633);
  });

  test("falls back to jest-style output", () => {
    const stdout = "Tests:       10 passed, 10 total";
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.passed, 10);
    assert.equal(counts.total, 10);
  });

  test("empty output returns zeros", () => {
    const counts = parseTestCounts("", "");
    assert.equal(counts.passed, 0);
    assert.equal(counts.failed, 0);
    assert.equal(counts.total, 0);
  });

  test("handles stderr-only output (test output on stderr)", () => {
    const counts = parseTestCounts(
      "",
      "\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n",
    );
    assert.equal(counts.passed, 5);
  });
});

describe("parseFailingTests", () => {
  test("extracts FAIL lines from vitest-style output", () => {
    const stdout =
      "FAIL  src/foo.test.ts > suite > test A\n" +
      "FAIL  src/bar.test.ts > suite > test B";
    const failures = parseFailingTests(stdout, "");
    assert.equal(failures.length, 2);
    assert.ok(failures[0].includes("foo.test.ts"));
    assert.ok(failures[1].includes("bar.test.ts"));
  });

  test("handles ANSI-wrapped FAIL markers", () => {
    const stdout =
      "\x1b[31mFAIL\x1b[39m  src/foo.test.ts > suite > test A";
    const failures = parseFailingTests(stdout, "");
    assert.equal(
      failures.length,
      1,
      "must detect FAIL despite ANSI codes wrapping the marker",
    );
  });

  test("caps at 20 failures", () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `FAIL  src/test${i}.test.ts > test ${i}`,
    ).join("\n");
    const failures = parseFailingTests(lines, "");
    assert.equal(failures.length, 20);
  });

  test("returns empty for clean output", () => {
    assert.deepEqual(parseFailingTests("all good", ""), []);
    assert.deepEqual(parseFailingTests("", ""), []);
  });
});

// shouldCleanWorkingTree() tests retired with src/prepare-workspace.ts
// (issue #609). The in-process cycle loop that consumed the workspace-prep
// helpers was removed in PR #383 (codex cut-over, ADR-0006); the module
// had no production importers post-cutover and was deleted as dead code.
