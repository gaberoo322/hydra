/**
 * Tests for the CI scope-check script's pure helpers (issue #382).
 *
 * Locks in the markdown parsing for `Files in scope` and the
 * out-of-scope ratio classifier so future edits don't accidentally
 * weaken the gate.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractScopeFromBody, classifyScope } from "../scripts/ci/scope-check.ts";

describe("extractScopeFromBody", () => {
  test("pulls backticked paths from a markdown ## section", () => {
    const body = [
      "Some preamble.",
      "",
      "## Files in scope",
      "",
      "- `src/foo.ts`",
      "- `src/bar/`",
      "- `docs/quality-gates.md`",
      "",
      "## Files out of scope",
      "",
      "- `src/other.ts`",
    ].join("\n");
    const scope = extractScopeFromBody(body);
    assert.deepEqual(scope.sort(), ["docs/quality-gates.md", "src/bar/", "src/foo.ts"]);
  });

  test("returns empty when no section is present", () => {
    const scope = extractScopeFromBody("just a plain PR description with no sections\n");
    assert.deepEqual(scope, []);
  });

  test("returns empty for empty body", () => {
    assert.deepEqual(extractScopeFromBody(""), []);
  });

  test("falls back to bullet text when no code spans", () => {
    const body = [
      "## Files in scope",
      "",
      "- src/foo.ts",
      "- src/bar.ts",
      "",
      "## Risk",
      "",
      "low",
    ].join("\n");
    const scope = extractScopeFromBody(body);
    assert.deepEqual(scope.sort(), ["src/bar.ts", "src/foo.ts"]);
  });

  test("is case-insensitive on the header", () => {
    const body = "## FILES IN SCOPE\n- `src/foo.ts`\n";
    assert.deepEqual(extractScopeFromBody(body), ["src/foo.ts"]);
  });

  test("ignores non-path bullet text in fallback mode", () => {
    const body = [
      "## Files in scope",
      "",
      "- src/foo.ts",
      "- general notes about the change",
      "",
    ].join("\n");
    const scope = extractScopeFromBody(body);
    assert.deepEqual(scope, ["src/foo.ts"]);
  });
});

describe("classifyScope", () => {
  test("passes when every changed file is in scope", () => {
    const r = classifyScope(["src/foo.ts", "src/bar.ts"], ["src/foo.ts", "src/bar.ts"]);
    assert.equal(r.blocked, false);
    assert.equal(r.outOfScope.length, 0);
  });

  test("passes when ratio is at-but-not-above threshold", () => {
    // 4/5 = 0.8 exactly — the in-cycle gate used strict >, mirror that here
    const r = classifyScope(
      ["a.ts", "b.ts", "c.ts", "d.ts", "src/foo.ts"],
      ["src/foo.ts"],
    );
    assert.equal(r.ratio, 0.8);
    assert.equal(r.blocked, false);
  });

  test("blocks when ratio is above threshold and count is above min", () => {
    const r = classifyScope(
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "src/foo.ts"],
      ["src/foo.ts"],
    );
    assert.equal(r.blocked, true);
    assert.equal(r.outOfScope.length, 5);
  });

  test("does NOT block when ratio is high but count is small (<=minCount)", () => {
    // 3 out-of-scope = at the minCount threshold, gate strictly requires >3
    const r = classifyScope(["a.ts", "b.ts", "c.ts", "src/foo.ts"], ["src/foo.ts"]);
    assert.equal(r.outOfScope.length, 3);
    assert.equal(r.blocked, false);
  });

  test("treats directory scope as a prefix match", () => {
    const r = classifyScope(
      ["src/foo/a.ts", "src/foo/b/c.ts", "src/foo/d.ts"],
      ["src/foo/"],
    );
    assert.equal(r.outOfScope.length, 0);
    assert.equal(r.blocked, false);
  });

  test("strips a leading web/ when normalising paths", () => {
    // Matches the in-cycle normalisation in src/scope-enforcement.ts.
    const r = classifyScope(["web/src/foo.ts"], ["src/foo.ts"]);
    assert.equal(r.outOfScope.length, 0);
  });

  test("empty diff yields a pass", () => {
    const r = classifyScope([], ["src/foo.ts"]);
    assert.equal(r.blocked, false);
    assert.equal(r.outOfScope.length, 0);
  });

  test("respects custom ratio + minCount overrides", () => {
    // Lower the bar so even 2/3 out-of-scope blocks.
    const r = classifyScope(
      ["a.ts", "b.ts", "src/foo.ts"],
      ["src/foo.ts"],
      { ratio: 0.5, minCount: 1 },
    );
    assert.equal(r.blocked, true);
  });
});
