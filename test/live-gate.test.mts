/**
 * Regression tests for the Live-Gate Invariant (issue #738, ADR-0015
 * §live-gate invariant) — `scripts/ci/live-gate.sh`.
 *
 * The invariant: when a PR touches a Verifier Core file, CI classifies it
 * with the BASE-ref (currently-deployed / master) copy of the classifier
 * scripts, never the PR-head copy. This closes the circularity hole — a PR
 * could otherwise ship a neutered classifier on its head (e.g. one whose
 * isVerifierCore always returns false) and thereby verify its own
 * admission. The base-ref classifier — which still works — does the
 * classifying, so a self-weakening gate is still caught and blocked.
 *
 * These tests drive the BRANCHING (which classifier wins) using scratch git
 * fixtures — a "base" commit with the correct verifier scripts and a "head"
 * checkout that may be neutered — rather than spinning up a real GitHub PR.
 * This mirrors how grounding tests exercise pure functions instead of
 * running real CI. No Redis, no network.
 *
 * The script's contract (see scripts/ci/live-gate.sh header):
 *   live-gate.sh <base-ref> <operator-approved:true|false> <changed-files-file>
 * Output: tier-classify JSON on stdout. Exit codes:
 *   0  non-T4, or T4 with operator-approved
 *   2  T4 without operator-approved (CI must fail)
 *   1  usage / unexpected error
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LIVE_GATE = resolve(REPO_ROOT, "scripts/ci/live-gate.sh");

/** The three import-closed verifier scripts, copied into each fixture repo. */
const VERIFIER_SCRIPTS = [
  ["src", "untouchable.ts"],
  ["src", "tier-classifier.ts"],
  ["scripts", "tier-classify.ts"],
] as const;

/** A deliberately-neutered untouchable.ts whose gate "always passes". */
const NEUTERED_UNTOUCHABLE = `
export const VERIFIER_CORE_PATHS: readonly string[] = Object.freeze([]);
export function isVerifierCore(_path: string): boolean { return false; }
export function matchVerifierCore(_path: string): string | null { return null; }
`;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
}

/**
 * Build a scratch git repo. The first commit ("base") holds the CORRECT
 * verifier scripts copied from this repo. If `neuter` is true a second
 * commit replaces untouchable.ts with a gate that always returns false —
 * simulating a malicious PR that weakened the classifier on its head.
 * Returns { dir, baseRef }.
 */
function makeFixture(opts: { neuter: boolean }): { dir: string; baseRef: string } {
  const dir = mkdtempSync(join(tmpdir(), "hydra-live-gate-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@hydra.local");
  git(dir, "config", "user.name", "hydra-test");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  for (const [d, f] of VERIFIER_SCRIPTS) {
    copyFileSync(resolve(REPO_ROOT, d, f), join(dir, d, f));
  }
  // The script under test runs from the workspace; copy it in so the fixture
  // is self-contained and we invoke it with cwd=dir.
  copyFileSync(LIVE_GATE, join(dir, "scripts", "ci", "live-gate.sh"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base: correct verifier scripts");
  const baseRef = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).stdout.trim();

  if (opts.neuter) {
    writeFileSync(join(dir, "src", "untouchable.ts"), NEUTERED_UNTOUCHABLE);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head: NEUTER the gate (isVerifierCore -> false)");
  }
  return { dir, baseRef };
}

/**
 * Run live-gate.sh in `dir`. `tsx` resolves from this repo's node_modules,
 * so we point npm at it via cwd + an explicit node_modules on PATH is not
 * needed (npx tsx resolves the global/workspace install the same way CI
 * does). We invoke with cwd=dir so the HEAD-ref branch reads the fixture's
 * own scripts/tier-classify.ts (the neutered head, when present).
 */
function runLiveGate(
  dir: string,
  baseRef: string,
  operatorApproved: boolean,
  changedFiles: string[],
): { status: number; stdout: string; stderr: string } {
  const cfFile = join(dir, "changed-files.txt");
  writeFileSync(cfFile, changedFiles.join("\n") + "\n");
  const r = spawnSync(
    "bash",
    [join(dir, "scripts", "ci", "live-gate.sh"), baseRef, String(operatorApproved), cfFile],
    { cwd: dir, encoding: "utf-8" },
  );
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("Live-Gate Invariant — base-ref classifies Verifier Core PRs", () => {
  const fixtures: string[] = [];
  after(() => {
    for (const d of fixtures) rmSync(d, { recursive: true, force: true });
  });

  test("Verifier Core PR with a NEUTERED head is still caught as T4 and blocked", () => {
    // The core security property. The head's classifier says "nothing is
    // Verifier Core"; the base-ref classifier (correct) says ci.yml is T4.
    // The base-ref verdict must win: T4, no operator-approved -> exit 2.
    const { dir, baseRef } = makeFixture({ neuter: true });
    fixtures.push(dir);
    const { status, stdout, stderr } = runLiveGate(
      dir,
      baseRef,
      false,
      [".github/workflows/ci.yml"],
    );
    const result = JSON.parse(stdout);
    assert.equal(result.tier, 4, "base-ref classifier must classify ci.yml as T4");
    assert.equal(status, 2, "T4 without operator-approved must exit 2 (CI fails)");
    assert.match(
      stderr,
      /BASE-ref/,
      "diagnostic must record that the base-ref classifier was used",
    );
  });

  test("Verifier Core PR with neutered head + operator-approved is T4 but passes (exit 0)", () => {
    const { dir, baseRef } = makeFixture({ neuter: true });
    fixtures.push(dir);
    const { status, stdout } = runLiveGate(dir, baseRef, true, [
      ".github/workflows/ci.yml",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.tier, 4);
    assert.equal(status, 0, "operator-approved unblocks the T4 verdict");
    assert.equal(result.operatorApproved, true);
  });

  test("Verifier Core PR (un-neutered) classifies T4 from base-ref", () => {
    const { dir, baseRef } = makeFixture({ neuter: false });
    fixtures.push(dir);
    const { status, stdout, stderr } = runLiveGate(dir, baseRef, false, [
      "src/untouchable.ts",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.tier, 4);
    assert.equal(status, 2);
    assert.match(stderr, /BASE-ref/);
  });

  test("non-Verifier-Core PR uses the HEAD-ref classifier (unchanged path)", () => {
    // The common case: no Verifier Core file in the diff. The head-ref
    // classifier runs exactly as today; a plain src change is T3, exit 0.
    const { dir, baseRef } = makeFixture({ neuter: false });
    fixtures.push(dir);
    const { status, stdout, stderr } = runLiveGate(dir, baseRef, false, [
      "src/api.ts",
      "src/foo.ts",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.tier, 3, "plain src change is T3");
    assert.equal(status, 0);
    assert.match(
      stderr,
      /HEAD-ref/,
      "non-Verifier PR must use the head-ref classifier path",
    );
  });

  test("the Verifier Core decision uses the BASE-ref isVerifierCore, not the head's", () => {
    // Even though the HEAD has neutered isVerifierCore (would say "no
    // Verifier Core file"), the script must still take the BASE-ref branch
    // for ci.yml — proving the "is this a Verifier Core PR?" decision is
    // sourced from base, so a PR cannot dodge base-ref treatment by removing
    // its own path on the head.
    const { dir, baseRef } = makeFixture({ neuter: true });
    fixtures.push(dir);
    const { stderr } = runLiveGate(dir, baseRef, false, [
      ".github/workflows/ci.yml",
    ]);
    assert.match(
      stderr,
      /Verifier Core file in diff -> classifying with BASE-ref/,
      "the base-ref isVerifierCore must drive the branch, not the neutered head",
    );
  });

  test("usage error (wrong arg count) exits 1", () => {
    const { dir } = makeFixture({ neuter: false });
    fixtures.push(dir);
    const r = spawnSync("bash", [join(dir, "scripts", "ci", "live-gate.sh"), "only-one-arg"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage:/);
  });
});
