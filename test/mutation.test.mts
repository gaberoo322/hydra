/**
 * Unit tests for `src/mutation.ts` — the pure skip-pattern classifier surface
 * of the mutation runner (issue #3095).
 *
 * The runner itself (`runMutationTests`) spawns real ~120s test subprocesses
 * per mutant and is covered by the CI gate (`scripts/ci/mutation-check.ts`);
 * the pure, unit-testable surface is `shouldSkipMutation` + the `SKIP_PATTERNS`
 * classification. The existing `test/mutation-skip-patterns.test.mts` already
 * pins the #402 docs/config/markdown additions — these tests cover the
 * COMPLEMENTARY contract without re-asserting those same rows:
 *
 *   - the structural skip categories (test / spec / .d.ts / drizzle /
 *     migrations / __mocks__ / node_modules) and a plain `src/*.ts` staying
 *     mutable, asserted at nested-path boundaries;
 *   - the `SKIP_PATTERNS` export SHAPE (an array of real RegExp objects).
 *
 * Pure tests — no Redis, no filesystem, no agent calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  shouldSkipMutation,
  SKIP_PATTERNS,
  generateMutations,
  swapComparisonCandidates,
  runMutationTests,
} from "../src/mutation.ts";
import { classifyNoSignal } from "../scripts/ci/mutation-check.ts";

describe("mutation — shouldSkipMutation structural skip categories", () => {
  test("test / spec files are never mutated (any extension, any depth)", () => {
    assert.equal(shouldSkipMutation("src/deep/nested/foo.test.ts"), true);
    assert.equal(shouldSkipMutation("test/event-bus.test.tsx"), true);
    assert.equal(shouldSkipMutation("src/bar.spec.js"), true);
    assert.equal(shouldSkipMutation("packages/x/y.spec.jsx"), true);
  });

  test("type declarations (.d.ts) are skipped", () => {
    assert.equal(shouldSkipMutation("src/types/api.d.ts"), true);
    assert.equal(shouldSkipMutation("global.d.ts"), true);
  });

  test("generated / vendored trees are skipped (drizzle, migrations, __mocks__, node_modules)", () => {
    assert.equal(shouldSkipMutation("drizzle/0001_init.ts"), true);
    assert.equal(shouldSkipMutation("db/migrations/0002_add_col.ts"), true);
    assert.equal(shouldSkipMutation("migration/legacy.ts"), true); // migrations? optional 's'
    assert.equal(shouldSkipMutation("src/__mocks__/redis.ts"), true);
    assert.equal(shouldSkipMutation("node_modules/ioredis/index.js"), true);
  });

  test("a plain production src/*.ts file IS mutated (skip === false)", () => {
    assert.equal(shouldSkipMutation("src/event-bus-mechanics.ts"), false);
    assert.equal(shouldSkipMutation("src/holdback-policy.ts"), false);
    assert.equal(shouldSkipMutation("scripts/ci/mutation-check.ts"), false);
  });

  test("a source file whose name merely CONTAINS 'test' (not a .test suffix) is still mutated", () => {
    // The pattern anchors on the `.test.` extension, not the substring — so a
    // production module about testing is mutated like any other src file.
    assert.equal(shouldSkipMutation("src/test-utils.ts"), false);
    assert.equal(shouldSkipMutation("src/contest.ts"), false);
  });
});

describe("mutation — SKIP_PATTERNS export shape", () => {
  test("is a non-empty array of RegExp objects", () => {
    assert.ok(Array.isArray(SKIP_PATTERNS), "SKIP_PATTERNS must be an array");
    assert.ok(SKIP_PATTERNS.length > 0, "SKIP_PATTERNS must be non-empty");
    for (const pat of SKIP_PATTERNS) {
      assert.ok(pat instanceof RegExp, "every SKIP_PATTERNS entry must be a RegExp");
    }
  });

  test("shouldSkipMutation is the OR of the patterns (skip iff some pattern matches)", () => {
    const skipped = "src/foo.test.ts";
    const mutable = "src/foo.ts";
    assert.equal(SKIP_PATTERNS.some((p) => p.test(skipped)), true);
    assert.equal(shouldSkipMutation(skipped), true);
    assert.equal(SKIP_PATTERNS.some((p) => p.test(mutable)), false);
    assert.equal(shouldSkipMutation(mutable), false);
  });
});

describe("mutation — generation-time mutant validity (issue #5262)", () => {
  test("a generic-only comparison line yields no runnable mutant and one skipped unparseable result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-5262-"));
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      const src = "const m = new Map<string, number>();\n";
      writeFileSync(join(dir, "a.ts"), src);
      const report = await runMutationTests(dir, ["a.ts"], { testCommand: "true" });
      assert.equal(report.totalMutants, 1);
      assert.equal(report.skipped, 1);
      assert.equal(report.skippedUnparseable, 1);
      assert.equal(report.survived, 0);
      assert.equal(report.killed, 0);
      assert.equal(readFileSync(join(dir, "a.ts"), "utf-8"), src, "source is never rewritten");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a line with both a generic and a real comparison yields a parseable swap on the comparison", () => {
    const line = "const m = new Map<string, number>(); if (a > b) {}";
    const { mutations, unparseable } = generateMutations("x.ts", line, ts);
    assert.equal(unparseable.length, 0);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, "swap-comparison");
    assert.ok(mutations[0].mutated.includes("a < b"), mutations[0].mutated);
    assert.ok(mutations[0].mutated.includes("Map<string, number>"));
  });

  test("swapComparisonCandidates prefers ===/!==, then > left-to-right, then <", () => {
    assert.deepEqual(swapComparisonCandidates("a === b"), ["a !== b"]);
    assert.deepEqual(swapComparisonCandidates("x => y"), []);
    assert.deepEqual(swapComparisonCandidates("a >= b"), []);
    assert.equal(swapComparisonCandidates("f<T>(a > b)")[0], "f<T<(a > b)");
  });

  test("a report with only unparseable mutants reaches the all-skipped no-signal branch", () => {
    const report = {
      totalMutants: 2, killed: 0, survived: 0, skipped: 2, timedOut: false, durationMs: 1,
      survivors: [], candidatesGenerated: 2, inconclusive: 0, noCoverage: 0, skippedUnparseable: 2,
    };
    const verdict = classifyNoSignal(report, 3);
    assert.ok(verdict);
    assert.equal(verdict.status, "warn");
    assert.match(verdict.reason, /all generated mutants were skipped/);
  });
});
