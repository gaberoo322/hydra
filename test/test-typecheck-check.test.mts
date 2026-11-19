import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { countTscErrors } from "../scripts/ci/test-typecheck-check.ts";

// Issue #750: the test-typecheck gate is a shrink-only baseline ratchet keyed on
// the COUNT of tsc diagnostics over test/** + scripts/**. The whole gate hinges
// on countTscErrors() counting one diagnostic per error — not per output line —
// so a multi-line overload error counts once and continuation/prose lines are
// ignored. These pin that contract.

test("counts a multi-line overload error as exactly one", () => {
  const out = [
    "scripts/foo.ts(219,11): error TS2769: No overload matches this call.",
    "  Overload 1 of 8, '(file: string): void', gave the following error.",
    "    Type 'utf8' is not assignable to type 'buffer'.",
  ].join("\n");
  assert.equal(countTscErrors(out), 1);
});

test("counts distinct single-line diagnostics", () => {
  const out = [
    "test/a.test.mts(28,5): error TS2578: Unused '@ts-expect-error' directive.",
    "test/b.test.mts(31,5): error TS2578: Unused '@ts-expect-error' directive.",
    "test/c.test.mts(82,5): error TS2503: Cannot find namespace 'dc'.",
  ].join("\n");
  assert.equal(countTscErrors(out), 3);
});

test("clean / blank output counts zero", () => {
  assert.equal(countTscErrors(""), 0);
  assert.equal(countTscErrors("\n\n"), 0);
});

test("adding one error raises the count by exactly one (the ratchet property)", () => {
  const base = [
    "test/a.test.mts(28,5): error TS2578: Unused '@ts-expect-error' directive.",
    "test/b.test.mts(31,5): error TS2578: Unused '@ts-expect-error' directive.",
  ].join("\n");
  const withOneMore =
    base + "\ntest/d.test.mts(10,2): error TS2339: Property 'x' does not exist.";
  assert.equal(countTscErrors(withOneMore), countTscErrors(base) + 1);
});

test("does not count prose lines that merely mention 'error TS'", () => {
  // A continuation/message line lacking the leading `path(line,col):` anchor.
  assert.equal(countTscErrors("    See the error TS2769 docs for details."), 0);
});

test("does not count an indented continuation line as a diagnostic", () => {
  // Indented "error" lines (nested overload diagnostics) must not start a count.
  const out = [
    "scripts/foo.ts(1,1): error TS2769: No overload matches this call.",
    "  Overload 2 of 3, gave the following error.",
    "    Object literal may only specify known properties.",
  ].join("\n");
  assert.equal(countTscErrors(out), 1);
});

test("importing the module runs no CLI: no tsc, no process.exit, no check output", () => {
  const modPath = resolve(import.meta.dirname, "../scripts/ci/test-typecheck-check.ts");
  const script = `await import(${JSON.stringify(modPath)}); process.stdout.write("IMPORTED");`;
  const res = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(res.status, 0, `child exit: ${res.status} ${res.stderr}`);
  assert.equal(res.stdout, "IMPORTED");
  assert.doesNotMatch(res.stdout + res.stderr, /\[test-typecheck-check\]/);
});
