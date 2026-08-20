/**
 * test/target-build-anchor-preflight.test.mts — issue #4167: the
 * `hydra-target-build` Step 2.1 shipped-anchor preflight fired on 90% of the
 * live Target board (a union-of-100-commits vocabulary bag saturates
 * regardless of window size) and its positive-verdict branch called
 * `gh issue close --reason completed`, so a false positive silently closed
 * live board work as "completed".
 *
 * The fix has two parts, both in
 * `docs/operator-playbooks/_fragments/hydra-target-build-anchor-preflight.md`
 * (the source fragment `scripts/sync-skills.sh` compiles into the
 * `hydra-target-build` skill — this test extracts and runs the ACTUAL
 * committed bash block, mirroring the extract-and-run discipline of
 * `test/board-state.test.mts`, so any drift in the fragment is caught here):
 *
 *  1. The destructive `gh issue close` branch is DELETED, not gated tighter —
 *     a positive verdict now only clears the `in-progress` claim label and
 *     falls through to the next candidate.
 *  2. The subject-coverage score is computed PER COMMIT (max across the
 *     window), never against a pooled union of all commits' words.
 *
 * Both are design-concept invariants stated with MUST NOT / MUST NEVER
 * language (issue #4118: a prohibition can only be discharged by naming a
 * test), which is why this file exists rather than a `file-contains` /
 * `occurrences` static check — a substring count cannot prove the destructive
 * branch is unreachable, only that its literal text is absent.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FRAGMENT = join(
  REPO_ROOT,
  "docs",
  "operator-playbooks",
  "_fragments",
  "hydra-target-build-anchor-preflight.md",
);

/**
 * Pull the FIRST ```bash fence out of the fragment — Step 2.1's shipped-anchor
 * preflight script. Returns the literal committed source so the test runs the
 * actual fragment, not a re-implementation (mirrors `extractPythonBlock` in
 * `test/board-state.test.mts`).
 */
function extractShippedAnchorBlock(): string {
  const src = readFileSync(FRAGMENT, "utf-8");
  const m = src.match(/```bash\n([\s\S]*?)\n```/);
  assert.ok(m, "could not locate a ```bash block in the fragment");
  const block = m[1];
  assert.ok(
    block.includes("SHIPPED_ON_MAIN=0"),
    "the first ```bash block in the fragment is no longer the shipped-anchor preflight — did Step 2.1 move?",
  );
  return block;
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  assert.equal(
    r.status,
    0,
    `${cmd} ${args.join(" ")} failed in ${cwd}: ${r.stderr}`,
  );
}

/** Fake `gh` + `hydra` on PATH that append every invocation to CALL_LOG. */
function makeStubBin(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  // Each invocation is wrapped in start/end markers on their own lines so a
  // multi-line argument (the friction-cue JSON body) doesn't get sliced into
  // fragments when the call log is later split into discrete calls.
  const stub = `#!/bin/sh\nprintf '===CALL_START===\\n%s\\n===CALL_END===\\n' "$0 $*" >> "$CALL_LOG"\nexit 0\n`;
  for (const name of ["gh", "hydra"]) {
    const path = join(binDir, name);
    writeFileSync(path, stub.replace("$0", name));
    chmodSync(path, 0o755);
  }
}

/**
 * Build a throwaway git repo at `<root>/web` with one commit per entry in
 * `commits`, then point `refs/remotes/origin/main` at HEAD (no real remote
 * needed — the preflight only ever reads `origin/main` via `git log`). An
 * empty `commits` array leaves `web` uninitialised (no `.git`), simulating
 * the unreachable-git fail-open case.
 */
function setupTargetWorktree(
  root: string,
  commits: { subject: string; body?: string }[],
): string {
  const webDir = join(root, "web");
  if (commits.length === 0) {
    mkdirSync(webDir, { recursive: true });
    return root;
  }
  mkdirSync(webDir, { recursive: true });
  run("git", ["init", "-q"], webDir);
  run("git", ["config", "user.email", "test@example.com"], webDir);
  run("git", ["config", "user.name", "Test"], webDir);
  commits.forEach((c, i) => {
    writeFileSync(join(webDir, "f.txt"), String(i));
    run("git", ["add", "f.txt"], webDir);
    const args = ["commit", "-q", "-m", c.subject];
    if (c.body) args.push("-m", c.body);
    run("git", args, webDir);
  });
  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], webDir);
  return root;
}

interface PreflightResult {
  shippedOnMain: string | undefined;
  stdout: string;
  stderr: string;
  status: number | null;
  callLog: string[];
}

function runPreflight(opts: {
  anchorNum?: string;
  anchorSubject?: string;
  targetWt: string;
}): PreflightResult {
  const block = extractShippedAnchorBlock();
  const workDir = mkdtempSync(join(tmpdir(), "shipped-anchor-preflight-"));
  try {
    const binDir = join(workDir, "bin");
    makeStubBin(binDir);
    const callLogPath = join(workDir, "calls.log");
    writeFileSync(callLogPath, "");
    const script = `${block}\nprintf 'SHIPPED_ON_MAIN_RESULT=%s\\n' "\${SHIPPED_ON_MAIN:-}"\n`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CALL_LOG: callLogPath,
      TARGET_WT: opts.targetWt,
      CYCLE_ID: "test-cycle",
    };
    delete env.ANCHOR_NUM;
    delete env.ANCHOR_SUBJECT;
    if (opts.anchorNum !== undefined) env.ANCHOR_NUM = opts.anchorNum;
    if (opts.anchorSubject !== undefined)
      env.ANCHOR_SUBJECT = opts.anchorSubject;

    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env });
    // Split on the start/end markers so a multi-line argument (the
    // friction-cue JSON body) stays intact as ONE call-log entry.
    const callLog = readFileSync(callLogPath, "utf-8")
      .split("===CALL_START===\n")
      .map((s) => s.replace(/\n===CALL_END===\n?$/, ""))
      .filter(Boolean);
    const m = r.stdout.match(/SHIPPED_ON_MAIN_RESULT=(\S*)/);
    return {
      shippedOnMain: m ? m[1] : undefined,
      stdout: r.stdout,
      stderr: r.stderr,
      status: r.status,
      callLog,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

describe("shipped-anchor preflight (issue #4167)", () => {
  test("never calls gh issue close on a positive verdict — a single commit clearing 0.70 skips, not closes", () => {
    const workDir = mkdtempSync(join(tmpdir(), "shipped-anchor-fixture-"));
    try {
      const targetWt = setupTargetWorktree(workDir, [
        { subject: "Fix payment retry deadlock in worker pool" }, // payment, retry, deadlock = 3/4 sig words
      ]);
      const result = runPreflight({
        anchorNum: "9001",
        anchorSubject: "payment retry deadlock handler",
        targetWt,
      });

      assert.equal(
        result.shippedOnMain,
        "1",
        `expected a positive verdict; stderr: ${result.stderr}`,
      );
      assert.ok(
        !result.callLog.some((line) => line.includes("issue close")),
        `gh issue close must NEVER be called on a positive verdict; calls were:\n${result.callLog.join("\n")}`,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("retains the in-progress claim-clear and the friction-cue POST on a positive verdict", () => {
    const workDir = mkdtempSync(join(tmpdir(), "shipped-anchor-fixture-"));
    try {
      const targetWt = setupTargetWorktree(workDir, [
        { subject: "Fix payment retry deadlock in worker pool" },
      ]);
      const result = runPreflight({
        anchorNum: "9001",
        anchorSubject: "payment retry deadlock handler",
        targetWt,
      });

      assert.equal(result.shippedOnMain, "1");
      assert.ok(
        result.callLog.some(
          (line) =>
            line.includes("gh issue edit") &&
            line.includes("9001") &&
            line.includes("--remove-label in-progress"),
        ),
        `expected the in-progress claim-clear; calls were:\n${result.callLog.join("\n")}`,
      );
      assert.ok(
        result.callLog.some(
          (line) =>
            line.includes("hydra raw POST /memory/subagent-friction") &&
            line.includes("target-build-anchor-already-shipped-on-main"),
        ),
        `expected the friction-cue POST; calls were:\n${result.callLog.join("\n")}`,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("requires per-commit coverage — a union of commits that only jointly cover 100% of the subject must not trigger", () => {
    const workDir = mkdtempSync(join(tmpdir(), "shipped-anchor-fixture-"));
    try {
      // Anchor subject sig words: payment, retry, deadlock, handler (4).
      // Each commit below covers only 2/4 (50%, below 0.70) individually, but
      // their UNION covers all 4/4 (100%) — exactly the saturation bug #4167
      // fixes. Old union-bag scoring would have scored this 100% and fired;
      // per-commit scoring must not.
      const targetWt = setupTargetWorktree(workDir, [
        { subject: "Add payment retry improvements" }, // payment, retry
        { subject: "Deadlock handler cleanup pass" }, // deadlock, handler
      ]);
      const result = runPreflight({
        anchorNum: "9002",
        anchorSubject: "payment retry deadlock handler",
        targetWt,
      });

      assert.equal(
        result.shippedOnMain,
        "0",
        `union-of-commits vocabulary must not trigger a positive verdict; stderr: ${result.stderr}`,
      );
      assert.deepEqual(
        result.callLog,
        [],
        `no gh/hydra call should fire on a negative verdict; calls were:\n${result.callLog.join("\n")}`,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("the 0.70 threshold is unchanged — a single commit at exactly 3/4 words still fires once per-commit scoring is applied", () => {
    const workDir = mkdtempSync(join(tmpdir(), "shipped-anchor-fixture-"));
    try {
      // Same fixture as the union test above, PLUS one more commit that on
      // its own clears 3/4 = 75% >= 0.70. Confirms the fix is the denominator
      // (union → per-commit), not the threshold (still 0.70).
      const targetWt = setupTargetWorktree(workDir, [
        { subject: "Add payment retry improvements" },
        { subject: "Deadlock handler cleanup pass" },
        { subject: "Hotfix payment retry deadlock crash" }, // payment, retry, deadlock = 3/4
      ]);
      const result = runPreflight({
        anchorNum: "9003",
        anchorSubject: "payment retry deadlock handler",
        targetWt,
      });

      assert.equal(
        result.shippedOnMain,
        "1",
        `a single commit at 75% coverage should still clear the unchanged 0.70 threshold; stderr: ${result.stderr}`,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("fails open when the anchor subject has fewer than 4 significant words", () => {
    const workDir = mkdtempSync(join(tmpdir(), "shipped-anchor-fixture-"));
    try {
      // Only "tests" (>3 chars) qualifies as significant here — "fix" (3
      // chars) is excluded by the length>3 guard — so SIG_COUNT stays below
      // 4 even though a commit exists that would otherwise match perfectly.
      const targetWt = setupTargetWorktree(workDir, [
        { subject: "fix tests" },
      ]);
      const result = runPreflight({
        anchorNum: "9004",
        anchorSubject: "fix tests",
        targetWt,
      });

      assert.equal(result.shippedOnMain, "0");
      assert.deepEqual(result.callLog, []);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("fails open when origin/main is unreachable (no git repo at $TARGET_WT/web)", () => {
    const workDir = mkdtempSync(join(tmpdir(), "shipped-anchor-fixture-"));
    try {
      const targetWt = setupTargetWorktree(workDir, []); // no .git at all
      const result = runPreflight({
        anchorNum: "9005",
        anchorSubject: "payment retry deadlock handler",
        targetWt,
      });

      assert.equal(result.shippedOnMain, "0");
      assert.deepEqual(result.callLog, []);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
