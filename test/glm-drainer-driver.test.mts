/**
 * test/glm-drainer-driver.test.mts — pin `runDriverMode`, the GLM dev-drainer
 * bash↔TypeScript bridge that replaced the `write_node_driver()` heredoc
 * inside `scripts/glm/drainer-loop.sh` (issue #4371).
 *
 * Every case drives an INJECTED `DriverDeps` object — no live Redis, no live
 * `claude` spawn, no filesystem read beyond an in-memory fake — so this suite
 * exercises the three modes' control flow (heartbeat / preflight / author)
 * plus the bad-argv and driver-fault arms as an ordinary TypeScript unit,
 * exactly the leverage the issue asks for (mirrors
 * `test/glm-drainer-runner.test.mts`'s technique for the sibling module).
 *
 * New top-level describe with its own trivial lifecycle — it touches no
 * shared Redis seam, so it never piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runDriverMode,
  isDriverFailure,
  type DriverDeps,
} from "../src/glm/drainer-driver.ts";
import type { SpawnFn } from "../src/claude-cli/exec.ts";

/** A spawn stub that fails loudly if it is ever actually invoked. */
const unusedSpawn: SpawnFn = (() => {
  throw new Error("spawn should never be invoked directly by runDriverMode");
}) as unknown as SpawnFn;

/** Base fake deps: every call is a no-op success unless overridden. */
function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return {
    setGlmDrainerHeartbeat: (async () => ({ ok: true }) as any) as DriverDeps["setGlmDrainerHeartbeat"],
    preflightBeforePr: (async () => ({ ok: true, checkedPaths: 0 })) as DriverDeps["preflightBeforePr"],
    buildGlmEnv: (() => ({ ok: true, env: {} })) as DriverDeps["buildGlmEnv"],
    buildDrainerArgs: (() => ({ ok: true, args: [] })) as DriverDeps["buildDrainerArgs"],
    runGlmClaude: (async () => ({ code: 0, stdout: "", stderr: "" })) as DriverDeps["runGlmClaude"],
    spawn: unusedSpawn,
    readFile: () => "",
    env: {},
    apiTimeoutMs: 1000,
    ...overrides,
  };
}

describe("src/glm/drainer-driver.ts — runDriverMode (issue #4371)", () => {
  test("heartbeat: ok:true result -> exit 0, line is the JSON result", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => ({ ok: true })) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.equal(outcome.ok, true);
    assert.ok(!isDriverFailure(outcome));
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), { ok: true });
    }
  });

  test("heartbeat: ok:false result -> exit 1, line still carries the result", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => ({
        ok: false,
        code: "glm-heartbeat-write-failed",
        message: "redis down",
      })) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.equal(outcome.ok, true); // driver itself did not fault
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 1);
      assert.deepEqual(JSON.parse(outcome.line), {
        ok: false,
        code: "glm-heartbeat-write-failed",
        message: "redis down",
      });
    }
  });

  test("preflight: reads/trims/blank-filters the changed-files file, exits 0 on an ok:true verdict", async () => {
    let capturedPaths: readonly string[] | undefined;
    const deps = makeDeps({
      readFile: () => "src/a.ts\n  src/b.ts  \n\n\n",
      preflightBeforePr: (async (options) => {
        capturedPaths = options.changedPaths;
        return { ok: true, checkedPaths: options.changedPaths.length };
      }) as DriverDeps["preflightBeforePr"],
    });
    const outcome = await runDriverMode(["preflight", "/fake/changed.txt"], deps);
    assert.deepEqual(capturedPaths, ["src/a.ts", "src/b.ts"]);
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), { ok: true, checkedPaths: 2 });
    } else {
      assert.fail("expected a success outcome");
    }
  });

  test("preflight: exits 0 even on a BLOCKED (ok:false) verdict — a completed check, not a driver fault", async () => {
    const deps = makeDeps({
      readFile: () => "src/untouchable.ts\n",
      preflightBeforePr: (async () => ({
        ok: false,
        code: "glm-preflight-blocked",
        violations: [{ kind: "verifier-core", path: "src/untouchable.ts", matched: "src/untouchable.ts" }],
        message: "blocked",
      })) as DriverDeps["preflightBeforePr"],
    });
    const outcome = await runDriverMode(["preflight", "/fake/changed.txt"], deps);
    assert.ok(!isDriverFailure(outcome), "a blocked preflight verdict is not a driver fault");
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      const parsed = JSON.parse(outcome.line);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, "glm-preflight-blocked");
    }
  });

  test("preflight: missing <changed-files-file> arg -> glm-driver-bad-argv", async () => {
    const deps = makeDeps();
    const outcome = await runDriverMode(["preflight"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-bad-argv");
      assert.match(outcome.message, /changed-files-file/);
    }
  });

  test("author: buildGlmEnv failure -> ok:false JSON with NO spawn, exit 0", async () => {
    let runGlmClaudeCalls = 0;
    const deps = makeDeps({
      readFile: () => "prompt text",
      buildGlmEnv: (() => ({
        ok: false,
        code: "glm-auth-token-missing",
        message: "ANTHROPIC_AUTH_TOKEN is unset",
      })) as DriverDeps["buildGlmEnv"],
      runGlmClaude: (async () => {
        runGlmClaudeCalls++;
        return { code: 0, stdout: "", stderr: "" };
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    assert.equal(runGlmClaudeCalls, 0, "spawn/runGlmClaude must never be invoked on a buildGlmEnv failure");
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), {
        ok: false,
        code: "glm-auth-token-missing",
        message: "ANTHROPIC_AUTH_TOKEN is unset",
      });
    } else {
      assert.fail("expected a success outcome (driver itself did not fault)");
    }
  });

  test("author: buildDrainerArgs failure -> ok:false JSON with NO spawn, exit 0", async () => {
    let runGlmClaudeCalls = 0;
    const deps = makeDeps({
      readFile: () => "prompt text",
      buildDrainerArgs: (() => ({
        ok: false,
        code: "glm-model-would-route-first-party",
        message: "refusing to route first-party",
      })) as DriverDeps["buildDrainerArgs"],
      runGlmClaude: (async () => {
        runGlmClaudeCalls++;
        return { code: 0, stdout: "", stderr: "" };
      }) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    assert.equal(runGlmClaudeCalls, 0, "spawn/runGlmClaude must never be invoked on a buildDrainerArgs failure");
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      assert.deepEqual(JSON.parse(outcome.line), {
        ok: false,
        code: "glm-model-would-route-first-party",
        message: "refusing to route first-party",
      });
    } else {
      assert.fail("expected a success outcome (driver itself did not fault)");
    }
  });

  test("author: success -> ok:true JSON, stdout/stderr tail-truncated to 4000 chars", async () => {
    const longStdout = "o".repeat(5000);
    const longStderr = "e".repeat(5000);
    const deps = makeDeps({
      readFile: () => "prompt text",
      runGlmClaude: (async () => ({ code: 0, stdout: longStdout, stderr: longStderr })) as DriverDeps["runGlmClaude"],
    });
    const outcome = await runDriverMode(["author", "/fake/prompt.txt", "/fake/wt"], deps);
    if (!isDriverFailure(outcome)) {
      assert.equal(outcome.exitCode, 0);
      const parsed = JSON.parse(outcome.line);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.code, 0);
      assert.equal(parsed.stdout, longStdout.slice(-4000));
      assert.equal(parsed.stderr, longStderr.slice(-4000));
      assert.equal(parsed.stdout.length, 4000);
    } else {
      assert.fail("expected a success outcome");
    }
  });

  test("author: missing <prompt-file>/<cwd> args -> glm-driver-bad-argv", async () => {
    const deps = makeDeps();
    const outcome = await runDriverMode(["author", "/fake/prompt.txt"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-bad-argv");
      assert.match(outcome.message, /prompt-file/);
    }
  });

  test("unknown mode -> glm-driver-bad-argv, no stack (never a thrown Error)", async () => {
    const deps = makeDeps();
    const outcome = await runDriverMode(["no-such-mode"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-bad-argv");
      assert.match(outcome.message, /unknown mode: no-such-mode/);
      assert.equal(outcome.stack, undefined);
    }
  });

  test("a rejecting dependency never throws out of runDriverMode -> glm-driver-fault, stack preserved", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => {
        throw new Error("kaboom");
      }) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-fault");
      assert.match(outcome.message, /kaboom/);
      // The original heredoc's `main().catch` wrote `err.stack` to stderr,
      // not just `err.message` — pin that the full multi-line stack survives
      // into the outcome so the CLI entrypoint can reproduce it byte-for-byte.
      assert.ok(outcome.stack, "expected a stack to be carried on glm-driver-fault");
      assert.match(outcome.stack!, /kaboom/);
      assert.match(outcome.stack!, /Error: kaboom\n\s+at /, "expected a real multi-line Error stack, not just the message");
    }
  });

  test("a rejecting dependency that throws a non-Error still falls back to String(err), matching the original heredoc", async () => {
    const deps = makeDeps({
      setGlmDrainerHeartbeat: (async () => {
        // eslint has no opinion here (no eslint config in this repo) — a
        // non-Error throw is a legitimate JS possibility runDriverMode's
        // catch must still handle per `err instanceof Error ? ... : String(err)`.
        throw "not an Error object";
      }) as DriverDeps["setGlmDrainerHeartbeat"],
    });
    const outcome = await runDriverMode(["heartbeat"], deps);
    assert.ok(isDriverFailure(outcome));
    if (isDriverFailure(outcome)) {
      assert.equal(outcome.code, "glm-driver-fault");
      assert.equal(outcome.message, "not an Error object");
      assert.equal(outcome.stack, "not an Error object");
    }
  });
});
