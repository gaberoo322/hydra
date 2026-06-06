/**
 * Regression tests for the money-critical Target risk classifier
 * (issue #1053, parent epic #1052).
 *
 * The classifier is the data-driven replacement for the hardcoded
 * "NEVER delete src/lib/providers/ or src/lib/execution/" rule. These tests
 * pin the two-level (money-critical vs. safe) contract every downstream Target
 * gate routes on: providers / execution / staking / bet-math are money-critical;
 * UI / docs / config are safe.
 *
 * Pure tests — no Redis, no network, no spawn.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTargetRisk,
  isMoneyCriticalPath,
  MONEY_CRITICAL_TARGET_PATHS,
} from "../src/target/money-critical.ts";

describe("classifyTargetRisk — money-critical surfaces", () => {
  test("flags a path under providers/", () => {
    const r = classifyTargetRisk(["src/lib/providers/betfair.ts"]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/providers/betfair.ts"]);
  });

  test("flags a path under execution/", () => {
    const r = classifyTargetRisk(["src/lib/execution/place-bet.ts"]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("flags a path under staking/", () => {
    const r = classifyTargetRisk(["src/lib/staking/kelly.ts"]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/staking/kelly.ts"]);
  });

  test("flags a path under bet-math/", () => {
    const r = classifyTargetRisk(["src/lib/bet-math/edge.ts"]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/bet-math/edge.ts"]);
  });

  test("flags the directory itself (no trailing slash)", () => {
    // The directory entry must match the bare directory path too, not only
    // children — mirrors the Verifier-Core matcher contract.
    const r = classifyTargetRisk(["src/lib/providers"]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/providers"]);
  });

  test("normalizes a leading ./ before matching", () => {
    const r = classifyTargetRisk(["./src/lib/execution/router.ts"]);
    assert.equal(r.moneyCritical, true);
  });

  test("a mixed set is money-critical if ANY path matches", () => {
    const r = classifyTargetRisk([
      "src/components/Button.tsx",
      "src/lib/execution/place-bet.ts",
      "README.md",
    ]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("collects every matched path across multiple money-critical surfaces", () => {
    const r = classifyTargetRisk([
      "src/lib/providers/betfair.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/bet-math/edge.ts",
    ]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, [
      "src/lib/providers/betfair.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/bet-math/edge.ts",
    ]);
  });
});

describe("classifyTargetRisk — safe surfaces", () => {
  test("UI-only changes are safe", () => {
    const r = classifyTargetRisk([
      "src/components/Scoreboard.tsx",
      "src/pages/dashboard.tsx",
      "src/styles/theme.css",
    ]);
    assert.equal(r.moneyCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("docs-only changes are safe", () => {
    const r = classifyTargetRisk(["README.md", "docs/architecture.md"]);
    assert.equal(r.moneyCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("config-only changes are safe", () => {
    const r = classifyTargetRisk([
      "tsconfig.json",
      "package.json",
      ".github/workflows/ci.yml",
    ]);
    assert.equal(r.moneyCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("a sibling path that merely shares a prefix substring is NOT matched", () => {
    // "src/lib/providers-readme.md" shares the "src/lib/providers" prefix as a
    // raw substring but is not under the providers/ directory — the trailing
    // slash on the directory entry must prevent a false positive.
    const r = classifyTargetRisk(["src/lib/providers-readme.md"]);
    assert.equal(r.moneyCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });
});

describe("classifyTargetRisk — edge cases (pure & total)", () => {
  test("empty input is safe", () => {
    const r = classifyTargetRisk([]);
    assert.equal(r.moneyCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("non-array input degrades to safe rather than throwing", () => {
    // Intentionally passing a non-array to pin the runtime guard; cast keeps
    // the call well-typed without an (unused) @ts-expect-error directive.
    const r = classifyTargetRisk(null as unknown as readonly string[]);
    assert.equal(r.moneyCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("non-string and empty-string entries are ignored", () => {
    const r = classifyTargetRisk([
      "",
      // @ts-expect-error — intentionally mixing in a non-string entry.
      42,
      "src/lib/execution/place-bet.ts",
    ]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("duplicate matched paths are de-duplicated in matchedPaths", () => {
    const r = classifyTargetRisk([
      "src/lib/execution/place-bet.ts",
      "src/lib/execution/place-bet.ts",
    ]);
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });
});

describe("MONEY_CRITICAL_TARGET_PATHS — declared set", () => {
  test("is a single frozen const covering the four money-critical surfaces", () => {
    assert.ok(Object.isFrozen(MONEY_CRITICAL_TARGET_PATHS));
    assert.deepEqual([...MONEY_CRITICAL_TARGET_PATHS], [
      "src/lib/providers/",
      "src/lib/execution/",
      "src/lib/staking/",
      "src/lib/bet-math/",
    ]);
  });

  test("isMoneyCriticalPath is the single-path predicate the set drives", () => {
    assert.equal(isMoneyCriticalPath("src/lib/providers/x.ts"), true);
    assert.equal(isMoneyCriticalPath("src/ui/x.tsx"), false);
    assert.equal(isMoneyCriticalPath(""), false);
  });
});
