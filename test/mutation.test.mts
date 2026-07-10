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

import { shouldSkipMutation, SKIP_PATTERNS } from "../src/mutation.ts";

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
