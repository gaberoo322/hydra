/**
 * Tests for the CI scope-check script's pure helpers (issue #382).
 *
 * Locks in the markdown parsing for `Files in scope` and the
 * out-of-scope ratio classifier so future edits don't accidentally
 * weaken the gate.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractScopeFromBody,
  extractOutOfScopeFromBody,
  extractScopeJustifications,
  classifyScope,
  isTargetRepoPath,
} from "../scripts/ci/scope-check.ts";

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

  // Issue #836: a plain-bullet Files-in-scope section followed by an in-section
  // scope-justification line (with a backticked path) used to early-return on
  // the lone code span and DROP every plain bullet (the PR #833 failure). All
  // bullet paths must survive, and the justification's path / prose must NOT
  // leak a phantom `test/` into the in-scope set (boundary fix).
  test("keeps plain bullets when an in-section scope-justification has a code span (#836)", () => {
    const body = [
      "## Files in scope",
      "",
      "- dashboard/src/pages/Now.tsx",
      "- dashboard/src/pages/Today.tsx",
      "- dashboard/src/pages/Outcomes.tsx",
      "- dashboard/src/pages/Explore.tsx",
      "- dashboard/src/components/PageItem.tsx",
      "- dashboard/src/components/Header.tsx",
      "- dashboard/src/lib/format.ts",
      "- dashboard/src/lib/api.ts",
      "- dashboard/src/index.css",
      "",
      "scope-justification: `test/page-item-format.test.mts` — new test, lives under `test/` per convention",
      "",
      "## Verification",
      "",
      "npm test green",
    ].join("\n");
    const scope = extractScopeFromBody(body);
    assert.deepEqual(scope.sort(), [
      "dashboard/src/components/Header.tsx",
      "dashboard/src/components/PageItem.tsx",
      "dashboard/src/index.css",
      "dashboard/src/lib/api.ts",
      "dashboard/src/lib/format.ts",
      "dashboard/src/pages/Explore.tsx",
      "dashboard/src/pages/Now.tsx",
      "dashboard/src/pages/Outcomes.tsx",
      "dashboard/src/pages/Today.tsx",
    ]);
    // No phantom test/* entries leaked from the justification line/prose.
    assert.ok(!scope.includes("test/"));
    assert.ok(!scope.includes("test/page-item-format.test.mts"));
    // No backtick-corrupted duplicates anywhere.
    assert.ok(scope.every((p) => !p.includes("`")));
  });

  // Issue #836: a MIXED section (backticked bullets + plain bullets) plus an
  // in-section backticked justification path. The result is the union of all
  // real declared paths with no corrupted or phantom entries.
  test("unions backticked and plain bullets with no corrupted duplicates (#836)", () => {
    const body = [
      "## Files in scope",
      "",
      "- `src/foo.ts`",
      "- src/bar.ts",
      "- `docs/quality-gates.md`",
      "",
      "scope-justification: `test/helper.test.mts` — shared fixture",
      "",
      "## Risk",
      "",
      "low",
    ].join("\n");
    const scope = extractScopeFromBody(body);
    assert.deepEqual(scope.sort(), [
      "docs/quality-gates.md",
      "src/bar.ts",
      "src/foo.ts",
    ]);
    assert.ok(!scope.includes("test/helper.test.mts"));
    // Each declared path appears exactly once — no literal-backtick twin.
    assert.equal(scope.length, new Set(scope).size);
    assert.ok(scope.every((p) => !p.includes("`")));
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
    // Matches the historical in-cycle normalisation that lived in
    // src/scope-enforcement.ts before it was deleted in issue #476.
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

  // ---- Issue #396: subagent scope-reconciliation parity ----

  test("hard-fails when a changed file matches the declared out-of-scope list", () => {
    const r = classifyScope(
      ["src/preflight.ts"],
      ["docs/agents/issue-tracker.md"],
      { outOfScopeDeclared: ["src/preflight.ts"] },
    );
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "hard-out-of-scope");
    assert.deepEqual(r.hardOutOfScope, ["src/preflight.ts"]);
  });

  test("hard-out-of-scope respects directory prefixes", () => {
    const r = classifyScope(
      ["src/control-loop/step-merge.ts"],
      ["docs/foo.md"],
      { outOfScopeDeclared: ["src/control-loop/"] },
    );
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "hard-out-of-scope");
  });

  // ---- Issue #1872: in-scope wins over an incidental out-of-scope code-span ----

  test("a file in BOTH in-scope and out-of-scope sets does not hard-fail (in-scope wins)", () => {
    // Reproduces the #1870/#1871 (and #1515) arch-scan code-span trap: the
    // seam-target file is legitimately in scope, but an out-of-scope prose
    // code-span mentions its bare basename. In-scope must win.
    const r = classifyScope(
      ["src/foo.ts"],
      ["src/foo.ts"],
      { outOfScopeDeclared: ["foo.ts"] },
    );
    assert.equal(r.blocked, false);
    assert.equal(r.reason, "pass");
    assert.deepEqual(r.hardOutOfScope, []);
  });

  test("in-scope wins even when the out-of-scope entry is the exact in-scope path", () => {
    const r = classifyScope(
      ["src/foo.ts"],
      ["src/foo.ts"],
      { outOfScopeDeclared: ["src/foo.ts"] },
    );
    assert.equal(r.blocked, false);
    assert.equal(r.reason, "pass");
    assert.deepEqual(r.hardOutOfScope, []);
  });

  test("in-scope wins is per-entry — a genuine out-of-scope-only file still hard-fails", () => {
    // bar.ts is ONLY out-of-scope (no in-scope twin) and must still block,
    // even though src/foo.ts is reconciled to in-scope.
    const r = classifyScope(
      ["src/foo.ts", "src/bar.ts"],
      ["src/foo.ts"],
      { outOfScopeDeclared: ["foo.ts", "src/bar.ts"] },
    );
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "hard-out-of-scope");
    assert.deepEqual(r.hardOutOfScope, ["src/bar.ts"]);
  });

  test("scope-justification whitelists a hard-out-of-scope file", () => {
    const r = classifyScope(
      ["src/preflight.ts"],
      ["docs/foo.md"],
      {
        outOfScopeDeclared: ["src/preflight.ts"],
        justified: ["src/preflight.ts"],
      },
    );
    assert.equal(r.blocked, false);
    assert.equal(r.reason, "pass");
    assert.deepEqual(r.justifiedTouched, ["src/preflight.ts"]);
  });

  test("scope-justification excludes a file from the ratio count", () => {
    // Without justification: 4/5 = 0.8, would not block.
    // With justification on one file: out-of-scope = 3/4 = 0.75, still no block.
    const r = classifyScope(
      ["a.ts", "b.ts", "c.ts", "d.ts", "src/foo.ts"],
      ["src/foo.ts"],
      { justified: ["a.ts"] },
    );
    assert.equal(r.outOfScope.length, 3);
    assert.deepEqual(r.justifiedTouched, ["a.ts"]);
    assert.equal(r.blocked, false);
  });

  test("ratio-exceeded reason is reported when soft gate fires", () => {
    const r = classifyScope(
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "src/foo.ts"],
      ["src/foo.ts"],
    );
    assert.equal(r.blocked, true);
    assert.equal(r.reason, "ratio-exceeded");
    assert.deepEqual(r.hardOutOfScope, []);
  });
});

describe("extractOutOfScopeFromBody (issue #396)", () => {
  test("pulls backticked paths from a markdown ## section", () => {
    const body = [
      "## Files in scope",
      "- `docs/foo.md`",
      "",
      "## Files out of scope",
      "- `src/preflight.ts`",
      "- `src/control-loop.ts`",
      "",
      "## Risk",
      "low",
    ].join("\n");
    const out = extractOutOfScopeFromBody(body);
    assert.deepEqual(out.sort(), ["src/control-loop.ts", "src/preflight.ts"]);
  });

  test("returns empty when no section is present", () => {
    const body = "## Files in scope\n- `src/foo.ts`\n";
    assert.deepEqual(extractOutOfScopeFromBody(body), []);
  });

  test("does not bleed into the next section", () => {
    const body = [
      "## Files out of scope",
      "- `src/preflight.ts`",
      "## Acceptance criteria",
      "- `src/should-not-appear.ts`",
    ].join("\n");
    assert.deepEqual(extractOutOfScopeFromBody(body), ["src/preflight.ts"]);
  });
});

describe("extractScopeJustifications (issue #396)", () => {
  test("captures an inline justification on the marker line", () => {
    const body = "scope-justification: `src/foo.ts` — needed for the test\n";
    assert.deepEqual(extractScopeJustifications(body), ["src/foo.ts"]);
  });

  test("captures justifications listed in trailing bullets", () => {
    const body = [
      "Some context.",
      "",
      "scope-justification:",
      "- `src/foo.ts`",
      "- `src/bar.ts`",
      "reason: shared regression fixture",
      "",
      "Other unrelated paragraph.",
    ].join("\n");
    const out = extractScopeJustifications(body);
    assert.deepEqual(out.sort(), ["src/bar.ts", "src/foo.ts"]);
  });

  test("is case-insensitive on the marker", () => {
    const body = "Scope-Justification: `src/foo.ts`\n";
    assert.deepEqual(extractScopeJustifications(body), ["src/foo.ts"]);
  });

  test("stops at a heading", () => {
    const body = [
      "scope-justification:",
      "- `src/foo.ts`",
      "## Next section",
      "- `src/bar.ts`",
    ].join("\n");
    assert.deepEqual(extractScopeJustifications(body), ["src/foo.ts"]);
  });

  test("returns empty when no marker is present", () => {
    assert.deepEqual(extractScopeJustifications("just a body\n"), []);
  });
});

// Issue #2175: a cross-repo seam issue can leak Target-repo (hydra-betting)
// sibling paths into `## Files in scope`. An orchestrator PR's CHANGED_FILES
// can never match those, so they only add noise / could mislead the report.
// `isTargetRepoPath` is the boundary-anchored classifier the gate uses to
// filter them out of both scope sets.
describe("isTargetRepoPath (#2175)", () => {
  test("matches conventional Target-repo path forms", () => {
    assert.equal(isTargetRepoPath("hydra-betting/web/src/foo.ts"), true);
    assert.equal(isTargetRepoPath("gaberoo322/hydra-betting/web/x.ts"), true);
    assert.equal(isTargetRepoPath("/home/gabe/hydra-betting/web/y.ts"), true);
    assert.equal(isTargetRepoPath("hydra-betting"), true);
  });

  test("does NOT match orchestrator paths that merely mention the Target", () => {
    // Boundary-anchored: `hydra-betting` must be a full path segment, so an
    // orchestrator file whose name embeds the token is not mis-classified.
    assert.equal(isTargetRepoPath("src/hydra-betting-adapter.ts"), false);
    assert.equal(isTargetRepoPath("scripts/ci/hydra-target-cleanup-emit.ts"), false);
    assert.equal(isTargetRepoPath("src/foo.ts"), false);
  });

  test("treats empty / whitespace input as not-Target", () => {
    assert.equal(isTargetRepoPath(""), false);
    assert.equal(isTargetRepoPath("   "), false);
  });
});
