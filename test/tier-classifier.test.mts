/**
 * Regression tests for the modification-tier classifier (issue #243,
 * ADR-0001 + ADR-0004 + ADR-0015 work-order step 3).
 *
 * Bug we're preventing: Hydra agents merging changes to the verification
 * machinery (the tier classifier, the CI workflows, the tier-classify CLI,
 * the protected-paths list) without operator review. This happened in the
 * 2026-05-10 sweep when `gh pr merge --admin` was used to bypass GitHub's
 * self-approval rule. The tier classifier + `tier-gate` CI job is the
 * structural fix: any PR touching a T4 (Verifier Core) path fails CI
 * unless the `operator-approved` label is applied.
 *
 * Numbering note (ADR-0015 / issue #737): tiers are the monotonic ladder
 * T1 (shallowest) → T4 (deepest). The deepest tier — Verifier Core —
 * carries the operator-approved gate (renumbered from the old Tier-0).
 * The Verifier Core shrank to its 5 self-referential files; the six former
 * members (`src/grounding.ts`, `src/cost/`, the watchdogs, `scripts/deploy.sh`)
 * now classify as T3.
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
  VERIFIER_CORE_PATHS,
} from "../src/tier-classifier.ts";
import { isVerifierCore, matchVerifierCore } from "../src/untouchable.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WRAPPER = resolve(REPO_ROOT, "scripts/tier-classify.ts");

describe("tier classifier — T4 (Verifier Core, deepest)", () => {
  test("the 5 Verifier Core paths classify as T4", () => {
    const expected = [
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
      "scripts/tier-classify.ts",
      "src/tier-classifier.ts",
      "src/untouchable.ts",
    ];
    assert.deepEqual([...VERIFIER_CORE_PATHS].sort(), [...expected].sort());
    for (const p of VERIFIER_CORE_PATHS) {
      const r = classifyChange([p]);
      assert.equal(r.tier, 4, `${p} should be T4`);
      assert.match(r.reason, /Verifier Core/);
    }
  });

  test("isVerifierCore returns true for the 5 protected paths, false otherwise", () => {
    assert.equal(isVerifierCore(".github/workflows/ci.yml"), true);
    assert.equal(isVerifierCore(".github/workflows/deploy.yml"), true);
    assert.equal(isVerifierCore("scripts/tier-classify.ts"), true);
    assert.equal(isVerifierCore("src/tier-classifier.ts"), true);
    assert.equal(isVerifierCore("src/untouchable.ts"), true);

    // The six former-Tier-0 paths are demoted to T3 (NOT Verifier Core).
    assert.equal(isVerifierCore("src/grounding.ts"), false);
    assert.equal(isVerifierCore("src/cost/surrogate.ts"), false);
    assert.equal(isVerifierCore("src/cost/usage-tracker.ts"), false);
    assert.equal(isVerifierCore("scripts/deploy.sh"), false);
    assert.equal(isVerifierCore("scripts/hydra-watchdog.sh"), false);
    assert.equal(isVerifierCore("scripts/hydra-orchestrator-watchdog.sh"), false);
    assert.equal(isVerifierCore("scripts/hydra-autopilot-watchdog.sh"), false);

    assert.equal(isVerifierCore("src/anchor-selection.ts"), false);
    assert.equal(isVerifierCore("config/agents/planner.md"), false);
    assert.equal(isVerifierCore("dashboard/src/App.tsx"), false);
    assert.equal(isVerifierCore("README.md"), false);
    assert.equal(isVerifierCore(""), false);
  });

  test("the six demoted ex-Tier-0 paths classify as T3", () => {
    for (const p of [
      "src/grounding.ts",
      "src/cost/surrogate.ts",
      "src/cost/usage-tracker.ts",
      "scripts/deploy.sh",
      "scripts/hydra-watchdog.sh",
      "scripts/hydra-orchestrator-watchdog.sh",
      "scripts/hydra-autopilot-watchdog.sh",
    ]) {
      const r = classifyChange([p]);
      assert.equal(r.tier, 3, `${p} should be T3 (demoted from Tier-0)`);
    }
  });

  test("matchVerifierCore returns the matched entry", () => {
    assert.equal(matchVerifierCore("src/tier-classifier.ts"), "src/tier-classifier.ts");
    assert.equal(matchVerifierCore("src/grounding.ts"), null);
    assert.equal(matchVerifierCore("src/anchor-selection.ts"), null);
  });

  test("the classifier protects itself (self-reference survives renumber)", () => {
    assert.equal(classifyChange(["src/untouchable.ts"]).tier, 4);
    assert.equal(classifyChange(["src/tier-classifier.ts"]).tier, 4);
    assert.equal(classifyChange(["scripts/tier-classify.ts"]).tier, 4);
  });

  test("./-prefixed paths normalize correctly", () => {
    const r = classifyChange(["./src/tier-classifier.ts"]);
    assert.equal(r.tier, 4);
  });
});

describe("tier classifier — T1 (auto-merge prompt-shaped, shallowest)", () => {
  test("config/agents files are T1", () => {
    const r = classifyChange(["config/agents/planner.md"]);
    assert.equal(r.tier, 1);
  });

  test("config/feedback files are T1", () => {
    const r = classifyChange(["config/feedback/to-planner.md"]);
    assert.equal(r.tier, 1);
  });

  test("multiple T1 files stay T1", () => {
    const r = classifyChange([
      "config/agents/executor.md",
      "config/feedback/to-skeptic.md",
    ]);
    assert.equal(r.tier, 1);
  });
});

describe("tier classifier — T2 (auto-merge with holdback)", () => {
  test(".claude/skills files are T2", () => {
    const r = classifyChange([".claude/skills/some-skill.md"]);
    assert.equal(r.tier, 2);
  });

  test("dashboard files are T2", () => {
    const r = classifyChange(["dashboard/src/App.tsx"]);
    assert.equal(r.tier, 2);
  });

  test("anchor-selection.ts is T2 (weight tuning)", () => {
    const r = classifyChange(["src/anchor-selection.ts"]);
    assert.equal(r.tier, 2);
  });
});

describe("tier classifier — T3 (operator review default)", () => {
  test("arbitrary src/ files default to T3", () => {
    const r = classifyChange(["src/codex-runner.ts"]);
    assert.equal(r.tier, 3);
  });

  test("test files default to T3", () => {
    const r = classifyChange(["test/some.test.mts"]);
    assert.equal(r.tier, 3);
  });

  test("docs default to T3", () => {
    const r = classifyChange(["docs/reference.md"]);
    assert.equal(r.tier, 3);
  });

  test("empty file list returns T3 with explanation", () => {
    const r = classifyChange([]);
    assert.equal(r.tier, 3);
    assert.match(r.reason, /no files/);
  });
});

describe("tier classifier — multi-file PRs (monotonic MAX)", () => {
  test("T4 wins regardless of other files (MAX, no short-circuit needed)", () => {
    const r = classifyChange([
      "config/agents/planner.md",   // T1
      "src/codex-runner.ts",         // T3
      "src/tier-classifier.ts",      // T4 — wins
    ]);
    assert.equal(r.tier, 4);
    assert.match(r.reason, /tier-classifier\.ts/);
  });

  test("mixed T1 + T3 takes the higher (T3)", () => {
    const r = classifyChange([
      "config/agents/planner.md",   // T1
      "src/codex-runner.ts",         // T3
    ]);
    assert.equal(r.tier, 3);
  });

  test("mixed T1 + T2 takes T2", () => {
    const r = classifyChange([
      "config/agents/planner.md",   // T1
      "dashboard/src/App.tsx",       // T2
    ]);
    assert.equal(r.tier, 2);
  });

  test("perFile breakdown is included for inspection", () => {
    const r = classifyChange([
      "src/tier-classifier.ts",
      "config/agents/planner.md",
    ]);
    assert.ok(r.perFile);
    assert.equal(r.perFile!.length, 2);
    const core = r.perFile!.find(f => f.path === "src/tier-classifier.ts");
    assert.equal(core?.tier, 4);
    assert.equal(core?.matched, "src/tier-classifier.ts");
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

  test("non-T4 paths exit 0 and print JSON", () => {
    const r = runCli(["src/codex-runner.ts"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 3);
    assert.deepEqual(json.files, ["src/codex-runner.ts"]);
  });

  test("T4 path without --operator-approved exits 2 with diagnostic", () => {
    const r = runCli(["src/tier-classifier.ts"]);
    assert.equal(r.code, 2);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 4);
    assert.equal(json.operatorApproved, false);
    assert.match(r.stderr, /operator-approved label required/);
  });

  test("T4 path WITH --operator-approved exits 0", () => {
    const r = runCli(["--operator-approved", "src/tier-classifier.ts"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 4);
    assert.equal(json.operatorApproved, true);
  });

  test("demoted ex-Tier-0 path (grounding.ts) now exits 0 as T3 without label", () => {
    const r = runCli(["src/grounding.ts"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.tier, 3);
  });

  test("T1 path without --operator-approved exits 0", () => {
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
