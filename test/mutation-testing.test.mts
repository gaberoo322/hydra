/**
 * Tests for mutation testing helpers, inlined into src/verification.ts (issue #67).
 *
 * Tests the mutation generation logic and skip patterns via the _testing
 * escape hatch. The full test-runner integration is tested by running
 * a cycle with mutation testing enabled.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { _testing } from "../src/verification.ts";

const { MUTATORS, SKIP_PATTERNS, shouldSkipMutation } = _testing;

// Extract individual mutator apply functions by type for direct testing
const negateBoolean = MUTATORS.find((m) => m.type === "negate-boolean-return")!.apply;
const swapComparison = MUTATORS.find((m) => m.type === "swap-comparison")!.apply;
const negateCondition = MUTATORS.find((m) => m.type === "negate-condition")!.apply;
const removeEarlyReturn = MUTATORS.find((m) => m.type === "remove-early-return")!.apply;

describe("mutation generation", () => {
  test("negates boolean returns", () => {
    assert.equal(negateBoolean("    return true;"), "    return false;");
    assert.equal(negateBoolean("    return false;"), "    return true;");
    assert.equal(negateBoolean("    return x + 1;"), null);
  });

  test("swaps comparison operators", () => {
    assert.equal(swapComparison("  if (a === b)"), "  if (a !== b)");
    assert.equal(swapComparison("  if (a !== b)"), "  if (a === b)");
    assert.equal(swapComparison("  const x = 5;"), null);
  });

  test("negates conditions", () => {
    assert.equal(negateCondition("  if (x > 0) {"), "  if (!(x > 0)) {");
    assert.equal(negateCondition("  if (ready) {"), "  if (!(ready)) {");
    assert.equal(negateCondition("  const x = 5;"), null);
  });

  test("removes early returns", () => {
    assert.equal(removeEarlyReturn("    return result;"), "    /* MUTANT: removed return */");
    assert.equal(removeEarlyReturn("    return { ok: true };"), "    /* MUTANT: removed return */");
    assert.equal(removeEarlyReturn("    return;"), null); // bare return should not be removed
  });

  test("does not mutate unrelated lines", () => {
    assert.equal(negateBoolean("  const x = 5;"), null);
    assert.equal(negateBoolean("  console.log('hello');"), null);
    assert.equal(removeEarlyReturn("  import { foo } from 'bar';"), null);
  });
});

describe("skip patterns", () => {
  test("skips test files", () => {
    assert.equal(shouldSkipMutation("src/lib/foo.test.ts"), true);
    assert.equal(shouldSkipMutation("src/lib/foo.spec.tsx"), true);
  });

  test("skips config files", () => {
    assert.equal(shouldSkipMutation("vitest.config.ts"), true);
    assert.equal(shouldSkipMutation("next.config.js"), true);
  });

  test("skips type declarations", () => {
    assert.equal(shouldSkipMutation("src/types/foo.d.ts"), true);
  });

  test("skips drizzle and migration dirs", () => {
    assert.equal(shouldSkipMutation("drizzle/0001_add_table.sql"), true);
    assert.equal(shouldSkipMutation("src/migrations/001.ts"), true);
  });

  test("does not skip regular source files", () => {
    assert.equal(shouldSkipMutation("src/lib/arb-scanner.ts"), false);
    assert.equal(shouldSkipMutation("src/app/page.tsx"), false);
  });
});
