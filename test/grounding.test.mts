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
import { shouldCleanWorkingTree } from "../src/prepare-workspace.ts";

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

describe("shouldCleanWorkingTree", () => {
  test("clean repo on main → ok", () => {
    const decision = shouldCleanWorkingTree(
      { stdout: "main\n" },
      { stdout: "" },
    );
    assert.equal(decision.ok, true);
  });

  test("clean repo on master → ok", () => {
    const decision = shouldCleanWorkingTree(
      { stdout: "master" },
      { stdout: "" },
    );
    assert.equal(decision.ok, true);
  });

  test("operator-named feature branch with clean tree → skip", () => {
    // Issue #340 update: orchestrator-owned `feature/cycle-YYYY-MM-DD-NNNN-*`
    // branches with clean trees ARE now auto-recoverable (see
    // test/prepare-workspace.test.mts). Operator-named feature branches like
    // `feature/foo-bar` remain protected even with a clean tree.
    const decision = shouldCleanWorkingTree(
      { stdout: "feature/operator-experiment\n" },
      { stdout: "" },
    );
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /feature branch/);
  });

  test("dirty working tree on main → skip", () => {
    const decision = shouldCleanWorkingTree(
      { stdout: "main\n" },
      { stdout: " M web/src/lib/execution/polymarket-executor.ts" },
    );
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /tracked modification/);
  });

  test("mixed tracked + untracked on main → skip, only tracked counted", () => {
    // ?? file3.md is untracked and not at risk from `git checkout main`.
    // Only the 2 tracked modifications should count toward the skip reason.
    const decision = shouldCleanWorkingTree(
      { stdout: "main" },
      { stdout: " M file1.ts\n M file2.ts\n?? file3.md" },
    );
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /2 tracked modification/);
  });

  test("untracked files only on main → ok (safe to clean)", () => {
    // Untracked files are not touched by `git checkout main && git checkout .`
    // so they shouldn't trigger the safety gate. The original cleanup code
    // explicitly preserved them by avoiding `git clean -fd`.
    const decision = shouldCleanWorkingTree(
      { stdout: "main\n" },
      { stdout: "?? reports/decisions/polymarket-execution-contract.md\n?? reports/decisions/kalshi-execution-contract.md" },
    );
    assert.equal(decision.ok, true, "untracked-only should not trigger skip");
  });

  test("regression (2026-04-08): untracked decision contracts don't block cleanup", () => {
    // This is the exact state we saw in ~/hydra-betting after the grounding
    // fix landed: 4 decision contract .md files written during the Monday
    // debug session that were never committed. The initial safety gate
    // incorrectly treated them as "dirty" and skipped cleanup forever, which
    // would have made all subsequent orchestrator cycles skip cleanup even
    // though there was nothing at risk.
    const decision = shouldCleanWorkingTree(
      { stdout: "main" },
      {
        stdout:
          "?? reports/decisions/cross-venue-arbitrage-contract.md\n" +
          "?? reports/decisions/kalshi-execution-contract.md\n" +
          "?? reports/decisions/polymarket-execution-contract.md\n" +
          "?? reports/decisions/sportsbook-prediction-market-matcher-contract.md",
      },
    );
    assert.equal(decision.ok, true);
  });

  test("cycle branch (non-feature prefix) with clean tree → still skips", () => {
    // The branch-name safety rule is "must be main/master", not "must not be feature/*".
    // Any branch other than main/master is treated as operator-driven.
    const decision = shouldCleanWorkingTree(
      { stdout: "cycle/lint-cleanup-2026-04-08-1355" },
      { stdout: "" },
    );
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /cycle\/lint-cleanup/);
  });

  test("detached HEAD / no current branch → skip", () => {
    const decision = shouldCleanWorkingTree(
      { stdout: "" },
      { stdout: "" },
    );
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /no current branch/);
  });

  test("null stdout handled safely (null branchResult)", () => {
    const decision = shouldCleanWorkingTree(null, null);
    assert.equal(decision.ok, false);
  });

  test("regression (2026-04-07): operator on feature/cycle-... branch is protected from branch deletion", () => {
    // This is the exact scenario that blew up the polymarket clientOrderId cycle
    // when the orchestrator's grounding step deleted the operator's in-progress
    // feature branch mid-edit. With the safety gate, grounding must skip cleanup
    // and log a reason instead of wiping the branch.
    const decision = shouldCleanWorkingTree(
      { stdout: "feature/cycle-2026-04-07-1115-polymarket-clientorderid" },
      { stdout: " M web/src/lib/execution/polymarket-executor.ts\n M web/src/lib/execution/persist-venue-order.ts" },
    );
    assert.equal(decision.ok, false, "feature branches with dirty trees must be protected");
  });
});
