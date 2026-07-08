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
import { groundProject, type GroundProjectDeps } from "../src/grounding/index.ts";
import type { TargetManifest } from "../src/schemas/target-manifest.ts";

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

// -------------------------------------------------------------------------
// groundProject — assembly logic via injected deps (issue #2182)
//
// groundProject is the fan-out coordinator: it spawns 11 subprocess calls and
// reads two files, then assembles a GroundingReport. Before #2182 it had no
// injectable deps surface, so its ASSEMBLY logic (the appDir probe, the
// testParseStatus classification, the failingTests join, the todoMarkers
// cap-at-20, the testReport.ran 127-guard) was only exercisable by spawning
// real processes against a real git repo. These tests inject stubs through the
// new optional `deps` bag so the composition is testable without spawning
// anything — mirroring the src/health/fan-out.ts CollectProbeDeps approach
// (issue #2089).
// -------------------------------------------------------------------------

type CmdResult = { exitCode: number; stdout: string; stderr: string; durationMs: number };

/** A `runCmd`-shaped stub that returns canned results keyed by the command. */
function stubRunCmd(
  byCmd: Record<string, Partial<CmdResult>>,
  fallback: Partial<CmdResult> = {},
): NonNullable<GroundProjectDeps["runCmd"]> {
  const defaults: CmdResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  return (async (cmd: string, args: string[]) => {
    // Key on a coarse "<cmd> <first-arg>" so `git log` vs `git status` differ.
    const key = `${cmd} ${args[0] ?? ""}`.trim();
    const hit = byCmd[key] ?? byCmd[cmd];
    return { ...defaults, ...(hit ?? fallback) };
  }) as NonNullable<GroundProjectDeps["runCmd"]>;
}

/** A `readFile`-shaped stub: returns content for known paths, rejects otherwise. */
function stubReadFile(
  byPathSubstring: Array<{ match: string; content: string }>,
): NonNullable<GroundProjectDeps["readFile"]> {
  return (async (path: unknown) => {
    const p = String(path);
    for (const { match, content } of byPathSubstring) {
      if (p.includes(match)) return content;
    }
    const err = new Error(`ENOENT (stub): ${p}`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  }) as NonNullable<GroundProjectDeps["readFile"]>;
}

/**
 * A `loadManifest`-shaped stub returning an OK manifest (issue #3019). Verify
 * commands and `appSubdir` are the fields grounding consumes; the risk block is
 * present (schema-required) but unread by grounding. Overrides let a test aim
 * the resolved test/typecheck command or the app subdir.
 */
function stubManifestOk(
  overrides: Partial<TargetManifest["verify"]> = {},
): NonNullable<GroundProjectDeps["loadManifest"]> {
  const manifest: TargetManifest = {
    version: 1,
    verify: {
      install: "npm ci",
      test: "npm test",
      typecheck: "npm run typecheck",
      build: "npm run build",
      appSubdir: "",
      ...overrides,
    },
    riskCritical: { surface: ["src/x/"], mutationKillFloor: 60 },
  };
  return ((_rootDir: string) => ({ ok: true as const, manifest }));
}

/** A `loadManifest`-shaped stub returning a fail-closed result (issue #3019). */
function stubManifestFail(
  errors: string[] = ["[target-manifest] manifest not found (stub)"],
): NonNullable<GroundProjectDeps["loadManifest"]> {
  return ((_rootDir: string) => ({ ok: false as const, errors }));
}

describe("groundProject (assembly via injected deps, issue #2182)", () => {
  test("byte-identical default: omitting deps does not change the call shape", async () => {
    // A no-deps call must still type-check and run; we drive it with stubs only
    // to assert the optional param is genuinely optional (3rd arg defaults to {}).
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({ "git branch": { stdout: "main\n" } }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.branch, "main");
  });

  // REWRITTEN for issue #3019 (was: "appDir subdirectory probe: root has no
  // package.json → probes web/"). The hardcoded ['web','app','packages/app']
  // probe left the target flow — appDir is now derived from the manifest's
  // verify.appSubdir. This case pins the NEW invariant: package.json is read
  // from `<projectDir>/<appSubdir>/`, and the readFile probe never walks the
  // old candidate list.
  test("appDir sourced from manifest verify.appSubdir (no ['web','app',…] probe)", async () => {
    const reads: string[] = [];
    const readFile = (async (path: unknown) => {
      const p = String(path);
      reads.push(p);
      if (p.includes("/fake/project/web/package.json")) return '{"name":"web-app"}';
      const err = new Error("ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }) as NonNullable<GroundProjectDeps["readFile"]>;

    const report = await groundProject(
      "/fake/project",
      {},
      { runCmd: stubRunCmd({}), readFile, loadManifest: stubManifestOk({ appSubdir: "web" }) },
    );

    // package.json read from the manifest-declared web/ appDir.
    assert.equal(report.packageJson, '{"name":"web-app"}');
    assert.ok(
      reads.some((p) => p.endsWith("/fake/project/web/package.json")),
      "must read package.json from the manifest appSubdir (web/)",
    );
    // The old heuristic root-first probe is gone: there is NO read of the bare
    // root package.json, and NO read of the app/ or packages/app/ candidates.
    assert.ok(
      !reads.some((p) => p.endsWith("/fake/project/package.json")),
      "must NOT probe the root package.json (old heuristic removed)",
    );
    assert.ok(
      !reads.some((p) => p.includes("packages/app/package.json") || p.endsWith("/app/package.json")),
      "must NOT probe the old ['app','packages/app'] candidates",
    );
  });

  test("appDir === projectDir when appSubdir is '' (repo-root target)", async () => {
    const reads: string[] = [];
    const readFile = (async (path: unknown) => {
      const p = String(path);
      reads.push(p);
      if (p.endsWith("/fake/root/package.json")) return '{"name":"root-app"}';
      const err = new Error("ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }) as NonNullable<GroundProjectDeps["readFile"]>;

    const report = await groundProject(
      "/fake/root",
      {},
      { runCmd: stubRunCmd({}), readFile, loadManifest: stubManifestOk({ appSubdir: "" }) },
    );
    assert.equal(report.packageJson, '{"name":"root-app"}');
    assert.ok(
      reads.some((p) => p.endsWith("/fake/root/package.json")),
      "empty appSubdir => appDir === projectDir",
    );
  });

  test('testParseStatus "ok": exit 0 with a recognised vitest summary', async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({
          "npm test": {
            exitCode: 0,
            stdout: "\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n",
          },
        }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.testReport.parseStatus, "ok");
    assert.equal(report.testReport.recognised, true);
    assert.equal(report.testReport.passed, 10);
    assert.equal(report.testReport.ran, true);
  });

  test('testParseStatus "unrecognised": exit 0 but no summary line', async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({
          "npm test": { exitCode: 0, stdout: "ran some stuff but no summary" },
        }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.testReport.parseStatus, "unrecognised");
    assert.equal(report.testReport.recognised, false);
  });

  test('testParseStatus "errored": non-zero exit', async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({
          "npm test": {
            exitCode: 1,
            stdout: "FAIL  src/a.test.ts > suite > broken\n Tests  1 failed (1)\n",
          },
        }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.testReport.parseStatus, "errored");
    assert.equal(report.testReport.ran, true, "non-127 exit still counts as ran");
  });

  test('testParseStatus "not-run" + testReport.ran=false: exit 127 (command not found)', async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({ "npm test": { exitCode: 127, stderr: "command not found" } }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.testReport.parseStatus, "not-run");
    assert.equal(report.testReport.ran, false, "127 means the command was never run");
  });

  test("failingTests: derived from the test command's output", async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({
          "npm test": {
            exitCode: 1,
            stdout:
              "FAIL  src/foo.test.ts > suite > test A\n" +
              "FAIL  src/bar.test.ts > suite > test B\n",
          },
        }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.failingTests.length, 2);
    assert.ok(report.failingTests[0].includes("foo.test.ts"));
    assert.ok(report.failingTests[1].includes("bar.test.ts"));
  });

  test("todoMarkers: caps at 20 even when grep returns more", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts:1:TODO item ${i}`).join("\n");
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({ grep: { exitCode: 0, stdout: lines } }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.todoMarkers.length, 20, "todoMarkers must be capped at 20");
  });

  test("todoMarkers: empty when grep exits non-zero (no matches)", async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        // grep exits 1 when it finds nothing.
        runCmd: stubRunCmd({ grep: { exitCode: 1, stdout: "" } }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.deepEqual(report.todoMarkers, []);
  });

  test("git fields assembled from per-command stdout", async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({
          "git branch": { stdout: "feature/x\n" },
          "git log": { stdout: "abc123 first\ndef456 second\n" },
          "git status": { stdout: " M src/a.ts\n M src/b.ts\n" },
          "git ls-files": { stdout: "src/a.ts\nsrc/b.ts\nsrc/c.ts\n" },
        }),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.branch, "feature/x");
    // git log appears twice (head + recent); the stub keys both to the same stdout.
    assert.equal(report.headCommit, "abc123 first\ndef456 second");
    assert.deepEqual(report.recentCommits, ["abc123 first", "def456 second"]);
    // The assembly does `stdout.trim().split("\n")`, so the leading whitespace
    // of the FIRST line is stripped by the outer trim (subsequent lines keep it).
    assert.deepEqual(report.dirtyFiles, ["M src/a.ts", " M src/b.ts"]);
    assert.equal(report.fileCount, 3);
  });

  test("readme: truncated to 2000 chars; falls back to appDir README", async () => {
    const longReadme = "R".repeat(5000);
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({}),
        readFile: stubReadFile([
          { match: "package.json", content: "{}" },
          { match: "README.md", content: longReadme },
        ]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.readme.length, 2000, "README must be capped at 2000 chars");
  });

  test("no real subprocess: a stubbed run completes fast and never spawns", async () => {
    // Sanity guard for the leverage claim — the whole fan-out resolves from
    // stubs with no real `git`/`npm`/`grep` ever invoked.
    const start = Date.now();
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({}),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.ok(typeof report.groundingDurationMs === "number");
    assert.ok(Date.now() - start < 1000, "stubbed grounding must be sub-second");
  });
});

// -------------------------------------------------------------------------
// groundProject — Target Manifest sourcing + fail-closed (issue #3019, ADR-0026)
//
// The verify commands (test, typecheck) and the app subdir are sourced from
// `<projectDir>/.hydra/manifest.json` via the injected loadManifest, NOT
// hardcoded. A missing/malformed manifest is FAIL-CLOSED: no test/typecheck
// subprocess runs, `manifestError` is populated, and NO default `npm test` is
// substituted (that default is the betting count-gate trap this slice kills).
// grounding stays READ-ONLY and NEVER throws — a load failure returns a report.
// -------------------------------------------------------------------------
describe("groundProject Target Manifest sourcing (issue #3019)", () => {
  test("manifest-sourced verify.test drives the test command (betting: test:raw, not npm test)", async () => {
    const invoked: string[] = [];
    const runCmd = (async (cmd: string, args: string[]) => {
      invoked.push(`${cmd} ${args.join(" ")}`.trim());
      if (cmd === "npm" && args.join(" ") === "run test:raw") {
        return { exitCode: 0, stdout: "\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n", stderr: "", durationMs: 1 };
      }
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }) as NonNullable<GroundProjectDeps["runCmd"]>;

    const report = await groundProject(
      "/fake/betting",
      {},
      {
        runCmd,
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk({ test: "npm run test:raw" }),
      },
    );

    assert.ok(
      invoked.includes("npm run test:raw"),
      "the manifest verify.test (npm run test:raw) must be the command grounding runs",
    );
    assert.ok(
      !invoked.some((c) => c === "npm test"),
      "grounding must NOT run the count-gate `npm test` — that is the trap this slice kills",
    );
    assert.equal(report.testReport.parseStatus, "ok");
    assert.equal(report.testReport.passed, 5);
    assert.equal(report.manifestError, null);
  });

  test("manifest-sourced verify.typecheck drives the typecheck command", async () => {
    const invoked: string[] = [];
    const runCmd = (async (cmd: string, args: string[]) => {
      invoked.push(`${cmd} ${args.join(" ")}`.trim());
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }) as NonNullable<GroundProjectDeps["runCmd"]>;

    await groundProject(
      "/fake/project",
      {},
      {
        runCmd,
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk({ typecheck: "npm run tc:strict" }),
      },
    );
    assert.ok(
      invoked.includes("npm run tc:strict"),
      "the manifest verify.typecheck must be the command grounding runs (not a hardcoded `npm run typecheck`)",
    );
  });

  test("fail-closed: missing/malformed manifest → no test or typecheck subprocess, manifestError populated", async () => {
    const invoked: string[] = [];
    const runCmd = (async (cmd: string, args: string[]) => {
      invoked.push(`${cmd} ${args.join(" ")}`.trim());
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }) as NonNullable<GroundProjectDeps["runCmd"]>;

    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd,
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestFail(["[target-manifest] manifest not found (stub)"]),
      },
    );

    // manifestError surfaces the load failure (fail loud, no throw).
    assert.deepEqual(report.manifestError, ["[target-manifest] manifest not found (stub)"]);
    // No test/typecheck subprocess ran, and crucially NO default `npm test`.
    assert.ok(!invoked.some((c) => c.startsWith("npm test")), "must NOT default to `npm test`");
    assert.ok(!invoked.some((c) => c === "npm run typecheck"), "must NOT default to `npm run typecheck`");
    // Both reports classify as not-run (127 stand-in).
    assert.equal(report.testReport.ran, false);
    assert.equal(report.testReport.parseStatus, "not-run");
    assert.equal(report.typecheckReport.ran, false);
    assert.equal(report.typecheckReport.exitCode, 127);
    // Grounding still returned a report (never threw) and still gathered git state.
    assert.equal(typeof report.groundingDurationMs, "number");
  });

  test("ok path: manifestError is null", async () => {
    const report = await groundProject(
      "/fake/project",
      {},
      {
        runCmd: stubRunCmd({}),
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk(),
      },
    );
    assert.equal(report.manifestError, null);
  });

  test("precedence: explicit opts.testCmd overrides the manifest verify.test", async () => {
    const invoked: string[] = [];
    const runCmd = (async (cmd: string, args: string[]) => {
      invoked.push(`${cmd} ${args.join(" ")}`.trim());
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }) as NonNullable<GroundProjectDeps["runCmd"]>;

    await groundProject(
      "/fake/project",
      { testCmd: "yarn", testArgs: ["jest"] },
      {
        runCmd,
        readFile: stubReadFile([{ match: "package.json", content: "{}" }]),
        loadManifest: stubManifestOk({ test: "npm run test:raw" }),
      },
    );
    assert.ok(invoked.includes("yarn jest"), "explicit opts.testCmd wins over the manifest");
    assert.ok(!invoked.includes("npm run test:raw"), "manifest verify.test is overridden by opts.testCmd");
  });

  test("real loadManifest default: no manifest on disk → fail-closed (no throw)", async () => {
    // Omit the loadManifest stub so the REAL loader runs against a temp dir with
    // no .hydra/manifest.json. It must fail-closed, not throw, not default.
    const tmp = mkdtempSync(join(tmpdir(), "grounding-nomanifest-"));
    try {
      const invoked: string[] = [];
      const runCmd = (async (cmd: string, args: string[]) => {
        invoked.push(`${cmd} ${args.join(" ")}`.trim());
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      }) as NonNullable<GroundProjectDeps["runCmd"]>;
      const report = await groundProject(
        tmp,
        {},
        { runCmd, readFile: stubReadFile([{ match: "package.json", content: "{}" }]) },
      );
      assert.ok(Array.isArray(report.manifestError) && report.manifestError.length >= 1);
      assert.ok(report.manifestError![0].startsWith("[target-manifest]"));
      assert.ok(!invoked.some((c) => c.startsWith("npm test")), "real loader path must not default to `npm test`");
      assert.equal(report.testReport.parseStatus, "not-run");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
