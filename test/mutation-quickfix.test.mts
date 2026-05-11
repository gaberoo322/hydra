/**
 * Tests for the quick-fix mutation gate (issue #272).
 *
 * Pre-#272, quick-fix cycles bypassed mutation testing entirely:
 *   - `complexity !== "quick-fix"` gate in src/mutation.ts:354
 *   - JIT gate also skipped on quick-fix in src/verification.ts:221/229
 * That meant the mutation+JIT quality gates only protected ~5% of merges
 * (verified by 50-cycle trend in issue #272). This file pins the new
 * behavior so the gate-coverage regression never silently returns.
 *
 * Coverage:
 *   - getQuickFixKillThreshold reads MUTATION_QUICKFIX_THRESHOLD env (default 50)
 *   - MUTATION_DECISION constants are stable strings (dashboard contract)
 *   - computeQualityGateCoverage logic (AC: qualityGateCoverage boolean)
 *   - runMutationTests honors `maxMutants` cap (quick-fix budget)
 *   - generated-mutation count for thin diffs (no-mutants observability case)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getQuickFixKillThreshold,
  MUTATION_DECISION,
  generateMutations,
  runMutationTests,
  classifyNoSignalDecision,
} from "../src/mutation.ts";
import { computeQualityGateCoverage } from "../src/post-merge.ts";

describe("getQuickFixKillThreshold (issue #272)", () => {
  test("returns 50 by default when env unset", () => {
    const prev = process.env.MUTATION_QUICKFIX_THRESHOLD;
    delete process.env.MUTATION_QUICKFIX_THRESHOLD;
    try {
      assert.equal(getQuickFixKillThreshold(), 50);
    } finally {
      if (prev !== undefined) process.env.MUTATION_QUICKFIX_THRESHOLD = prev;
    }
  });

  test("honors valid env override", () => {
    const prev = process.env.MUTATION_QUICKFIX_THRESHOLD;
    process.env.MUTATION_QUICKFIX_THRESHOLD = "75";
    try {
      assert.equal(getQuickFixKillThreshold(), 75);
    } finally {
      if (prev === undefined) delete process.env.MUTATION_QUICKFIX_THRESHOLD;
      else process.env.MUTATION_QUICKFIX_THRESHOLD = prev;
    }
  });

  test("falls back to default on invalid env values", () => {
    const prev = process.env.MUTATION_QUICKFIX_THRESHOLD;
    for (const bad of ["", "abc", "-5", "101", "NaN"]) {
      process.env.MUTATION_QUICKFIX_THRESHOLD = bad;
      assert.equal(getQuickFixKillThreshold(), 50, `bad value ${JSON.stringify(bad)} should fall back to 50`);
    }
    if (prev === undefined) delete process.env.MUTATION_QUICKFIX_THRESHOLD;
    else process.env.MUTATION_QUICKFIX_THRESHOLD = prev;
  });

  test("accepts 0 and 100 as valid (boundary)", () => {
    const prev = process.env.MUTATION_QUICKFIX_THRESHOLD;
    process.env.MUTATION_QUICKFIX_THRESHOLD = "0";
    assert.equal(getQuickFixKillThreshold(), 0);
    process.env.MUTATION_QUICKFIX_THRESHOLD = "100";
    assert.equal(getQuickFixKillThreshold(), 100);
    if (prev === undefined) delete process.env.MUTATION_QUICKFIX_THRESHOLD;
    else process.env.MUTATION_QUICKFIX_THRESHOLD = prev;
  });
});

describe("MUTATION_DECISION (issue #272)", () => {
  test("constants are stable strings for the dashboard contract", () => {
    // Don't change these without coordinating with the metrics consumer in
    // src/metrics.ts and the dashboard quality-gate panel.
    assert.equal(MUTATION_DECISION.RAN, "ran");
    assert.equal(MUTATION_DECISION.NO_MUTANTS, "no-mutants");
    assert.equal(MUTATION_DECISION.COST_CAP_SKIP, "cost-cap-skip");
    assert.equal(MUTATION_DECISION.NO_FILES, "skipped: no files changed");
    assert.equal(MUTATION_DECISION.ERROR, "error");
  });
});

describe("computeQualityGateCoverage (issue #272)", () => {
  test("true when mutation gate ran", () => {
    assert.equal(computeQualityGateCoverage("ran", null), true);
    assert.equal(computeQualityGateCoverage("ran", { decision: "skipped: quick-fix" }), true);
  });

  test("true when JIT gate ran (decision starts with 'ran')", () => {
    assert.equal(computeQualityGateCoverage("no-mutants", { decision: "ran: 3 tests added" }), true);
    assert.equal(
      computeQualityGateCoverage("skipped: no files changed", { decision: "ran: bug detected — merge blocked" }),
      true,
    );
  });

  test("false when both gates skipped", () => {
    assert.equal(computeQualityGateCoverage("no-mutants", { decision: "skipped: quick-fix" }), false);
    assert.equal(computeQualityGateCoverage("cost-cap-skip", { decision: "skipped: no diff" }), false);
    assert.equal(computeQualityGateCoverage("skipped: no files changed", null), false);
  });

  test("false when both gates errored (error is not coverage)", () => {
    // An error means the gate didn't produce a real signal — the operator
    // should treat that the same as a skip for coverage accounting.
    assert.equal(computeQualityGateCoverage("error", { decision: "error: parse failed" }), false);
  });

  test("undefined mutationDecision treated as skip", () => {
    assert.equal(computeQualityGateCoverage(undefined, null), false);
    assert.equal(computeQualityGateCoverage(undefined, { decision: "ran: 2 tests" }), true);
  });
});

describe("runMutationTests maxMutants cap (issue #272 quick-fix budget)", () => {
  let workdir: string;

  test("caps candidate count when maxMutants is set", async () => {
    workdir = await mkdtemp(join(tmpdir(), "mutation-quickfix-"));
    try {
      // Write a file with >10 mutation candidates so we can see the cap in action.
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(`  if (x${i} === ${i}) return true;`);
      }
      const sourceFile = join(workdir, "many-mutants.ts");
      await writeFile(sourceFile, lines.join("\n"));
      // Also a package.json so the appDir probe doesn't go searching subdirs.
      await writeFile(join(workdir, "package.json"), '{"name":"x","scripts":{"test":"true"}}');

      // First confirm the generator finds plenty of candidates.
      const generated = generateMutations(sourceFile, lines.join("\n"));
      assert.ok(generated.length >= 10, `expected ≥10 candidates, got ${generated.length}`);

      // Run with cap=3 and an immediate-success test command — every
      // mutant will "survive", but we just want to count how many were tested.
      const reportCapped = await runMutationTests(
        workdir,
        ["many-mutants.ts"],
        { maxMutants: 3, testCommand: "true", timeBudgetMs: 30_000 },
      );
      assert.equal(reportCapped.totalMutants, 3, "cap should limit results to 3 mutants");

      // And without the cap we get all of them.
      const reportUncapped = await runMutationTests(
        workdir,
        ["many-mutants.ts"],
        { testCommand: "true", timeBudgetMs: 30_000 },
      );
      assert.ok(
        reportUncapped.totalMutants >= 10,
        `uncapped run should test all candidates, got ${reportUncapped.totalMutants}`,
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

describe("no-mutants case (AC: zero candidates records mutationDecision='no-mutants')", () => {
  test("thin diffs produce zero or near-zero candidates", () => {
    // A docstring-only / formatting-only diff has nothing the MUTATORS can
    // transform. Pre-#300 this landed in NO_MUTANTS regardless of size; post-#300
    // it only lands in NO_MUTANTS when candidatesGenerated === 0.
    const docstring = [
      "/**",
      " * Foo does a thing.",
      " */",
      "export const NAME = 'foo';",
    ].join("\n");
    const mutations = generateMutations("/tmp/docs.ts", docstring);
    assert.equal(mutations.length, 0, `docstring-only file should have 0 mutants, got ${mutations.length}`);
  });

  test("thin boolean assignment still produces some candidates (sanity)", () => {
    // Make sure the test above isn't accidentally too permissive — a file
    // with three boolean returns SHOULD produce three mutants.
    const src = [
      "export function a() { return true; }",
      "export function b() { return false; }",
      "export function c() { return true; }",
    ].join("\n");
    const mutations = generateMutations("/tmp/booleans.ts", src);
    assert.ok(mutations.length >= 3, `three-bool file should have ≥3 mutants, got ${mutations.length}`);
  });
});

// =============================================================================
// Issue #300 regression: the gate must classify small-but-non-zero mutant runs
// as RAN, not NO_MUTANTS.
//
// Pre-#300, `testable < 3` short-circuited the decision to NO_MUTANTS. Telemetry
// in the issue showed `mutationsTested: 2, mutationSurvived: 0` constant for
// 17 of 20 cycles, with `mutationDecision: "no-mutants"` — i.e. the engine had
// run, killed both mutants, but the gate reported "didn't run". That kept
// qualityGateCoverageRate stuck at 14% even after #287 landed.
// =============================================================================

describe("MutationTestReport.candidatesGenerated (issue #300)", () => {
  let workdir: string;

  test("populates candidatesGenerated from pre-cap mutation count", async () => {
    workdir = await mkdtemp(join(tmpdir(), "mutation-issue300-"));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(`  if (x${i} === ${i}) return true;`);
      }
      const sourceFile = join(workdir, "many-mutants.ts");
      await writeFile(sourceFile, lines.join("\n"));
      await writeFile(join(workdir, "package.json"), '{"name":"x","scripts":{"test":"true"}}');

      // Even with maxMutants capping totalMutants to 5, candidatesGenerated
      // reflects the unfiltered candidate count.
      const report = await runMutationTests(
        workdir,
        ["many-mutants.ts"],
        { maxMutants: 5, testCommand: "true", timeBudgetMs: 30_000 },
      );
      assert.equal(report.totalMutants, 5, "cap should limit results to 5");
      assert.ok(
        report.candidatesGenerated >= 10,
        `candidatesGenerated should reflect pre-cap count (>=10), got ${report.candidatesGenerated}`,
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("candidatesGenerated === 0 for diffs the mutators cannot transform", async () => {
    workdir = await mkdtemp(join(tmpdir(), "mutation-issue300-nomut-"));
    try {
      const inert = [
        "// just a comment",
        "/* and another */",
        "export const NAME = 'foo';",
        "import { x } from 'y';",
      ].join("\n");
      const sourceFile = join(workdir, "inert.ts");
      await writeFile(sourceFile, inert);
      await writeFile(join(workdir, "package.json"), '{"name":"x","scripts":{"test":"true"}}');

      const report = await runMutationTests(
        workdir,
        ["inert.ts"],
        { testCommand: "true", timeBudgetMs: 30_000 },
      );
      assert.equal(report.candidatesGenerated, 0, "comment/import-only diff yields zero candidates");
      assert.equal(report.totalMutants, 0);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("candidatesGenerated > 0 for a diff with mutation-eligible expressions (small sample)", async () => {
    // AC: "diff with mutation-eligible expressions → RAN with ≥1 mutant".
    // A 2-mutant file is exactly the small-sample case the pre-#300 gate
    // silently downgraded to NO_MUTANTS. Verify the generator emits them.
    workdir = await mkdtemp(join(tmpdir(), "mutation-issue300-small-"));
    try {
      const src = [
        "export function a() { return true; }",
        "export function b() { return false; }",
      ].join("\n");
      const sourceFile = join(workdir, "small.ts");
      await writeFile(sourceFile, src);
      await writeFile(join(workdir, "package.json"), '{"name":"x","scripts":{"test":"true"}}');

      const report = await runMutationTests(
        workdir,
        ["small.ts"],
        { testCommand: "true", timeBudgetMs: 30_000 },
      );
      // Two boolean returns => two mutants, each "survives" against `true`.
      assert.equal(report.candidatesGenerated, 2);
      assert.equal(report.totalMutants, 2);
      // The critical post-#300 invariant: testable > 0 means the gate has
      // real signal. We assert testable here as the value the gate uses.
      const testable = report.totalMutants - report.skipped;
      assert.equal(testable, 2, "small-but-non-zero testable count must survive into the gate");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

describe("MUTATION_DECISION.ALL_UNCOMPILABLE (issue #300)", () => {
  test("is a stable string distinct from no-mutants", () => {
    assert.equal(MUTATION_DECISION.ALL_UNCOMPILABLE, "skipped: all-mutants-uncompilable");
    assert.notEqual(MUTATION_DECISION.ALL_UNCOMPILABLE, MUTATION_DECISION.NO_MUTANTS);
  });
});

describe("classifyNoSignalDecision (issue #300)", () => {
  test("returns null (caller uses RAN) when testable > 0 regardless of count", () => {
    // The bug: pre-#300 the gate used `testable < 3` and reported NO_MUTANTS
    // for 1- or 2-mutant runs. Post-#300, ANY positive testable count is
    // real signal — classify as RAN by returning null.
    assert.equal(classifyNoSignalDecision(1, 1), null);
    assert.equal(classifyNoSignalDecision(2, 2), null);
    assert.equal(classifyNoSignalDecision(2, 5), null); // capped sample
    assert.equal(classifyNoSignalDecision(10, 10), null);
  });

  test("returns NO_MUTANTS when zero candidates were generated", () => {
    // Comment-only / import-only / formatting-only diff: the mutators had
    // nothing to transform. This is the only legitimate no-mutants case.
    assert.equal(classifyNoSignalDecision(0, 0), MUTATION_DECISION.NO_MUTANTS);
  });

  test("returns ALL_UNCOMPILABLE when candidates were generated but all failed to apply", () => {
    // The mutators emitted candidates, but every applied mutant was skipped
    // (read error, compile error). Distinct decision so the dashboard does
    // not blame the diff for being inert.
    assert.equal(classifyNoSignalDecision(0, 3), MUTATION_DECISION.ALL_UNCOMPILABLE);
    assert.equal(classifyNoSignalDecision(0, 1), MUTATION_DECISION.ALL_UNCOMPILABLE);
  });
});
