/**
 * fixer-gate.test.mts — Regression tests for the fixer fixability gate.
 *
 * Bug: runFixerAttempt() ran unconditionally on all verification failures,
 * even when stderr indicated unfixable issues (missing modules, stack overflow, etc.).
 * This wasted $0.80-1.20 per failed cycle on hopeless fixer calls.
 *
 * Fix: isFixableFailure() classifies failures before calling the fixer.
 * Unfixable patterns skip the fixer and go straight to failure reporting.
 *
 * Issue: #148
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { _testing } from "../src/verification.ts";

const { isFixableFailure } = _testing;

// Helper: build a fake failed step with given stderr
function failedStep(stderr: string, label = "tests"): any {
  return { label, command: "npm test", passed: false, exitCode: 1, stdout: "", stderr };
}

// Helper: build a passing step
function passingStep(label = "tests"): any {
  return { label, command: "npm test", passed: true, exitCode: 0, stdout: "", stderr: "" };
}

describe("isFixableFailure", () => {
  // -----------------------------------------------------------------------
  // Unfixable patterns — fixer should be SKIPPED
  // -----------------------------------------------------------------------

  test("Cannot find module -> unfixable (missing-module)", () => {
    const result = isFixableFailure([
      failedStep("Error: Cannot find module '@acme/shared-utils'\nRequire stack:\n- /app/src/index.ts"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "missing-module");
  });

  test("circular dependency -> unfixable", () => {
    const result = isFixableFailure([
      failedStep("Warning: circular dependency detected between src/a.ts and src/b.ts"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "circular-dependency");
  });

  test("Maximum call stack -> unfixable (stack-overflow)", () => {
    const result = isFixableFailure([
      failedStep("RangeError: Maximum call stack size exceeded"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "stack-overflow");
  });

  test("out of memory -> unfixable", () => {
    const result = isFixableFailure([
      failedStep("FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "out-of-memory");
  });

  test("ENOENT -> unfixable (missing-file)", () => {
    const result = isFixableFailure([
      failedStep("Error: ENOENT: no such file or directory, open '/app/config.json'"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "missing-file");
  });

  test("EPERM -> unfixable (permission-error)", () => {
    const result = isFixableFailure([
      failedStep("Error: EPERM: operation not permitted, unlink '/etc/passwd'"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "permission-error");
  });

  test("Cannot read properties of undefined -> unfixable", () => {
    const result = isFixableFailure([
      failedStep("TypeError: Cannot read properties of undefined (reading 'map')"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "undefined-access");
  });

  // -----------------------------------------------------------------------
  // Fixable patterns — fixer should RUN
  // -----------------------------------------------------------------------

  test("test assertion failure (Expected) -> fixable (test-expectation)", () => {
    const result = isFixableFailure([
      failedStep("AssertionError: Expected 5, got 3\n    at Object.<anonymous> (test/math.test.ts:12:5)"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "test-expectation");
  });

  test("TypeScript type error -> fixable (type-error)", () => {
    const result = isFixableFailure([
      failedStep("error TS2322: Type 'string' is not assignable to type 'number'.", "typecheck"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "type-error");
  });

  test("missing export -> fixable (import-error)", () => {
    const result = isFixableFailure([
      failedStep("error TS2305: Module '\"./utils\"' has no exported member 'formatDate'.", "typecheck"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "import-error");
  });

  test("build error -> fixable (build-error)", () => {
    const result = isFixableFailure([
      failedStep("Module build failed: SyntaxError: Unexpected token", "build"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "build-error");
  });

  // -----------------------------------------------------------------------
  // Default / edge cases
  // -----------------------------------------------------------------------

  test("empty stderr -> fixable (conservative default)", () => {
    const result = isFixableFailure([
      failedStep(""),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "unknown");
  });

  test("no failed steps -> fixable", () => {
    const result = isFixableFailure([passingStep()]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "none");
  });

  test("unrecognized error -> fixable (conservative default)", () => {
    const result = isFixableFailure([
      failedStep("Error: some unknown error that we have never seen before"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "unknown");
  });

  test("unfixable pattern in stdout (not stderr) is still detected", () => {
    // The classifier combines both stderr and stdout
    const step = {
      label: "tests",
      command: "npm test",
      passed: false,
      exitCode: 1,
      stdout: "Error: Cannot find module 'missing-pkg'",
      stderr: "",
    };
    const result = isFixableFailure([step]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "missing-module");
  });

  test("multiple failed steps — unfixable in any step triggers skip", () => {
    const result = isFixableFailure([
      failedStep("Expected 5, got 3"), // fixable
      failedStep("Error: Cannot find module 'foo'"), // unfixable
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "missing-module");
  });
});
