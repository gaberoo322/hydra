/**
 * test/claude-cli-exec.test.mts — pin `runClaudeCli`'s timeout behaviour
 * (`src/claude-cli/exec.ts`), issue #4379.
 *
 * Before this fix, a timeout on `runClaudeCli` only `SIGKILL`ed the direct
 * `claude` child — any subprocess tree it spawned (e.g. an MCP server) leaked
 * past the timeout. The fix ports the `detached: true` + negative-pid
 * process-group kill pattern already proven in `src/exec-with-timeout.ts`
 * (see `test/exec-with-timeout.test.mts`'s issue #226 regressions), WITHOUT
 * delegating to `execWithGroupCleanup` — that helper hard-imports `spawn`
 * with no injection seam, which would launch a real `claude` process from
 * every test here, and it never rejects, breaking the reject-on-timeout
 * message this seam's callers (`src/glm/drainer-runner.ts`) pin by regex.
 *
 * Every mock-child case here drives the injected `spawnImpl` seam — no live
 * `claude` process launches. The one live case at the bottom spawns `/bin/bash`
 * with a #226-shaped script, mirroring the two already-green live regressions
 * in `test/exec-with-timeout.test.mts`.
 *
 * New top-level describes with their own trivial lifecycle — no shared Redis
 * seam, so nothing here can piggyback a sibling suite's teardown timing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runClaudeCli, defaultClaudeSpawn } from "../src/claude-cli/exec.ts";

// -------------------------------------------------------------------------
// Mock-child helpers
// -------------------------------------------------------------------------

/** A mock child that emits canned stdout/stderr then closes with exitCode. */
function fakeClosingSpawn(
  pid: number | undefined,
  exitCode: number,
  captured?: { bin?: string; args?: string[]; opts?: any },
): any {
  return (bin: string, args: string[], opts: any): any => {
    if (captured) {
      captured.bin = bin;
      captured.args = args;
      captured.opts = opts;
    }
    const child: any = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.emit("close", exitCode);
    });
    return child;
  };
}

/** A mock child that never closes on its own, so the timeout path fires. */
function fakeHangingSpawn(
  pid: number | undefined,
  killSignals: string[],
  captured?: { opts?: any },
): any {
  return (bin: string, args: string[], opts: any): any => {
    if (captured) {
      captured.opts = opts;
    }
    const child: any = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig: string) => {
      killSignals.push(sig);
    };
    return child; // never emits close
  };
}

/** Monkey-patch process.kill for the duration of `fn`, recording every call. */
async function withPatchedProcessKill<T>(
  impl: (pid: number, signal?: string | number) => boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const original = process.kill;
  process.kill = impl as typeof process.kill;
  try {
    return await fn();
  } finally {
    process.kill = original;
  }
}

/** Monkey-patch console.error for the duration of `fn`, recording every call. */
async function withPatchedConsoleError<T>(
  calls: unknown[][],
  fn: () => Promise<T>,
): Promise<T> {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe("runClaudeCli — spawn options (issue #4379)", () => {
  test("spawns with detached: true alongside the unchanged stdio/env/cwd options", async () => {
    const captured: { opts?: any } = {};
    const result = await runClaudeCli(
      fakeClosingSpawn(4242, 0, captured),
      "claude",
      ["-p", "x"],
      5_000,
      { label: "claude-cli", env: { FOO: "bar" }, cwd: "/tmp/work" },
    );
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.deepEqual(captured.opts, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { FOO: "bar" },
      cwd: "/tmp/work",
      detached: true,
    });
  });
});

describe("runClaudeCli — timeout process-group cleanup (issue #4379)", () => {
  test("on timeout, a numeric child.pid sends SIGKILL to the negative process group", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    const killSignals: string[] = [];
    const spawnImpl = fakeHangingSpawn(4242, killSignals);

    await withPatchedProcessKill(
      (pid, signal) => {
        killCalls.push({ pid, signal });
        return true;
      },
      async () => {
        await assert.rejects(
          runClaudeCli(spawnImpl, "claude", [], 10, { label: "claude-cli" }),
          /claude-cli timed out after 10ms/,
        );
      },
    );

    assert.deepEqual(killCalls, [{ pid: -4242, signal: "SIGKILL" }]);
    // The direct-child fallback still runs after the group-kill attempt.
    assert.deepEqual(killSignals, ["SIGKILL"]);
  });

  test("swallows ESRCH when the process group is already gone, logs nothing, and still rejects with the timeout message", async () => {
    const killSignals: string[] = [];
    const spawnImpl = fakeHangingSpawn(4242, killSignals);
    const consoleErrorCalls: unknown[][] = [];

    await withPatchedConsoleError(consoleErrorCalls, async () => {
      await withPatchedProcessKill(
        () => {
          const err: NodeJS.ErrnoException = new Error("kill ESRCH");
          err.code = "ESRCH";
          throw err;
        },
        async () => {
          await assert.rejects(
            runClaudeCli(spawnImpl, "claude", [], 10, { label: "claude-cli" }),
            /claude-cli timed out after 10ms/,
          );
        },
      );
    });

    assert.deepEqual(consoleErrorCalls, []);
    assert.deepEqual(killSignals, ["SIGKILL"]);
  });

  test("a non-ESRCH errno is logged via console.error once, and the rejection is unchanged", async () => {
    const killSignals: string[] = [];
    const spawnImpl = fakeHangingSpawn(4242, killSignals);
    const consoleErrorCalls: unknown[][] = [];

    await withPatchedConsoleError(consoleErrorCalls, async () => {
      await withPatchedProcessKill(
        () => {
          const err: NodeJS.ErrnoException = new Error("kill EPERM");
          err.code = "EPERM";
          throw err;
        },
        async () => {
          await assert.rejects(
            runClaudeCli(spawnImpl, "claude", [], 10, { label: "claude-cli" }),
            /claude-cli timed out after 10ms/,
          );
        },
      );
    });

    assert.equal(consoleErrorCalls.length, 1);
    assert.match(String(consoleErrorCalls[0][0]), /claude-cli/);
    assert.match(String(consoleErrorCalls[0][0]), /-4242/);
    assert.match(String(consoleErrorCalls[0][0]), /kill EPERM/);
    assert.deepEqual(killSignals, ["SIGKILL"]);
  });

  test("a pid-less mock child (no numeric pid) never calls process.kill and falls back to child.kill(SIGKILL) — keeps the pinned drainer-runner assertion shape green", async () => {
    const killSignals: string[] = [];
    const spawnImpl = fakeHangingSpawn(undefined, killSignals);
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];

    await withPatchedProcessKill(
      (pid, signal) => {
        killCalls.push({ pid, signal });
        return true;
      },
      async () => {
        await assert.rejects(
          runClaudeCli(spawnImpl, "claude", [], 10, { label: "claude-cli" }),
          /claude-cli timed out after 10ms/,
        );
      },
    );

    assert.deepEqual(killCalls, []);
    assert.deepEqual(killSignals, ["SIGKILL"]);
  });
});

// -------------------------------------------------------------------------
// Live regression — mirrors the two already-green live cases in
// test/exec-with-timeout.test.mts, but drives runClaudeCli's own spawnImpl
// seam with a real `spawn` (never `claude`).
// -------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "claude-cli-exec-"));
}

async function readPidFile(path: string): Promise<number[]> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseInt(l, 10))
    .filter((n) => Number.isFinite(n));
}

async function pidsDead(pids: number[]): Promise<boolean> {
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err: any) {
      if (err.code === "EPERM") return false;
      if (err.code !== "ESRCH") throw err;
    }
  }
  return true;
}

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

describe("runClaudeCli — live process-group kill (issue #4379 regression)", () => {
  test(
    "REGRESSION (issue #4379): timeout kills a grandchild process, not just the immediate bash child",
    async () => {
      const tmp = makeTmpDir();
      const pidFile = join(tmp, "pids");
      const script = join(tmp, "leaker.sh");

      // Same #226-shaped fixture already proven deterministic in CI by
      // test/exec-with-timeout.test.mts: a backgrounded grandchild records
      // its PID then the script blocks forever, forcing the timeout path.
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "set -e",
          "(",
          "  sleep 30 &",
          "  echo $! >> " + JSON.stringify(pidFile),
          "  wait",
          ") &",
          "BG=$!",
          "echo $$ >> " + JSON.stringify(pidFile),
          "echo $BG >> " + JSON.stringify(pidFile),
          "sleep 60",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        await assert.rejects(
          runClaudeCli(defaultClaudeSpawn, "/bin/bash", [script], 500, {
            label: "claude-cli",
          }),
          /claude-cli timed out after 500ms/,
        );

        const pids = await readPidFile(pidFile);
        assert.ok(pids.length >= 2, `expected >=2 PIDs recorded, got ${pids.length}`);

        const allDead = await waitFor(() => pidsDead(pids), 3000);
        if (!allDead) {
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
            `Issue #4379 regression: process group leak — PIDs still alive after timeout: ${stillAlive.join(",")}.`,
          );
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
