/**
 * Regression tests for the modification-tier classifier (issue #243,
 * ADR-0001 + ADR-0004 work-order step 3).
 *
 * Bug we're preventing: Hydra agents merging changes to the merge gate,
 * rollback logic, watchdog, or cost guardrails without operator review.
 * This happened in the 2026-05-10 sweep when `gh pr merge --admin` was
 * used to bypass GitHub's self-approval rule. The tier classifier +
 * `tier-gate` CI job is the structural fix: any PR touching a Tier-0
 * path fails CI unless the `operator-approved` label is applied.
 *
 * Pure tests — no Redis, no network, no spawn. Verifies the classifier
 * function and the CLI wrapper's exit-code contract.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  classifyChange,
  UNTOUCHABLE_PATHS,
} from "../src/tier-classifier.ts";
import { isUntouchable, matchUntouchable } from "../src/untouchable.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WRAPPER = resolve(REPO_ROOT, "scripts/tier-classify.ts");

describe("tier classifier — Tier 0 (Untouchable Core)", () => {
  test("known protected paths classify as tier 0", () => {
    for (const p of UNTOUCHABLE_PATHS) {
      const r = classifyChange([p]);
      assert.equal(r.tier, 0, `${p} should be tier 0`);
      assert.match(r.reason, /Untouchable Core/);
    }
  });

  test("isUntouchable returns true for protected paths and false otherwise", () => {
    // gate.ts / verification.ts / post-merge.ts / control-loop.ts were
    // removed from the protected-paths list in PR-3 (issue #383) along with
    // the files themselves (the in-process codex control loop is gone).
    assert.equal(isUntouchable("src/grounding.ts"), true);
    // redis-adapter.ts was retired in the ADR-0009 closure (shim deleted; all
    // callers go directly to src/redis/<domain>.ts).
    assert.equal(isUntouchable("src/redis-adapter.ts"), false);
    assert.equal(isUntouchable("src/cost/cap.ts"), true);
    assert.equal(isUntouchable("scripts/deploy.sh"), true);
    assert.equal(isUntouchable(".github/workflows/ci.yml"), true);

    // No longer protected — files were deleted in PR-3 #383
    assert.equal(isUntouchable("src/control-loop.ts"), false);
    assert.equal(isUntouchable("src/verification.ts"), false);
    assert.equal(isUntouchable("src/post-merge.ts"), false);
    assert.equal(isUntouchable("src/gate.ts"), false);

    assert.equal(isUntouchable("src/anchor-selection.ts"), false);
    assert.equal(isUntouchable("config/agents/planner.md"), false);
    assert.equal(isUntouchable("dashboard/src/App.tsx"), false);
    assert.equal(isUntouchable("README.md"), false);
    assert.equal(isUntouchable(""), false);
  });

  test("matchUntouchable returns the matched entry", () => {
    assert.equal(matchUntouchable("src/grounding.ts"), "src/grounding.ts");
    assert.equal(matchUntouchable("src/anchor-selection.ts"), null);
  });

  test("the untouchable list itself triggers tier 0 (self-protection)", () => {
    const r = classifyChange(["src/untouchable.ts"]);
    assert.equal(r.tier, 0);
    const r2 = classifyChange(["src/tier-classifier.ts"]);
    assert.equal(r2.tier, 0);
    const r3 = classifyChange(["scripts/tier-classify.ts"]);
    assert.equal(r3.tier, 0);
  });

  // The "future-extracted gate.ts is already protected (proactive)" test was
  // removed in PR-3 (issue #383): gate.ts was created, lived briefly as the
  // merge-gate facade, then deleted along with the in-process control loop.
  // The proactive-protection pattern is exercised below for paths that
  // remain on the untouchable list.

  test("./-prefixed paths normalize correctly", () => {
    const r = classifyChange(["./src/grounding.ts"]);
    assert.equal(r.tier, 0);
  });
});

describe("tier classifier — Tier 1 (auto-merge prompt-shaped)", () => {
  test("config/agents files are tier 1", () => {
    const r = classifyChange(["config/agents/planner.md"]);
    assert.equal(r.tier, 1);
  });

  test("config/feedback files are tier 1", () => {
    const r = classifyChange(["config/feedback/to-planner.md"]);
    assert.equal(r.tier, 1);
  });

  test("multiple tier-1 files stay tier 1", () => {
    const r = classifyChange([
      "config/agents/executor.md",
      "config/feedback/to-skeptic.md",
    ]);
    assert.equal(r.tier, 1);
  });
});

describe("tier classifier — Tier 2 (auto-merge with holdback)", () => {
  test(".claude/skills files are tier 2", () => {
    const r = classifyChange([".claude/skills/some-skill.md"]);
    assert.equal(r.tier, 2);
  });

  test("dashboard files are tier 2", () => {
    const r = classifyChange(["dashboard/src/App.tsx"]);
    assert.equal(r.tier, 2);
  });

  test("anchor-selection.ts is tier 2 (weight tuning)", () => {
    const r = classifyChange(["src/anchor-selection.ts"]);
    assert.equal(r.tier, 2);
  });
});

describe("tier classifier — Tier 3 (operator review default)", () => {
  test("arbitrary src/ files default to tier 3", () => {
    const r = classifyChange(["src/codex-runner.ts"]);
    assert.equal(r.tier, 3);
  });

  test("test files default to tier 3", () => {
    const r = classifyChange(["test/some.test.mts"]);
    assert.equal(r.tier, 3);
  });

  test("docs default to tier 3", () => {
    const r = classifyChange(["docs/reference.md"]);
    assert.equal(r.tier, 3);
  });

  test("empty file list returns tier 3 with explanation", () => {
    const r = classifyChange([]);
    assert.equal(r.tier, 3);
    assert.match(r.reason, /no files/);
  });
});

describe("tier classifier — multi-file PRs", () => {
  test("tier 0 short-circuits regardless of other files", () => {
    const r = classifyChange([
      "config/agents/planner.md",   // tier 1
      "src/codex-runner.ts",         // tier 3
      "src/grounding.ts",            // tier 0 — wins
    ]);
    assert.equal(r.tier, 0);
    assert.match(r.reason, /grounding\.ts/);
  });

  test("mixed tier 1 + tier 3 takes the higher (tier 3)", () => {
    const r = classifyChange([
      "config/agents/planner.md",   // tier 1
      "src/codex-runner.ts",         // tier 3
    ]);
    assert.equal(r.tier, 3);
  });

  test("mixed tier 1 + tier 2 takes tier 2", () => {
    const r = classifyChange([
      "config/agents/planner.md",   // tier 1
      "dashboard/src/App.tsx",       // tier 2
    ]);
    assert.equal(r.tier, 2);
  });

  test("perFile breakdown is included for inspection", () => {
    const r = classifyChange([
      "src/grounding.ts",
      "config/agents/planner.md",
    ]);
    assert.ok(r.perFile);
    assert.equal(r.perFile!.length, 2);
    const grounding = r.perFile!.find(f => f.path === "src/grounding.ts");
    assert.equal(grounding?.tier, 0);
    assert.equal(grounding?.matched, "src/grounding.ts");
  });
});

describe("tier-classify.ts CLI wrapper", () => {
  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("npx", ["tsx", WRAPPER, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
  }

  test("non-tier-0 paths exit 0 and print JSON", () => {
    const r = runCli(["src/codex-runner.ts"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 3);
    assert.deepEqual(json.files, ["src/codex-runner.ts"]);
  });

  test("tier-0 path without --operator-approved exits 2 with diagnostic", () => {
    const r = runCli(["src/grounding.ts"]);
    assert.equal(r.code, 2);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 0);
    assert.equal(json.operatorApproved, false);
    assert.match(r.stderr, /operator-approved label required/);
  });

  test("tier-0 path WITH --operator-approved exits 0", () => {
    const r = runCli(["--operator-approved", "src/grounding.ts"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 0);
    assert.equal(json.operatorApproved, true);
  });

  test("tier-1 path without --operator-approved exits 0", () => {
    const r = runCli(["config/agents/planner.md"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 1);
  });

  test("deleted/non-existent files don't crash the wrapper", () => {
    // Simulate a `gh pr diff --name-only` line referencing a deleted file.
    const r = runCli(["src/no-such-file-deleted.ts"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 3);
  });
});
