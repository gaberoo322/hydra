/**
 * Regression tests for the Target money-critical mutation-gate diff scoping
 * (issue #1057, parent epic #1052).
 *
 * The Target gate mutates ONLY the changed files that `classifyTargetRisk()`
 * flags as money-critical (provider integrations, execution, staking,
 * bet-math). Safe-path PRs — UI, docs, config — collapse to an empty
 * candidate list and skip the mutation runner entirely, keeping the single
 * hydra-server-betting runner fast.
 *
 * These tests exercise the pure `filterMoneyCriticalCandidates` helper in
 * `scripts/target/mutation-check.ts`. They do NOT touch git, the filesystem,
 * or the mutation runner — that contract is what makes the filter
 * unit-testable, mirroring the Orchestrator mutation-check tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { filterMoneyCriticalCandidates } from "../scripts/target/mutation-check.ts";

describe("filterMoneyCriticalCandidates — money-critical diff scoping (issue #1057)", () => {
  test("keeps money-critical files (providers / execution / staking / bet-math)", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/providers/draftkings.ts",
      "src/lib/execution/place-bet.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/bet-math/edge.ts",
    ]);
    assert.deepEqual(result, [
      "src/lib/providers/draftkings.ts",
      "src/lib/execution/place-bet.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/bet-math/edge.ts",
    ]);
  });

  test("drops safe-path files (UI components, pages)", () => {
    const result = filterMoneyCriticalCandidates([
      "src/components/Button.tsx",
      "src/app/dashboard/page.tsx",
      "src/lib/ui/theme.ts",
    ]);
    assert.deepEqual(
      result,
      [],
      "UI/safe paths must NOT be mutated — they don't handle money",
    );
  });

  test("drops markdown / docs / config (safe-path PR)", () => {
    const result = filterMoneyCriticalCandidates([
      "README.md",
      "docs/architecture.md",
      "web/AGENTS.md",
      "package.json",
      ".github/workflows/ci.yml",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops co-located test files even under a money-critical dir", () => {
    // shouldSkipMutation excludes co-located tests; money-critical scoping
    // must not undo that — a green-but-empty *test* file isn't a mutation
    // target.
    const result = filterMoneyCriticalCandidates([
      "src/lib/execution/place-bet.test.ts",
      "src/lib/staking/kelly.spec.ts",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops .d.ts declaration files even under a money-critical dir", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/providers/types.d.ts",
      "src/lib/bet-math/odds.d.ts",
    ]);
    assert.deepEqual(result, []);
  });

  test("mixed diff returns ONLY the money-critical (non-test) subset", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/execution/order-router.ts",
      "src/lib/execution/order-router.test.ts",
      "src/components/Header.tsx",
      "docs/guide.md",
      "src/lib/bet-math/settlement.ts",
      "package-lock.json",
    ]);
    assert.deepEqual(result, [
      "src/lib/execution/order-router.ts",
      "src/lib/bet-math/settlement.ts",
    ]);
  });

  test("safe-path-only PR collapses to empty — gate skips mutation entirely", () => {
    // The core fast-path: a UI/docs/config PR never spins up the mutation
    // runner on the single hydra-server-betting runner.
    const result = filterMoneyCriticalCandidates([
      "src/components/BetSlip.tsx",
      "src/app/(marketing)/page.tsx",
      "docs/changelog.md",
      "tailwind.config.ts",
    ]);
    assert.deepEqual(
      result,
      [],
      "safe-path PRs must skip the Target mutation gate (issue #1057)",
    );
  });

  test("empty input → empty output", () => {
    assert.deepEqual(filterMoneyCriticalCandidates([]), []);
  });

  test("de-duplicates repeated money-critical paths (classifier contract)", () => {
    const result = filterMoneyCriticalCandidates([
      "src/lib/staking/kelly.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/providers/fanduel.ts",
    ]);
    assert.deepEqual(result, [
      "src/lib/staking/kelly.ts",
      "src/lib/providers/fanduel.ts",
    ]);
  });

  test("trims whitespace and drops empty lines (env-var split artefacts)", () => {
    const result = filterMoneyCriticalCandidates([
      "  src/lib/providers/pinnacle.ts  ",
      "",
      "\t",
      "src/lib/bet-math/probability.ts",
    ]);
    assert.deepEqual(result, [
      "src/lib/providers/pinnacle.ts",
      "src/lib/bet-math/probability.ts",
    ]);
  });

  test("normalizes a leading ./ before matching (classifier contract)", () => {
    const result = filterMoneyCriticalCandidates([
      "./src/lib/execution/place-bet.ts",
      "./src/components/Footer.tsx",
    ]);
    assert.deepEqual(result, ["./src/lib/execution/place-bet.ts"]);
  });
});
