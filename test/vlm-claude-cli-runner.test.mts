/**
 * test/vlm-claude-cli-runner.test.mts — pin the claude-cli subprocess leaf
 * (issue #3633) extracted from src/api/vlm.ts. Drives the runClaude spawn seam
 * with an INJECTED fake child (no live `claude` process). Asserts the
 * design-concept invariants: resolve-regardless-of-exit-code, reject on spawn
 * failure / process error / timeout (SIGKILL), and resolveTimeoutMs defaulting.
 *
 * New top-level describe with its own trivial lifecycle — touches no shared
 * Redis seam, so it never piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveTimeoutMs,
  runClaude,
} from "../src/vlm/claude-cli-runner.ts";

/** A fake child that emits canned stdout/stderr then closes with exitCode. */
function fakeSpawn(stdout: string, stderr: string, exitCode: number): any {
  return (): any => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode);
    });
    return child;
  };
}

describe("vlm claude-cli-runner leaf (issue #3633)", () => {
  test("resolveTimeoutMs floors positive finite input, defaults otherwise", () => {
    assert.equal(resolveTimeoutMs(1234.9), 1234);
    assert.equal(resolveTimeoutMs(undefined), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs(0), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs(-5), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs(Number.NaN), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs(Number.POSITIVE_INFINITY), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 300_000);
  });

  test("resolves with {code,stdout,stderr} regardless of a non-zero exit code", async () => {
    const run = await runClaude(fakeSpawn("out", "err", 1), "claude", ["-p", "x"], 5_000);
    assert.deepEqual(run, { code: 1, stdout: "out", stderr: "err" });
  });

  test("rejects when spawn throws synchronously", async () => {
    const throwingSpawn: any = () => {
      throw new Error("ENOENT claude");
    };
    await assert.rejects(
      runClaude(throwingSpawn, "claude", [], 5_000),
      /claude-cli spawn failed: ENOENT claude/,
    );
  });

  test("rejects on a child 'error' event", async () => {
    const erroringSpawn: any = () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    };
    await assert.rejects(
      runClaude(erroringSpawn, "claude", [], 5_000),
      /claude-cli spawn failed: spawn EACCES/,
    );
  });

  test("rejects with a timeout and SIGKILLs the child when the deadline elapses", async () => {
    let killedWith: string | undefined;
    const hangingSpawn: any = () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (sig: string) => {
        killedWith = sig;
      };
      // never emits close → forces the timeout path.
      return child;
    };
    await assert.rejects(
      runClaude(hangingSpawn, "claude", [], 10),
      /claude-cli timed out after 10ms/,
    );
    assert.equal(killedWith, "SIGKILL");
  });
});
