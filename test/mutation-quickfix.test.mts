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

describe("no-mutants case (AC: testable < 3 records mutationDecision='no-mutants')", () => {
  test("thin diffs produce zero or near-zero candidates", () => {
    // A docstring-only / formatting-only diff has nothing the MUTATORS can
    // transform. This pins the assumption that thin diffs land in the
    // no-mutants branch of runMutationGate rather than the gate-run branch.
    const docstring = [
      "/**",
      " * Foo does a thing.",
      " */",
      "export const NAME = 'foo';",
    ].join("\n");
    const mutations = generateMutations("/tmp/docs.ts", docstring);
    assert.ok(mutations.length < 3, `docstring-only file should have <3 mutants, got ${mutations.length}`);
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
