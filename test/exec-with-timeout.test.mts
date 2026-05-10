/**
 * Regression tests for src/exec-with-timeout.ts.
 *
 * Each test in this file corresponds to a real bug:
 *
 *   - Issue #226: `execFileAsync({ shell: true, timeout })` only signalled
 *     the immediate `/bin/sh -c <cmd>` child when the timeout fired. tsx,
 *     npm, node, and esbuild grandchildren survived and accumulated as
 *     stale process trees. Two such trees (9 procs total) were discovered
 *     leaked from days-old autopilot cycles.
 *
 * If any of these fail, the orchestrator will silently leak resources
 * whenever any test/build hangs — which happens routinely in autopilot
 * loops.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execWithGroupCleanup } from "../src/exec-with-timeout.ts";

const execFileAsync = promisify(execFile);

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Create a tmp dir for fixture scripts. Caller is responsible for cleanup. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "exec-timeout-"));
}

/** Spawn a bash command, capture all PIDs in /tmp/<marker> via the script,
 *  and verify they are all dead after the helper returns.
 *  Returns true if all PIDs are gone, false otherwise.
 */
async function pidsDead(pids: number[]): Promise<boolean> {
  for (const pid of pids) {
    try {
      // signal 0 = existence check
      process.kill(pid, 0);
      return false; // still alive
    } catch (err: any) {
      if (err.code !== "ESRCH") {
        // EPERM means the proc is alive but unreachable — treat as alive.
        if (err.code === "EPERM") return false;
        throw err;
      }
      // ESRCH = dead, good
    }
  }
  return true;
}

async function readPidFile(path: string): Promise<number[]> {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseInt(l, 10))
    .filter((n) => Number.isFinite(n));
}

/** Wait until a predicate returns true or timeout. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return predicate();
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe("execWithGroupCleanup", () => {
  test("returns stdout/stderr/exitCode for a successful command", async () => {
    const result = await execWithGroupCleanup("echo", ["hello"], {
      timeout: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /hello/);
    assert.equal(result.signal, null);
  });

  test("returns non-zero exitCode without throwing on command failure", async () => {
    const result = await execWithGroupCleanup(
      "/bin/sh",
      ["-c", "exit 7"],
      { timeout: 5000 },
    );
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  });

  test("captures stdout in shell:true mode (parity with execFile)", async () => {
    const result = await execWithGroupCleanup(
      "echo",
      ["world"],
      { timeout: 5000, shell: true },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /world/);
  });

  test("flags timedOut and returns within reasonable time", async () => {
    const start = Date.now();
    const result = await execWithGroupCleanup(
      "sleep",
      ["10"],
      { timeout: 200, killGraceMs: 200 },
    );
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, true);
    // Should complete well before the 10s sleep — kill flow is bounded by
    // timeout + killGraceMs + a small overhead.
    assert.ok(
      elapsed < 2000,
      `expected timeout to abort quickly, took ${elapsed}ms`,
    );
  });

  test("ENOENT (missing binary) yields exitCode -1 without throwing", async () => {
    const result = await execWithGroupCleanup(
      "this-command-does-not-exist-xyz",
      [],
      { timeout: 1000 },
    );
    assert.equal(result.exitCode, -1);
    assert.match(result.stderr, /ENOENT|not found|spawn/i);
  });

  test(
    "REGRESSION (issue #226): timeout kills grandchild processes, not just the immediate shell child",
    async () => {
      // Reproduce the exact pattern from issue #226: a parent shell that
      // backgrounds a long-running grandchild (mimicking esbuild --service
      // --ping) and exits early, AND a child that ignores SIGTERM but whose
      // group leader gets the signal — so the grandchild dies via group kill.
      //
      // We do NOT trust the parent shell to forward signals. The whole
      // point of this fix is that the orchestrator kills the entire group.
      const tmp = makeTmpDir();
      const pidFile = join(tmp, "pids");
      const script = join(tmp, "leaker.sh");

      // Script:
      //  - spawn a sleeper grandchild via `(sleep 30 &)` subshell — its
      //    parent immediately exits, so the grandchild becomes a child of
      //    init/systemd from the *process* point of view, but it stays in
      //    the same process *group* as our top-level shell. Killing the
      //    group via -PGID will reap it; killing only the shell will not.
      //  - record PIDs to a file the test can read.
      //  - sleep forever in the foreground so the helper has to time out.
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "set -e",
          "# Background a grandchild that outlives this script's foreground.",
          "(",
          "  sleep 30 &",
          "  echo $! >> " + JSON.stringify(pidFile),
          "  wait",
          ") &",
          "BG=$!",
          "echo $$ >> " + JSON.stringify(pidFile),
          "echo $BG >> " + JSON.stringify(pidFile),
          "# Block forever to force the timeout path.",
          "sleep 60",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const result = await execWithGroupCleanup(
          "/bin/bash",
          [script],
          { timeout: 800, killGraceMs: 800 },
        );

        assert.equal(
          result.timedOut,
          true,
          "expected timedOut flag to be set",
        );

        // Wait briefly for SIGKILL escalation + reaping. The process group
        // teardown is asynchronous from the helper's POV — give it up to
        // 3s for SIGKILL + kernel cleanup.
        const pids = await readPidFile(pidFile);
        assert.ok(pids.length >= 2, `expected >=2 PIDs recorded, got ${pids.length}`);

        const allDead = await waitFor(() => pidsDead(pids), 3000);
        if (!allDead) {
          // Diagnostic: show which PIDs are still alive.
          const stillAlive: number[] = [];
          for (const pid of pids) {
            try {
              process.kill(pid, 0);
              stillAlive.push(pid);
            } catch {
              /* dead */
            }
          }
          assert.fail(
            `Issue #226 regression: process group leak — PIDs still alive after timeout: ${stillAlive.join(",")}. The whole group must die when the helper times out.`,
          );
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  test(
    "REGRESSION (issue #226): grandchild that ignores SIGTERM is still SIGKILLed via group escalation",
    async () => {
      // A child that traps SIGTERM and refuses to exit must still die when
      // the kill-grace timer fires SIGKILL on the group. This guards the
      // 5s grace path explicitly.
      const tmp = makeTmpDir();
      const pidFile = join(tmp, "pids");
      const script = join(tmp, "stubborn.sh");
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "trap '' TERM",
          "echo $$ >> " + JSON.stringify(pidFile),
          "# Spawn a grandchild that also ignores SIGTERM",
          "(",
          "  trap '' TERM",
          "  echo $$ >> " + JSON.stringify(pidFile),
          "  sleep 60",
          ") &",
          "wait",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const result = await execWithGroupCleanup(
          "/bin/bash",
          [script],
          { timeout: 400, killGraceMs: 400 },
        );
        assert.equal(result.timedOut, true);

        const pids = await readPidFile(pidFile);
        assert.ok(pids.length >= 2);

        const allDead = await waitFor(() => pidsDead(pids), 3000);
        assert.equal(
          allDead,
          true,
          "SIGKILL escalation failed — at least one PID survived the grace window",
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  test("respects maxBuffer on stdout (large output is truncated, not dropped)", async () => {
    // Generate ~32KB of output and cap maxBuffer at 1KB. Should still
    // resolve cleanly with truncation hint.
    const result = await execWithGroupCleanup(
      "/bin/sh",
      ["-c", "yes hi | head -c 32768"],
      { timeout: 5000, maxBuffer: 1024 },
    );
    assert.equal(result.exitCode, 0);
    // Body + truncation hint together
    assert.match(result.stdout, /truncated at maxBuffer=1024/);
    assert.ok(
      result.stdout.length < 1024 + 200,
      `truncated stdout should be near maxBuffer, got ${result.stdout.length} bytes`,
    );
  });

  test("durationMs reflects wall-clock time", async () => {
    const result = await execWithGroupCleanup(
      "/bin/sh",
      ["-c", "sleep 0.2"],
      { timeout: 5000 },
    );
    assert.ok(
      result.durationMs >= 150 && result.durationMs < 5000,
      `expected ~200ms duration, got ${result.durationMs}`,
    );
  });
});

// -------------------------------------------------------------------------
// reaper script — defense in depth
// -------------------------------------------------------------------------
describe("scripts/reap-stale-test-procs.sh", () => {
  test("script exists and is executable", async () => {
    const path = join(process.cwd(), "scripts/reap-stale-test-procs.sh");
    const { stat } = await import("node:fs/promises");
    const s = await stat(path);
    assert.ok(s.isFile(), "reaper script should exist");
    // executable bit for owner
    assert.ok((s.mode & 0o100) !== 0, "reaper script should be executable");
  });

  test("script accepts --dry-run and exits 0 without killing anything", async () => {
    const path = join(process.cwd(), "scripts/reap-stale-test-procs.sh");
    const { stdout, stderr } = await execFileAsync(path, ["--dry-run"], {
      timeout: 10_000,
    });
    // It must not throw; we just check it ran. Output content is
    // best-effort because the host machine state varies.
    assert.ok(stdout !== undefined || stderr !== undefined);
  });

  test("script reports help with --help", async () => {
    const path = join(process.cwd(), "scripts/reap-stale-test-procs.sh");
    const { stdout } = await execFileAsync(path, ["--help"], {
      timeout: 5000,
    });
    assert.match(stdout, /reap|stale|tsx|esbuild/i);
  });
});
