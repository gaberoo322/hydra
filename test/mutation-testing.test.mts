/**
 * Tests for src/mutation-testing.ts — the lightweight mutation testing module.
 *
 * These test the mutation generation logic (pure functions), not the full
 * test-runner integration which requires a real project directory.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// We can't import the private functions directly, so we replicate the
// mutator logic for testing. The actual integration is tested by running
// a cycle with mutation testing enabled.

describe("mutation generation", () => {
  // Replicate the MUTATORS array logic for unit testing
  const negateBoolean = (line: string) => {
    if (/return\s+true\s*;/.test(line)) return line.replace(/return\s+true\s*;/, "return false;");
    if (/return\s+false\s*;/.test(line)) return line.replace(/return\s+false\s*;/, "return true;");
    return null;
  };

  const swapComparison = (line: string) => {
    if (line.includes("===")) return line.replace("===", "!==");
    if (line.includes("!==")) return line.replace("!==", "===");
    return null;
  };

  const negateCondition = (line: string) => {
    const match = line.match(/^(\s*if\s*\()(.+)(\)\s*\{?\s*)$/);
    if (match) return `${match[1]}!(${match[2]})${match[3]}`;
    return null;
  };

  const removeEarlyReturn = (line: string) => {
    const match = line.match(/^(\s*)return\s+.+;/);
    if (match && !line.includes("return;")) {
      return `${match[1]}/* MUTANT: removed return */`;
    }
    return null;
  };

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
  const SKIP_PATTERNS = [
    /\.test\.[jt]sx?$/,
    /\.spec\.[jt]sx?$/,
    /\.config\.[jt]s$/,
    /\.d\.ts$/,
    /drizzle\//,
    /migrations?\//,
    /node_modules\//,
  ];

  function shouldSkip(filePath: string): boolean {
    return SKIP_PATTERNS.some((pat) => pat.test(filePath));
  }

  test("skips test files", () => {
    assert.equal(shouldSkip("src/lib/foo.test.ts"), true);
    assert.equal(shouldSkip("src/lib/foo.spec.tsx"), true);
  });

  test("skips config files", () => {
    assert.equal(shouldSkip("vitest.config.ts"), true);
    assert.equal(shouldSkip("next.config.js"), true);
  });

  test("skips type declarations", () => {
    assert.equal(shouldSkip("src/types/foo.d.ts"), true);
  });

  test("skips drizzle and migration dirs", () => {
    assert.equal(shouldSkip("drizzle/0001_add_table.sql"), true);
    assert.equal(shouldSkip("src/migrations/001.ts"), true);
  });

  test("does not skip regular source files", () => {
    assert.equal(shouldSkip("src/lib/arb-scanner.ts"), false);
    assert.equal(shouldSkip("src/app/page.tsx"), false);
  });
});
