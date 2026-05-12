/**
 * Regression tests for JIT discard-reason classification (issue #299).
 *
 * Background: JIT was generating 2-3 tests per cycle but discarding 100% of
 * them — every generated test was rejected as "bad generation or import
 * errors" with no breakdown of *why*. Dashboards reported `decision: "ran:
 * 0 tests, all N discarded"` on every JIT cycle so operators couldn't
 * attribute the failure mode.
 *
 * Fix: track per-reason counters on JitTestResult and surface the top reason
 * in the decision string. Also add a one-shot retry prompt for the dominant
 * import_error case.
 *
 * Coverage:
 *   1. JitDiscardReasons / emptyDiscardReasons shape and defaults.
 *   2. classifyJitDiscard correctly buckets import / compile / runtime cases.
 *   3. topDiscardReason picks the largest counter with deterministic tie-break.
 *   4. buildJitRetryPrompt injects failure context and project-root hints.
 *   5. jitSkipReport carries the new fields (back-compat for skip call sites).
 *   6. summarizeJitTests surfaces the per-reason breakdown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  classifyJitDiscard,
  topDiscardReason,
  emptyDiscardReasons,
  jitSkipReport,
  JIT_SKIP_QUICK_FIX,
  buildJitRetryPrompt,
  summarizeJitTests,
} = await import("../src/jit.ts");

describe("emptyDiscardReasons / jitSkipReport carry new fields (issue #299)", () => {
  test("emptyDiscardReasons returns all-zero counters", () => {
    const r = emptyDiscardReasons();
    assert.equal(r.import_error, 0);
    assert.equal(r.compile_error, 0);
    assert.equal(r.runtime_error, 0);
    assert.equal(r.generation_empty, 0);
  });

  test("jitSkipReport includes discardReasons and retried fields", () => {
    const r = jitSkipReport(JIT_SKIP_QUICK_FIX);
    assert.deepEqual(r.discardReasons, {
      import_error: 0,
      compile_error: 0,
      runtime_error: 0,
      generation_empty: 0,
    });
    assert.equal(r.retried, false);
    assert.equal(r.decision, "skipped: quick-fix");
  });
});

describe("classifyJitDiscard (issue #299)", () => {
  test("Cannot find module is classified as import_error", () => {
    const out = "node:internal/modules/esm/resolve:264\nError: Cannot find module '../src/foo.ts'\n";
    assert.equal(classifyJitDiscard(out, 1, false), "import_error");
  });

  test("ERR_MODULE_NOT_FOUND is classified as import_error", () => {
    const out = "code: 'ERR_MODULE_NOT_FOUND',\n  url: 'file:///tmp/missing.ts'";
    assert.equal(classifyJitDiscard(out, 1, false), "import_error");
  });

  test("Cannot find package is classified as import_error", () => {
    assert.equal(classifyJitDiscard("Error: Cannot find package 'unknown-dep'", 1, false), "import_error");
  });

  test("SyntaxError without import message is classified as compile_error", () => {
    const out = "SyntaxError: Unexpected token (3:5)\n    at parseSource";
    assert.equal(classifyJitDiscard(out, 1, false), "compile_error");
  });

  test("ERR_INVALID_TYPESCRIPT_SYNTAX is classified as compile_error", () => {
    assert.equal(classifyJitDiscard("ERR_INVALID_TYPESCRIPT_SYNTAX foo", 1, false), "compile_error");
  });

  test("import_error wins over SyntaxError when both are present (resolution failures on some Node versions)", () => {
    const out = "SyntaxError: ...\nERR_MODULE_NOT_FOUND";
    // Order matters per #299: import-resolution failures are conceptually
    // missing-module even when they surface as SyntaxError-shaped traces.
    assert.equal(classifyJitDiscard(out, 1, false), "import_error");
  });

  test("Non-zero exit without import/compile signal is runtime_error", () => {
    const out = "TypeError: Cannot read properties of undefined (reading 'foo')";
    assert.equal(classifyJitDiscard(out, 1, false), "runtime_error");
  });

  test("Timeout with empty output is runtime_error", () => {
    assert.equal(classifyJitDiscard("", 124, true), "runtime_error");
  });

  test("empty output with exit 0 still returns runtime_error (defensive)", () => {
    assert.equal(classifyJitDiscard("", 0, false), "runtime_error");
  });
});

describe("topDiscardReason (issue #299)", () => {
  test("returns null when all counters are zero", () => {
    assert.equal(topDiscardReason(emptyDiscardReasons()), null);
  });

  test("returns the largest counter", () => {
    assert.equal(
      topDiscardReason({ import_error: 2, compile_error: 0, runtime_error: 1, generation_empty: 0 }),
      "import_error",
    );
  });

  test("tie-break prefers import_error (the most actionable signal)", () => {
    assert.equal(
      topDiscardReason({ import_error: 1, compile_error: 1, runtime_error: 1, generation_empty: 1 }),
      "import_error",
    );
  });

  test("falls through tie-break order import_error > compile_error > runtime_error > generation_empty", () => {
    assert.equal(
      topDiscardReason({ import_error: 0, compile_error: 1, runtime_error: 1, generation_empty: 5 }),
      "generation_empty",
    );
    assert.equal(
      topDiscardReason({ import_error: 0, compile_error: 2, runtime_error: 2, generation_empty: 0 }),
      "compile_error",
    );
  });
});

describe("buildJitRetryPrompt (issue #299)", () => {
  test("includes the original prompt body plus retry hints", () => {
    const out = buildJitRetryPrompt(
      "+ export function newHelper() { return 42; }",
      ["src/helper.ts"],
      "Add helper",
      [{ filename: "test/jit-x.test.mts", output: "Cannot find module '../src/helper'" }],
    );
    assert.ok(out.includes("RETRY CONTEXT (issue #299)"));
    assert.ok(out.includes("relative path"));
    assert.ok(out.includes(".ts"));
    assert.ok(out.includes("Cannot find module"));
    assert.ok(out.includes("test/jit-x.test.mts"));
    // Base prompt content still present
    assert.ok(out.includes("Add helper"));
    assert.ok(out.includes("node:test"));
  });

  test("caps the failure list to 3 entries", () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({
      filename: `test/jit-${i}.test.mts`,
      output: `Cannot find module '../src/missing-${i}.ts'`,
    }));
    const out = buildJitRetryPrompt("diff", ["src/a.ts"], "t", failures);
    // 4 onwards should be omitted to keep the prompt compact.
    assert.ok(out.includes("test/jit-0.test.mts"));
    assert.ok(out.includes("test/jit-2.test.mts"));
    assert.ok(!out.includes("test/jit-4.test.mts"));
  });

  test("handles empty failures gracefully (defensive)", () => {
    const out = buildJitRetryPrompt("diff", ["src/a.ts"], "t", []);
    assert.ok(out.includes("RETRY CONTEXT"));
    // Doesn't crash on empty list.
  });
});

describe("summarizeJitTests surfaces discard breakdown (issue #299)", () => {
  test("breakdown includes per-reason counters when discards happen", () => {
    const summary = summarizeJitTests({
      generated: 3,
      kept: 0,
      discarded: 3,
      caughtBug: false,
      bugDetails: null,
      testFiles: [],
      durationMs: 1000,
      error: null,
      discardReasons: { import_error: 2, compile_error: 1, runtime_error: 0, generation_empty: 0 },
      retried: false,
      decision: "ran: 0 tests, all 3 discarded (import_error)",
    });
    assert.ok(summary.includes("2 import_error"));
    assert.ok(summary.includes("1 compile_error"));
    assert.ok(!summary.includes("0 runtime_error"));
  });

  test("retry tag appears when one-shot retry path was attempted", () => {
    const summary = summarizeJitTests({
      generated: 4,
      kept: 1,
      discarded: 3,
      caughtBug: false,
      bugDetails: null,
      testFiles: ["test/foo.test.mts"],
      durationMs: 1000,
      error: null,
      discardReasons: { import_error: 3, compile_error: 0, runtime_error: 0, generation_empty: 0 },
      retried: true,
      decision: "ran: 1 test added (after retry)",
    });
    assert.ok(summary.includes("one-shot retry"));
  });

  test("zero-discard case omits breakdown line entirely", () => {
    const summary = summarizeJitTests({
      generated: 2,
      kept: 2,
      discarded: 0,
      caughtBug: false,
      bugDetails: null,
      testFiles: ["test/a.test.mts", "test/b.test.mts"],
      durationMs: 500,
      error: null,
      discardReasons: emptyDiscardReasons(),
      retried: false,
      decision: "ran: 2 tests added",
    });
    assert.ok(!summary.includes("Discarded:"));
  });
});

describe("decision-string suffix on all-discard cycles (issue #299)", () => {
  test("topDiscardReason → suffix interpolates correctly into decision", () => {
    // Simulate what runJitTests builds when generated > 0 and discarded === generated.
    const reasons = { import_error: 2, compile_error: 0, runtime_error: 0, generation_empty: 0 };
    const top = topDiscardReason(reasons);
    const decision = `ran: 0 tests, all 2 discarded${top ? ` (${top})` : ""}`;
    assert.equal(decision, "ran: 0 tests, all 2 discarded (import_error)");
  });

  test("when reasons are all-zero (shouldn't happen with discarded>0 but defensive), no suffix is appended", () => {
    const reasons = emptyDiscardReasons();
    const top = topDiscardReason(reasons);
    const decision = `ran: 0 tests, all 0 discarded${top ? ` (${top})` : ""}`;
    assert.equal(decision, "ran: 0 tests, all 0 discarded");
  });
});
