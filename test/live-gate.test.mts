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
 *   live-gate.sh <base-ref> <changed-files-file>
 * Output: tier-classify JSON on stdout. Exit codes:
 *   0  any valid classification (ADR-0020 Slice 2 / #743: the gate reports the
 *      tier; it no longer blocks T4 on the operator-approved label)
 *   1  usage / unexpected error
 *
 * The base-ref Live-Gate mechanism itself is UNCHANGED — a neutered head still
 * gets classified by the base-ref scripts. Only the operator-approved policy
 * (the old exit-2 path) was removed.
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
  changedFiles: string[],
): { status: number; stdout: string; stderr: string } {
  const cfFile = join(dir, "changed-files.txt");
  writeFileSync(cfFile, changedFiles.join("\n") + "\n");
  const r = spawnSync(
    "bash",
    [join(dir, "scripts", "ci", "live-gate.sh"), baseRef, cfFile],
    { cwd: dir, encoding: "utf-8" },
  );
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("Live-Gate Invariant — base-ref classifies Verifier Core PRs", () => {
  const fixtures: string[] = [];
  after(() => {
    for (const d of fixtures) rmSync(d, { recursive: true, force: true });
  });

  test("Verifier Core PR with a NEUTERED head is still classified T4 by the base-ref scripts", () => {
    // The core security property is unchanged: the head's classifier says
    // "nothing is Verifier Core"; the base-ref classifier (correct) says
    // ci.yml is T4. The base-ref verdict must win. Post-#743 the gate reports
    // the tier and exits 0 (the operator-approved exit-2 path is gone — the
    // T4 depth backstop relocated to the base-ref deep-qa-gate required check).
    const { dir, baseRef } = makeFixture({ neuter: true });
    fixtures.push(dir);
    const { status, stdout, stderr } = runLiveGate(
      dir,
      baseRef,
      [".github/workflows/ci.yml"],
    );
    const result = JSON.parse(stdout);
    assert.equal(result.tier, 4, "base-ref classifier must classify ci.yml as T4");
    assert.equal(status, 0, "T4 no longer fails the gate on a missing label (#743)");
    assert.match(
      stderr,
      /BASE-ref/,
      "diagnostic must record that the base-ref classifier was used",
    );
  });

  test("a T4 file list WITHOUT --operator-approved no longer fails the gate (exit 0)", () => {
    // ADR-0020 Slice 2 / #743 regression guard: the old contract failed a T4
    // PR (exit 2) unless the operator-approved label was passed. That block is
    // removed — a Verifier Core diff classifies T4 and exits 0.
    const { dir, baseRef } = makeFixture({ neuter: false });
    fixtures.push(dir);
    const { status, stdout, stderr } = runLiveGate(dir, baseRef, [
      "src/untouchable.ts",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.tier, 4);
    assert.equal(status, 0, "T4 without operator-approved must exit 0 post-#743");
    assert.match(stderr, /BASE-ref/);
  });

  test("non-Verifier-Core PR uses the HEAD-ref classifier (unchanged path)", () => {
    // The common case: no Verifier Core file in the diff. The head-ref
    // classifier runs exactly as today; a plain src change is T3, exit 0.
    const { dir, baseRef } = makeFixture({ neuter: false });
    fixtures.push(dir);
    const { status, stdout, stderr } = runLiveGate(dir, baseRef, [
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
    const { stderr } = runLiveGate(dir, baseRef, [
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
