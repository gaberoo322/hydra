/**
 * Regression tests for the Tier-0 merge gate facade (issue #249, ADR-0001
 * work-order step 6).
 *
 * Bug: Before extraction, the merge gate was implicit — spread across
 * `control-loop.ts`, `verification.ts`, `pipeline-steps.ts`,
 * `post-merge.ts`, `cost-cap.ts`. The CI tier classifier had nothing
 * to pin as `src/gate.ts`, and a Tier-2 change could in principle
 * alter the merge-proof path.
 *
 * Fix: `src/gate.ts` is a thin facade that names and exposes the
 * eight gate-proof functions. The control loop and adjacent modules
 * import from gate.ts; gate.ts delegates to the existing logic in
 * verification.ts / mutation.ts / scope-enforcement.ts / cost-cap.ts /
 * redis-adapter.ts / pipeline-steps.ts.
 *
 * These tests pin the contract:
 *   - The eight named exports exist.
 *   - Each export is a function with the expected arity.
 *   - `classifyChange(["src/gate.ts"])` returns `{ tier: 0, ... }`
 *     (the tier classifier and protected-paths list from #243).
 *
 * Zero dependencies — uses node:test only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as gate from "../src/gate.ts";
import { classifyChange } from "../src/tier-classifier.ts";
import { UNTOUCHABLE_PATHS, isUntouchable } from "../src/untouchable.ts";

describe("gate.ts — Tier-0 merge gate facade", () => {
  test("exports gateGrounding (workspace, opts?)", () => {
    assert.equal(typeof gate.gateGrounding, "function");
    // (workspace, opts?) — declared length excludes optional with default.
    assert.equal(gate.gateGrounding.length, 1);
  });

  test("exports gateVerify (ctx, task, diff, execResult, complexity, filesInScope, criteriaCount, taskId)", () => {
    assert.equal(typeof gate.gateVerify, "function");
    assert.equal(gate.gateVerify.length, 8);
  });

  test("exports gateScopeEnforcement (ctx, task, verification, taskId)", () => {
    assert.equal(typeof gate.gateScopeEnforcement, "function");
    assert.equal(gate.gateScopeEnforcement.length, 4);
  });

  test("exports gateMutationKillRate (ctx, task, verification, execResult, complexity, filesInScope, criteriaCount, taskId)", () => {
    assert.equal(typeof gate.gateMutationKillRate, "function");
    assert.equal(gate.gateMutationKillRate.length, 8);
  });

  test("exports gateAcquireMergeLock (cycleId, ttlSeconds?)", () => {
    assert.equal(typeof gate.gateAcquireMergeLock, "function");
    // (cycleId, ttlSeconds = 60) — declared length excludes the default.
    assert.equal(gate.gateAcquireMergeLock.length, 1);
  });

  test("exports gateReleaseMergeLock ()", () => {
    assert.equal(typeof gate.gateReleaseMergeLock, "function");
    assert.equal(gate.gateReleaseMergeLock.length, 0);
  });

  test("exports gateMergeToMain (projectDir, cycleId, explicitFeatureBranch?)", () => {
    assert.equal(typeof gate.gateMergeToMain, "function");
    // Function.length counts all declared params up to the first with a
    // default value. Optional `?` params with no default still count, so
    // this is 3.
    assert.equal(gate.gateMergeToMain.length, 3);
  });

  test("exports gateRollback (projectDir, commitSha, reason)", () => {
    assert.equal(typeof gate.gateRollback, "function");
    assert.equal(gate.gateRollback.length, 3);
  });

  test("exports gateCheckCostCap (ctx, task, taskId, checkpoint)", () => {
    assert.equal(typeof gate.gateCheckCostCap, "function");
    assert.equal(gate.gateCheckCostCap.length, 4);
  });
});

describe("gate.ts — Tier-0 classification (CI tier-gate / #243)", () => {
  test("src/gate.ts is listed in UNTOUCHABLE_PATHS", () => {
    assert.ok(
      UNTOUCHABLE_PATHS.includes("src/gate.ts"),
      "src/gate.ts must be in UNTOUCHABLE_PATHS so the tier-gate CI job blocks unapproved edits",
    );
  });

  test("isUntouchable('src/gate.ts') returns true", () => {
    assert.equal(isUntouchable("src/gate.ts"), true);
  });

  test("classifyChange(['src/gate.ts']) returns tier 0", () => {
    const result = classifyChange(["src/gate.ts"]);
    assert.equal(result.tier, 0, `Expected tier 0, got ${result.tier} — reason: ${result.reason}`);
    assert.match(result.reason, /Untouchable Core/i);
  });

  test("classifyChange(['src/gate.ts', 'config/agents/planner.md']) still returns tier 0 (short-circuit)", () => {
    // Mixed-tier PR — gate.ts (Tier 0) must dominate over the prompt-shaped
    // Tier-1 file. This is the contract that makes gate.ts merge-proof.
    const result = classifyChange(["src/gate.ts", "config/agents/planner.md"]);
    assert.equal(result.tier, 0);
  });
});
