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
import {
  filterMoneyCriticalCandidates,
  classifyNoSignal,
} from "../scripts/target/mutation-check.ts";
import type { MutationTestReport } from "../src/mutation.ts";

/**
 * Build a MutationTestReport for the no-signal tests. Only the fields
 * `classifyNoSignal` reads (totalMutants / skipped / killed / candidatesGenerated)
 * are meaningful; the rest are inert defaults so the seam stays pure and the
 * test never touches the runner.
 */
function makeReport(overrides: Partial<MutationTestReport>): MutationTestReport {
  return {
    totalMutants: 0,
    killed: 0,
    survived: 0,
    skipped: 0,
    timedOut: false,
    durationMs: 0,
    survivors: [],
    candidatesGenerated: 0,
    ...overrides,
  };
}

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

describe("classifyNoSignal — tier-less no-signal gate (issue #1132)", () => {
  test("no mutants generated → warn, null killRate, generator-empty reason", () => {
    // candidatesGenerated === 0: the generator emitted nothing (comment-only /
    // trivial money-critical diff). Must NOT fabricate killRate=100.
    const result = classifyNoSignal(
      makeReport({ totalMutants: 0, skipped: 0, candidatesGenerated: 0 }),
    );
    assert.ok(result, "testable === 0 must yield a classification, not null");
    assert.equal(result!.status, "warn");
    assert.equal(result!.killRate, null);
    assert.match(result!.reason, /no mutants generated/);
    assert.match(result!.reason, /no fault-detection signal/);
  });

  test("all generated mutants skipped → warn, null killRate, all-skipped reason", () => {
    // totalMutants > 0 && skipped === totalMutants: every candidate was
    // uncompilable, so testable === 0 with a non-empty generator.
    const result = classifyNoSignal(
      makeReport({ totalMutants: 5, skipped: 5, candidatesGenerated: 5 }),
    );
    assert.ok(result);
    assert.equal(result!.status, "warn");
    assert.equal(result!.killRate, null);
    assert.match(result!.reason, /all generated mutants were skipped/);
    assert.match(result!.reason, /no fault-detection signal/);
  });

  test("the two no-signal sub-cases produce DISTINCT reasons", () => {
    const noneGenerated = classifyNoSignal(
      makeReport({ totalMutants: 0, skipped: 0, candidatesGenerated: 0 }),
    );
    const allSkipped = classifyNoSignal(
      makeReport({ totalMutants: 3, skipped: 3, candidatesGenerated: 3 }),
    );
    assert.ok(noneGenerated && allSkipped);
    assert.notEqual(
      noneGenerated!.reason,
      allSkipped!.reason,
      "no-mutants-generated and all-skipped must be distinguishable in the JSON",
    );
  });

  test("testable > 0 → returns null (caller runs the normal kill-rate path)", () => {
    // 4 testable mutants (10 total - 6 skipped). The seam must hand control back
    // to main()'s kill-rate comparison rather than short-circuiting.
    const result = classifyNoSignal(
      makeReport({
        totalMutants: 10,
        skipped: 6,
        killed: 4,
        candidatesGenerated: 10,
      }),
    );
    assert.equal(result, null);
  });

  test("a single testable mutant is enough to leave the no-signal branch", () => {
    // Boundary: testable === 1 is signal, so no classification.
    const result = classifyNoSignal(
      makeReport({
        totalMutants: 1,
        skipped: 0,
        killed: 1,
        candidatesGenerated: 1,
      }),
    );
    assert.equal(result, null);
  });

  test("ALWAYS warns on no-signal — never neutral (no Target tier analogue)", () => {
    // The deliberate divergence from the Orchestrator helper: every file
    // reaching this branch is money-critical, so there is no neutral/T1-T2
    // sub-case. Both no-signal shapes must be warn.
    for (const report of [
      makeReport({ totalMutants: 0, skipped: 0, candidatesGenerated: 0 }),
      makeReport({ totalMutants: 7, skipped: 7, candidatesGenerated: 7 }),
    ]) {
      const result = classifyNoSignal(report);
      assert.ok(result);
      assert.equal(
        result!.status,
        "warn",
        "Target no-signal is always money-critical → warn, never neutral",
      );
    }
  });

  test("no-signal classification never synthesises a killRate (null only)", () => {
    // The root-cause invariant of #1120/#1132: the no-signal branch must not
    // fabricate killRate=100. killRate is typed `null` and must stay null.
    const result = classifyNoSignal(
      makeReport({ totalMutants: 2, skipped: 2, candidatesGenerated: 2 }),
    );
    assert.ok(result);
    assert.strictEqual(result!.killRate, null);
  });
});
