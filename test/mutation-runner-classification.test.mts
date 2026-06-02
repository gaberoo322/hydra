/**
 * Regression tests for the killed-mutant classification transform (issue #844).
 *
 * mutation.ts used to rely on `execFileAsync` THROWING to mean "the tests
 * failed under this mutation → killed mutant". After issue #844 the per-mutant
 * test exec routes through `execWithGroupCleanup`, which NEVER throws — it
 * resolves with a result object. The classification rule therefore changed:
 *
 *   survived  ===  (exitCode === 0 && !timedOut)
 *   killed    ===  anything else (non-zero exit, signal, or timeout)
 *
 * A timed-out mutant must STAY classified as "killed" (the desired signal) —
 * but now its process group is reaped instead of leaking tsx/vitest
 * grandchildren. These tests pin both halves of that contract through the
 * live `runMutationTests` path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMutationTests } from "../src/mutation.ts";

/**
 * Build a throwaway "project" with a single source file containing a line the
 * mutators will mutate (`return true;`), plus a package.json so appDir
 * resolution succeeds. The `testCommand` is supplied by the caller so each
 * test controls pass/fail/timeout behaviour.
 */
function makeProject(): { dir: string; srcFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "mutation-classify-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  const srcFile = join(dir, "target.ts");
  // A `return true;` line is mutated to `return false;` by negate-boolean-return.
  writeFileSync(
    srcFile,
    ["export function f() {", "  return true;", "}", ""].join("\n"),
  );
  return { dir, srcFile };
}

describe("runMutationTests — killed-mutant classification (issue #844)", () => {
  test("non-zero exit under the mutation classifies the mutant as KILLED", async () => {
    const { dir, srcFile } = makeProject();
    try {
      const report = await runMutationTests(dir, [srcFile], {
        // Tests "fail" deterministically → mutant killed (good coverage).
        testCommand: "/bin/sh -c 'exit 1'",
        timeBudgetMs: 30_000,
      });
      assert.ok(report.totalMutants >= 1, "expected at least one mutant");
      assert.equal(report.survived, 0, "a failing test run must KILL the mutant");
      assert.equal(report.killed, report.totalMutants);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exit 0 (no timeout) under the mutation classifies the mutant as SURVIVED", async () => {
    const { dir, srcFile } = makeProject();
    try {
      const report = await runMutationTests(dir, [srcFile], {
        // Tests "pass" → the mutation was NOT caught → survived (bad coverage).
        testCommand: "/bin/sh -c 'exit 0'",
        timeBudgetMs: 30_000,
      });
      assert.ok(report.totalMutants >= 1, "expected at least one mutant");
      assert.equal(report.survived, report.totalMutants);
      assert.equal(report.killed, 0, "a passing test run must NOT kill the mutant");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "a killed mutant whose test backgrounded a grandchild leaves nothing alive (group reaped, #844)",
    async () => {
      // We can't shorten the 45s per-mutant timeout via opts, so rather than
      // wait for a real timeout we drive the killed path with a fast non-zero
      // exit AND a backgrounded grandchild in the same process group. Because
      // execWithGroupCleanup spawns the test command detached as a group
      // leader, the grandchild must not survive past the run. This is the
      // same leak shape issue #226/#844 fixes, exercised through the live
      // mutation runner.
      const { dir, srcFile } = makeProject();
      const pidFile = join(dir, "pids");
      const script = join(dir, "leaker.sh");
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "echo $$ >> " + JSON.stringify(pidFile),
          // Background a short-lived grandchild in this group, record its PID,
          // then exit non-zero promptly so the mutant is classified KILLED.
          "sleep 2 &",
          "echo $! >> " + JSON.stringify(pidFile),
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        const report = await runMutationTests(dir, [srcFile], {
          testCommand: `/bin/bash ${script}`,
          timeBudgetMs: 30_000,
        });
        assert.ok(report.totalMutants >= 1);
        assert.equal(
          report.survived,
          0,
          "non-zero exit must classify the mutant as killed",
        );
        assert.equal(report.killed, report.totalMutants);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
