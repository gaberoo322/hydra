/**
 * Regression tests for src/grounding/index.ts, src/grounding/cmd.ts, and
 * src/grounding/parser.ts.
 *
 * Every test in this file corresponds to a real bug we shipped a patch for
 * during the 2026-04-07/08 debug session. If any of these fail, grounding
 * has regressed and the orchestrator will likely start reporting
 * "0 tests passing" in cycle logs again.
 *
 * Previously these tests accessed grounding internals via a `_testing`
 * escape-hatch export. Now that the internals live in dedicated modules
 * (grounding/cmd.ts for command execution/utilities, grounding/parser.ts
 * for test-output parsing) they are imported directly — no escape hatch needed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi, truncate, runCmd } from "../src/grounding/cmd.ts";
import { parseTestCounts, parseFailingTests } from "../src/grounding/parser.ts";

/** Existence check for a list of PIDs — true if every PID is gone. */
async function pidsDead(pids: number[]): Promise<boolean> {
  for (const pid of pids) {
    try {
      process.kill(pid, 0); // signal 0 = existence probe
      return false; // still alive
    } catch (err: any) {
      if (err.code === "EPERM") return false; // alive but unreachable
      if (err.code !== "ESRCH") throw err;
      // ESRCH = dead — good
    }
  }
  return true;
}

async function readPidFile(path: string): Promise<number[]> {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseInt(l, 10))
    .filter((n) => Number.isFinite(n));
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

describe("stripAnsi", () => {
  test("removes simple ANSI color codes", () => {
    assert.equal(stripAnsi("\x1b[32mhello\x1b[39m"), "hello");
  });

  test("removes compound ANSI sequences like vitest's bold+color+reset", () => {
    assert.equal(stripAnsi("\x1b[1m\x1b[32m633\x1b[39m\x1b[22m"), "633");
  });

  test("handles empty and null input", () => {
    assert.equal(stripAnsi(""), "");
    assert.equal(stripAnsi(null), "");
    assert.equal(stripAnsi(undefined), "");
  });

  test("passes through strings with no ANSI unchanged", () => {
    assert.equal(stripAnsi("plain text"), "plain text");
  });

  test("handles dim text escape sequences (\\x1b[2m)", () => {
    assert.equal(stripAnsi("\x1b[2m Test Files \x1b[22m"), " Test Files ");
  });
});

describe("truncate", () => {
  test("returns unchanged when shorter than limit", () => {
    assert.equal(truncate("short", 100), "short");
  });

  test("handles null/empty input", () => {
    assert.equal(truncate(null, 100), "");
    assert.equal(truncate("", 100), "");
  });

  test("preserves both head AND tail when truncating", () => {
    const input = "HEAD_MARKER" + "X".repeat(10000) + "TAIL_MARKER";
    const result = truncate(input, 2000);
    assert.ok(result.includes("HEAD_MARKER"), "head content should be preserved");
    assert.ok(result.includes("TAIL_MARKER"), "tail content should be preserved");
    assert.ok(result.includes("truncated"), "should include a truncation divider");
    assert.ok(result.length < input.length, "should be shorter than input");
  });

  test("regression (2026-04-08): vitest summary at end of long output is preserved", () => {
    // Before the head+tail fix, head-biased truncation at 10KB cut off the
    // "Tests 633 passed" summary which appears AFTER all progress lines,
    // causing parseTestCounts to return 0 for every cycle.
    const progress = "✓ src/file.test.ts (10 tests) 100ms\n".repeat(500);
    const summary =
      "\n Test Files  72 passed (72)\n      Tests  633 passed (633)\n";
    const fullOutput = progress + summary;
    assert.ok(fullOutput.length > 10000, "fixture must exceed truncation limit");

    const truncated = truncate(fullOutput, 10000);
    assert.ok(
      truncated.includes("633 passed"),
      "summary line must survive truncation — this is the 2026-04-08 grounding bug",
    );
  });
});

describe("parseTestCounts", () => {
  test("clean vitest summary produces correct counts", () => {
    const stdout = `
 Test Files  72 passed (72)
      Tests  633 passed (633)
   Start at  17:06:32`;
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.passed, 633);
    assert.equal(counts.failed, 0);
    assert.equal(counts.total, 633);
  });

  test("regression (2026-04-06): ANSI-laden vitest summary parses correctly", () => {
    // This is the EXACT byte sequence we captured from the orchestrator's
    // systemd-service context on 2026-04-08 when debugging the 0-tests bug.
    // TERM is unset, npm forwards FORCE_COLOR=1 to vitest, and vitest emits
    // ANSI escape codes around every styled chunk.
    const stdout =
      "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m72 passed\x1b[39m\x1b[22m\x1b[90m (72)\x1b[39m\n" +
      "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m633 passed\x1b[39m\x1b[22m\x1b[90m (633)\x1b[39m";

    const counts = parseTestCounts(stdout, "");
    assert.equal(
      counts.passed,
      633,
      "must parse 633 despite ANSI escape codes — this is the 2026-04-06 grounding bug",
    );
    assert.equal(counts.failed, 0);
  });

  test("regression (2026-04-08): head+tail truncated output still matches", () => {
    // Chain both regression fixtures: simulate a realistic long vitest
    // output that gets truncated, then parse. This exercises the full
    // pipeline that was broken for 2 days.
    const progress = "[progress line] ".repeat(1500);
    const summary =
      "\n Test Files  72 passed (72)\n      Tests  633 passed (633)\n";
    const truncated = truncate(progress + summary, 10000);
    const counts = parseTestCounts(truncated, "");
    assert.equal(
      counts.passed,
      633,
      "tail-preserved summary must be parseable",
    );
  });

  test("parses both passed and failed counts", () => {
    const stdout = `
 Test Files  70 passed | 2 failed (72)
      Tests  631 passed | 2 failed (633)`;
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.passed, 631);
    assert.equal(counts.failed, 2);
    assert.equal(counts.total, 633);
  });

  test("falls back to jest-style output", () => {
    const stdout = "Tests:       10 passed, 10 total";
    const counts = parseTestCounts(stdout, "");
    assert.equal(counts.passed, 10);
    assert.equal(counts.total, 10);
  });

  test("empty output returns zeros", () => {
    const counts = parseTestCounts("", "");
    assert.equal(counts.passed, 0);
    assert.equal(counts.failed, 0);
    assert.equal(counts.total, 0);
  });

  test("handles stderr-only output (test output on stderr)", () => {
    const counts = parseTestCounts(
      "",
      "\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n",
    );
    assert.equal(counts.passed, 5);
  });
});

describe("parseFailingTests", () => {
  test("extracts FAIL lines from vitest-style output", () => {
    const stdout =
      "FAIL  src/foo.test.ts > suite > test A\n" +
      "FAIL  src/bar.test.ts > suite > test B";
    const failures = parseFailingTests(stdout, "");
    assert.equal(failures.length, 2);
    assert.ok(failures[0].includes("foo.test.ts"));
    assert.ok(failures[1].includes("bar.test.ts"));
  });

  test("handles ANSI-wrapped FAIL markers", () => {
    const stdout =
      "\x1b[31mFAIL\x1b[39m  src/foo.test.ts > suite > test A";
    const failures = parseFailingTests(stdout, "");
    assert.equal(
      failures.length,
      1,
      "must detect FAIL despite ANSI codes wrapping the marker",
    );
  });

  test("caps at 20 failures", () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `FAIL  src/test${i}.test.ts > test ${i}`,
    ).join("\n");
    const failures = parseFailingTests(lines, "");
    assert.equal(failures.length, 20);
  });

  test("returns empty for clean output", () => {
    assert.deepEqual(parseFailingTests("all good", ""), []);
    assert.deepEqual(parseFailingTests("", ""), []);
  });
});

// -------------------------------------------------------------------------
// runCmd — wired through execWithGroupCleanup (issue #844)
//
// grounding's runCmd is no longer a thin promisify(execFile) wrapper; it
// routes the spawn primitive through src/exec-with-timeout.ts so a hung
// `npm test` / `npm run typecheck` reaps its full process group instead of
// leaking tsx/vitest/esbuild grandchildren. These tests assert the live path
// behaviour: result contract, group-kill-on-timeout, and the maxBuffer-
// overflow → non-zero parity the old ERR_CHILD_PROCESS_STDIO_MAXBUFFER
// special-case used to provide.
// -------------------------------------------------------------------------
describe("runCmd (wired through execWithGroupCleanup, issue #844)", () => {
  test("successful command returns exitCode 0 and stdout", async () => {
    const r = await runCmd("echo", ["hello-grounding"], { timeout: 5000 });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello-grounding/);
    assert.ok(typeof r.durationMs === "number");
  });

  test("failing command yields a non-zero exitCode without throwing", async () => {
    const r = await runCmd("/bin/sh", ["-c", "exit 3"], { timeout: 5000 });
    assert.equal(r.exitCode, 3);
  });

  test("forces NO_COLOR / FORCE_COLOR in the child env (parser parity)", async () => {
    const r = await runCmd(
      "/bin/sh",
      ["-c", "printf 'NO_COLOR=%s FORCE_COLOR=%s' \"$NO_COLOR\" \"$FORCE_COLOR\""],
      { timeout: 5000 },
    );
    assert.match(r.stdout, /NO_COLOR=1 FORCE_COLOR=0/);
  });

  test(
    "REGRESSION (issue #226/#844): a timed-out command reaps its full process group",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "grounding-reap-"));
      const pidFile = join(tmp, "pids");
      const script = join(tmp, "leaker.sh");
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
          "echo $$ >> " + JSON.stringify(pidFile),
          "echo $! >> " + JSON.stringify(pidFile),
          "sleep 60",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        // Short timeout forces the group-kill path through grounding's runCmd.
        const r = await runCmd("/bin/bash", [script], { timeout: 600 });
        // A timed-out / signal-killed run surfaces a non-zero exitCode so the
        // grounding parseStatus classifies it as "errored", never a clean run.
        assert.notEqual(r.exitCode, 0, "timed-out run must be non-zero");

        const pids = await readPidFile(pidFile);
        assert.ok(pids.length >= 2, `expected >=2 PIDs, got ${pids.length}`);
        const allDead = await waitFor(() => pidsDead(pids), 3000);
        if (!allDead) {
          const stillAlive = pids.filter((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          });
          assert.fail(
            `#226 regression via grounding.runCmd: PIDs still alive after timeout: ${stillAlive.join(",")}`,
          );
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

// shouldCleanWorkingTree() tests retired with src/prepare-workspace.ts
// (issue #609). The in-process cycle loop that consumed the workspace-prep
// helpers was removed in PR #383 (codex cut-over, ADR-0006); the module
// had no production importers post-cutover and was deleted as dead code.
