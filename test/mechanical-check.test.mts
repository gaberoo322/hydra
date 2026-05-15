/**
 * Regression tests for the mechanical-check classifier (issue #425).
 *
 * The classifier is consumed by the autopilot Option C carve-out:
 * mechanical Tier-0 PRs (file deletions, renames, 1:1 substitutions,
 * literal-to-helper replacements) auto-apply `operator-approved`; everything
 * else queues for operator review. The cost of a false "mechanical" is an
 * unsupervised Tier-0 merge, so the contract is intentionally conservative —
 * "unclear" is the right output whenever the diff looks too big or the
 * parser can't make sense of it.
 *
 * Each test corresponds to a real scenario from the acceptance criteria
 * (file-deletion only, rename only, new ClassName, new case, 60-line const
 * additions, mixed Tier-0+Tier-3, empty diff) or to an edge case observed in
 * real PR diffs that almost tripped the regex (multi-hunk, binary markers,
 * very large diffs, `forEach`/`whileFlag` identifier false positives,
 * trailing-brace `} else {`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyDiff } from "../scripts/ci/mechanical-check.ts";

const TIER0 = ["src/untouchable.ts", "src/gate.ts", "src/rollback.ts"];

function diff(...lines: string[]): string {
  return lines.join("\n");
}

describe("classifyDiff — empty and no-Tier-0 cases", () => {
  test("empty diff -> mechanical", () => {
    assert.equal(classifyDiff("", TIER0), "mechanical");
  });

  test("whitespace-only diff -> mechanical", () => {
    assert.equal(classifyDiff("   \n\t\n", TIER0), "mechanical");
  });

  test("diff touching only non-Tier-0 files -> mechanical", () => {
    const d = diff(
      "diff --git a/src/helpers/format.ts b/src/helpers/format.ts",
      "--- a/src/helpers/format.ts",
      "+++ b/src/helpers/format.ts",
      "@@ -1,3 +1,5 @@",
      " export function fmt(x) {",
      "+  if (x === null) return '';",
      "+  for (let i = 0; i < 10; i++) {}",
      "   return String(x);",
      " }",
    );
    // Even though the patch is loaded with non-mechanical patterns, none of
    // it touches a Tier-0 file -> mechanical from this classifier's POV.
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });
});

describe("classifyDiff — pure deletions and renames on Tier-0", () => {
  test("file deletion only on Tier-0 -> mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "deleted file mode 100644",
      "--- a/src/gate.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-export function gate() {",
      "-  return true;",
      "-}",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("rename only on Tier-0 -> mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "similarity index 100%",
      "rename from src/gate.ts",
      "rename to src/merge-gate.ts",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("deletion of only Tier-0 hunks -> mechanical even when removed lines look risky", () => {
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -10,5 +10,0 @@",
      "-if (x) doSomething();",
      "-for (const f of files) walk(f);",
      "-class Foo {}",
      "-new Date();",
      "-function bar() {}",
    );
    // Removed-only Tier-0 changes have totalAdded === 0 -> mechanical.
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });
});

describe("classifyDiff — non-mechanical patterns on Tier-0 added lines", () => {
  test("new `if` conditional -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,2 @@",
      " export const PATHS = [];",
      "+if (PATHS.length === 0) PATHS.push('src/gate.ts');",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("trailing-brace `} else if (...) {` -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " function gate() {",
      "+} else if (foo) {",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new `for` loop -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " const items = [];",
      "+for (const i of items) drain(i);",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new `while` loop -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " let n = 0;",
      "+while (n < 10) { n++; }",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new `switch`/`case` -> non-mechanical (AC scenario)", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,4 @@",
      " function pick(x) {",
      "+  switch (x) {",
      "+    case 'a': return 1;",
      "+  }",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new `try`/`catch` -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,3 @@",
      " function gate() {",
      "+  try { return doIt(); }",
      "+  catch (e) { return false; }",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new `async function` declaration -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const FLAG = true;",
      "+async function fetchGate() { return await fetch('/'); }",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new `await` expression -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export function gate() {",
      "+  const data = await loader();",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new `new ClassName(...)` -> non-mechanical (AC scenario)", () => {
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,2 @@",
      " export const PATHS = [];",
      "+const cache = new MutexCache(60_000);",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new top-level `function name(` -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,0 +1,3 @@",
      "+export function classify(x: string) {",
      "+  return x;",
      "+}",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("new top-level arrow `const x = () => ...` -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const KEY = 'x';",
      "+const isGate = (x: string): boolean => x.startsWith('gate');",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });
});

describe("classifyDiff — size threshold (50-line limit)", () => {
  test("60-line constant additions -> unclear (AC scenario)", () => {
    const adds = [];
    for (let i = 0; i < 60; i++) adds.push(`+  'src/path${i}.ts',`);
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,61 @@",
      " export const PATHS = [",
      ...adds,
    );
    assert.equal(classifyDiff(d, TIER0), "unclear");
  });

  test("exactly 50-line constant additions -> mechanical (boundary)", () => {
    const adds = [];
    for (let i = 0; i < 50; i++) adds.push(`+  'src/path${i}.ts',`);
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,51 @@",
      " export const PATHS = [",
      ...adds,
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("51-line constant additions -> unclear (boundary +1)", () => {
    const adds = [];
    for (let i = 0; i < 51; i++) adds.push(`+  'src/path${i}.ts',`);
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,52 @@",
      " export const PATHS = [",
      ...adds,
    );
    assert.equal(classifyDiff(d, TIER0), "unclear");
  });
});

describe("classifyDiff — mixed Tier-0 and non-Tier-0 (AC scenario)", () => {
  test("non-mechanical hit in non-Tier-0 file ignored, Tier-0 hunks clean -> mechanical", () => {
    const d = diff(
      "diff --git a/src/helpers/format.ts b/src/helpers/format.ts",
      "--- a/src/helpers/format.ts",
      "+++ b/src/helpers/format.ts",
      "@@ -1,1 +1,3 @@",
      " export function fmt(x) {",
      "+  if (!x) return '';",
      "+  return String(x);",
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,2 @@",
      " export const PATHS = [",
      "+  'src/gate.ts',",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("Tier-0 hunk has non-mechanical pattern, non-Tier-0 is clean -> non-mechanical", () => {
    const d = diff(
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,2 @@",
      " # Project",
      "+New paragraph.",
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export function gate() {",
      "+  if (broken) return false;",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });
});

describe("classifyDiff — false-positive guards", () => {
  test("identifier `forEach` does NOT trip the for-loop pattern", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " const items = [];",
      "+items.forEach(i => use(i));",
    );
    // `items.forEach(` should NOT match `^\s*(for|while|do)\s*[({]`. But the
    // arrow-callback inside .forEach is also not a top-level arrow assignment,
    // so this whole line should be mechanical.
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("identifier `whileFlag` does NOT trip the while-loop pattern", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const FLAGS = {};",
      "+FLAGS.whileFlag = true;",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("`const x = (1 + 2);` arithmetic does NOT trip the arrow pattern", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const A = 0;",
      "+const SUM = (1 + 2);",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("lowercase `new date(...)` does NOT trip the new-ClassName pattern", () => {
    // The classifier requires a capitalised identifier after `new`. This
    // guards against a literal-to-helper rename like `new path()` where
    // `path` is a local helper, not a class.
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const X = 0;",
      "+const y = new_helper();",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });
});

describe("classifyDiff — edge cases", () => {
  test("multi-hunk diff on a Tier-0 file with one non-mechanical hunk -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,2 @@",
      " export const PATHS = [",
      "+  'src/gate.ts',",
      "@@ -50,1 +51,2 @@",
      " export const OTHER = [];",
      "+if (PATHS.length > 0) cache.invalidate();",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("binary file marker on Tier-0 -> unclear", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "Binary files a/src/gate.ts and b/src/gate.ts differ",
    );
    assert.equal(classifyDiff(d, TIER0), "unclear");
  });

  test("binary file marker on non-Tier-0 -> mechanical (ignored)", () => {
    const d = diff(
      "diff --git a/dashboard/public/logo.png b/dashboard/public/logo.png",
      "Binary files a/dashboard/public/logo.png and b/dashboard/public/logo.png differ",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });

  test("very large diff with 500 clean additions on Tier-0 -> unclear", () => {
    const adds: string[] = [];
    for (let i = 0; i < 500; i++) adds.push(`+  'path${i}',`);
    const d = diff(
      "diff --git a/src/untouchable.ts b/src/untouchable.ts",
      "--- a/src/untouchable.ts",
      "+++ b/src/untouchable.ts",
      "@@ -1,1 +1,501 @@",
      " export const PATHS = [",
      ...adds,
    );
    assert.equal(classifyDiff(d, TIER0), "unclear");
  });

  test("prefix Tier-0 entry (e.g. 'src/gate/') matches any file underneath", () => {
    const d = diff(
      "diff --git a/src/gate/preflight.ts b/src/gate/preflight.ts",
      "--- a/src/gate/preflight.ts",
      "+++ b/src/gate/preflight.ts",
      "@@ -1,1 +1,2 @@",
      " export const X = 0;",
      "+if (X === 0) refuse();",
    );
    // 'src/gate/' is a directory prefix -> matches src/gate/preflight.ts
    assert.equal(classifyDiff(d, ["src/gate/"]), "non-mechanical");
  });

  test("empty tier0Files list -> mechanical regardless of diff content", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const X = 0;",
      "+if (X === 0) refuse();",
    );
    // No Tier-0 declared -> the carve-out classifier has nothing to gate on.
    assert.equal(classifyDiff(d, []), "mechanical");
  });

  test("idempotency: same input -> same output (smoke check)", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const X = 0;",
      "+if (X === 0) refuse();",
    );
    const a = classifyDiff(d, TIER0);
    const b = classifyDiff(d, TIER0);
    const c = classifyDiff(d, TIER0);
    assert.equal(a, "non-mechanical");
    assert.equal(b, a);
    assert.equal(c, a);
  });

  test("`new Date()` is intentionally flagged — capitalised class -> non-mechanical", () => {
    // Confirms the lowercase-guard documented in the source: `new` followed by
    // a capitalised identifier is treated as instantiation, even for built-ins.
    // If a Tier-0 file is starting to instantiate Date()/Map()/Set() that's
    // worth an operator glance.
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const X = 0;",
      "+const now = new Date();",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("diff without `diff --git` header but with `+++ b/` header still parses", () => {
    const d = diff(
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const X = 0;",
      "+if (X === 0) refuse();",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("default case `default:` is recognised as case-clause -> non-mechanical", () => {
    const d = diff(
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -1,1 +1,2 @@",
      " export const X = 0;",
      "+    default:",
    );
    assert.equal(classifyDiff(d, TIER0), "non-mechanical");
  });

  test("commit-message preamble before the first diff header is ignored", () => {
    // Some tooling prefixes the diff with the commit subject and a blank line.
    // The parser must skip stray content until it sees a `diff --git` or
    // `+++ b/` header — otherwise it would mis-attribute lines to a phantom
    // file.
    const d = diff(
      "commit abc123",
      "Author: ci-bot",
      "Subject: chore: rename gate.ts",
      "",
      "diff --git a/src/gate.ts b/src/gate.ts",
      "similarity index 100%",
      "rename from src/gate.ts",
      "rename to src/merge-gate.ts",
    );
    assert.equal(classifyDiff(d, TIER0), "mechanical");
  });
});
