/**
 * fixer-eligibility.test.mts — Regression tests for the widened fixability
 * classifier introduced in issue #376.
 *
 * Bug: classifyFailureFixability() was too narrow. Specifically:
 *   - "Cannot find module './foo'" (relative path, typo-class) was being
 *     marked unfixable alongside missing package errors, so the fixer was
 *     never offered cycles it could trivially patch.
 *   - Scope-creep / out-of-scope failures fell into the "unknown" bucket
 *     instead of being explicitly classified as not-fixable, so the
 *     fixer would run pointlessly at codex tier.
 *   - JIT failures (uncovered behavior) carry test-expectation stderr that
 *     should route to the fixer's test-expectation path — verified here.
 *
 * Fix: classifyFailureFixability() (alias of isFixableFailure) widens
 * FIXABLE_PATTERNS to include relative-path "Cannot find module" and adds
 * an explicit scope-creep UNFIXABLE pattern.
 *
 * Issue: #376
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailureFixability,
  isFixableFailure,
  FIXABLE_PATTERNS,
  UNFIXABLE_PATTERNS,
} from "../src/fixer.ts";

// Helper: build a fake failed step with given stderr
function failedStep(stderr: string, label = "tests"): any {
  return { label, command: "npm test", passed: false, exitCode: 1, stdout: "", stderr };
}

describe("classifyFailureFixability — issue #376 widened classifier", () => {
  test("classifyFailureFixability is exported and is the same function as isFixableFailure", () => {
    // The alias is what the issue's acceptance criteria reference. Keeping
    // the legacy export prevents breaking existing callers.
    assert.equal(classifyFailureFixability, isFixableFailure);
  });

  // -----------------------------------------------------------------------
  // (a) Import-error (relative path) -> ELIGIBLE
  //     Codex can usually rewrite the import path in one shot.
  // -----------------------------------------------------------------------

  test("relative-path 'Cannot find module' -> eligible (import-error)", () => {
    const result = classifyFailureFixability([
      failedStep("Error: Cannot find module './utils/format'\nRequire stack:\n- /app/src/index.ts"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "import-error");
  });

  test("parent-path 'Cannot find module' -> eligible (import-error)", () => {
    const result = classifyFailureFixability([
      failedStep("Error: Cannot find module '../shared/types'"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "import-error");
  });

  test("package-name 'Cannot find module' still UNFIXABLE (regression guard)", () => {
    // This was the original #148 behavior and must not regress. Package
    // names need `npm install` — a one-shot fixer cannot resolve them.
    const result = classifyFailureFixability([
      failedStep("Error: Cannot find module 'lodash'"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "missing-module");
  });

  test("scoped-package 'Cannot find module' still UNFIXABLE (regression guard)", () => {
    const result = classifyFailureFixability([
      failedStep("Error: Cannot find module '@acme/shared-utils'"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "missing-module");
  });

  // -----------------------------------------------------------------------
  // (b) Scope-creep -> NOT-ELIGIBLE with reason logged
  // -----------------------------------------------------------------------

  test("scope-creep failure -> not-eligible with explicit reason", () => {
    // The scope-enforcement gate emits a synthetic step labelled
    // "scope-enforcement" with stderr describing the out-of-scope ratio.
    // Verify the classifier explicitly rejects it (rather than falling into
    // the conservative "unknown -> fixable" default).
    const result = classifyFailureFixability([
      {
        label: "scope-enforcement",
        command: "(internal check)",
        passed: false,
        exitCode: -1,
        stdout: "",
        stderr: "Scope gate blocked merge: 87% out of scope files changed (scope-creep detected)",
      },
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "scope-creep");
    // AC: "reason logged" — the reason field is non-empty and human-readable.
    assert.ok(result.reason.length > 0, "reason should be populated");
    assert.match(result.reason, /scope/i);
  });

  test("alternate scope-creep wording 'out-of-scope files' also rejected", () => {
    const result = classifyFailureFixability([
      failedStep("ERROR: 5 out-of-scope files modified (expected: 0)"),
    ]);
    assert.equal(result.fixable, false);
    assert.equal(result.category, "scope-creep");
  });

  // -----------------------------------------------------------------------
  // (c) JIT failure (uncovered assertion) -> ELIGIBLE
  //     JIT generates regression tests; if they fail, stderr looks like a
  //     standard assertion failure and should route to the fixer.
  // -----------------------------------------------------------------------

  test("JIT-generated test failure (AssertionError) -> eligible (test-expectation)", () => {
    const result = classifyFailureFixability([
      failedStep(
        "AssertionError [ERR_ASSERTION]: Expected handler to throw on empty input\n" +
        "    at /app/test/jit-generated-uncovered-edge-case.test.mts:42:5",
      ),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "test-expectation");
  });

  test("JIT-style 'Expected X, got Y' failure -> eligible", () => {
    const result = classifyFailureFixability([
      failedStep("Expected 42 but got undefined"),
    ]);
    assert.equal(result.fixable, true);
    // Either test-expectation or unknown — both surface as fixable. We
    // assert on the boolean, not the category, to avoid coupling to which
    // pattern wins the regex race.
  });

  // -----------------------------------------------------------------------
  // Single-test localized failure -> ELIGIBLE (issue #376 implementation note)
  // -----------------------------------------------------------------------

  test("single tsc error on a known file -> eligible (type-error)", () => {
    // The issue calls out "tsc errors localized to the changed file" as a
    // case the fixer should handle. The existing type-error pattern picks
    // these up — this test pins that behavior.
    const result = classifyFailureFixability([
      failedStep("src/widgets/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.", "typecheck"),
    ]);
    assert.equal(result.fixable, true);
    assert.equal(result.category, "type-error");
  });

  // -----------------------------------------------------------------------
  // Pattern table invariants — guard against accidental dropouts
  // -----------------------------------------------------------------------

  test("FIXABLE_PATTERNS table includes the relative-path import rule", () => {
    const hasRelImport = FIXABLE_PATTERNS.some((p) =>
      p.pattern.test("Cannot find module './foo'")
    );
    assert.ok(hasRelImport, "FIXABLE_PATTERNS should match relative-path 'Cannot find module'");
  });

  test("UNFIXABLE_PATTERNS table rejects package-name modules but not relative paths", () => {
    const pkgMatch = UNFIXABLE_PATTERNS.some((p) =>
      p.pattern.test("Cannot find module 'lodash'")
    );
    const relMatch = UNFIXABLE_PATTERNS.some((p) =>
      p.pattern.test("Cannot find module './utils'")
    );
    assert.equal(pkgMatch, true, "package name should match an UNFIXABLE pattern");
    assert.equal(relMatch, false, "relative path should NOT match any UNFIXABLE pattern");
  });

  test("UNFIXABLE_PATTERNS table includes scope-creep", () => {
    const hasScope = UNFIXABLE_PATTERNS.some((p) => p.category === "scope-creep");
    assert.ok(hasScope, "UNFIXABLE_PATTERNS should include a scope-creep entry");
  });
});
