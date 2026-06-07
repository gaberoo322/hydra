import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execWithGroupCleanup } from "./exec-with-timeout.ts";

const CMD_TIMEOUT = 120_000; // 2 min per command (parallel tests complete in ~40s)
const OUTPUT_LIMIT = 10_000; // truncate stdout/stderr to 10KB
const RUN_CMD_MAX_BUFFER = 5 * 1024 * 1024; // 5MB — see runCmd maxBuffer-overflow note

function truncate(str, limit = OUTPUT_LIMIT) {
  if (!str || str.length <= limit) return str || "";
  // Keep HEAD + TAIL rather than just head. For test and build commands the
  // signal we care about (vitest's "Tests N passed" summary, tsc's final
  // error counts, webpack build results) lives at the END of stdout — not
  // the start. A pure head-truncate at 10KB hides it and caused every
  // orchestrator cycle to report "0 tests passing" from 2026-04-06 onward.
  // This head+tail bias preserves both early errors and final summaries.
  const headLen = Math.floor(limit / 2);
  const tailLen = limit - headLen - 100; // reserve ~100 chars for the divider
  return (
    str.slice(0, headLen) +
    `\n... (truncated, ${str.length} total chars, keeping head + tail) ...\n` +
    str.slice(-tailLen)
  );
}

/**
 * Strip ANSI escape sequences from a string. Defense in depth for any child
 * process that ignores the NO_COLOR env var and emits colored output anyway.
 * See the 2026-04-08 debug session for the full backstory — npm was passing
 * FORCE_COLOR=1 through to vitest under systemd even with TERM unset.
 */
function stripAnsi(str) {
  if (!str) return "";
  // Match CSI (control sequence introducer) ANSI codes: ESC [ ... final byte
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Run a command and return { exitCode, stdout, stderr, durationMs }.
 * Never throws — captures errors as non-zero exit codes.
 */
async function runCmd(cmd, args,  opts: Record<string, any> = {}) {
  const start = Date.now();
  const timeout = opts.timeout || CMD_TIMEOUT;
  // Force NO_COLOR in the child env so vitest/tsc/etc. don't emit ANSI escape
  // codes that break the stdout parsers below (parseTestCounts, parseFailingTests).
  //
  // When the orchestrator runs as a systemd service, TERM is unset, and npm
  // passes FORCE_COLOR=1 through to child processes by default — which makes
  // vitest render "Tests 633 passed" as "\x1b[2m Tests \x1b[22m \x1b[1m\x1b[32m633 passed"
  // and the regex `^\s*Tests\s+(\d+)\s+passed` fails to match.
  //
  // This caused every cycle since 2026-04-06 to report "0 tests passing" and
  // feed that garbage into the planner/skeptic/executor prompts. Fixed 2026-04-08.
  const childEnv = {
    ...(opts.env || process.env),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  // Route through execWithGroupCleanup (shell:false default — these are
  // direct execFile-style spawns: npm/tsc/git/grep with explicit args, no
  // shell coercion). On timeout the adapter kills the entire process group
  // (issue #226 / #844), so leaked tsx/vitest/esbuild grandchildren no longer
  // survive a hung `npm test` / `npm run typecheck`.
  //
  // The adapter never throws — it resolves with a result object — so the old
  // throw/catch error path collapses to result inspection.
  const result = await execWithGroupCleanup(cmd, args, {
    cwd: opts.cwd,
    timeout,
    env: childEnv,
    maxBuffer: RUN_CMD_MAX_BUFFER,
  });

  // maxBuffer-overflow parity (#844): the old code special-cased
  // ERR_CHILD_PROCESS_STDIO_MAXBUFFER → exitCode 1 so an overflowing run was
  // never read as a clean success. The adapter instead truncates and resolves
  // with the real exitCode, so a >5MB run that exits 0 would otherwise leak
  // through as success. Preserve the non-zero-on-overflow contract: if either
  // stream overflowed, force a non-zero exit (1) unless the process already
  // reported a non-zero code (keep the more specific signal in that case).
  const overflowed =
    result.stdout.includes(`truncated at maxBuffer=${RUN_CMD_MAX_BUFFER}`) ||
    result.stderr.includes(`truncated at maxBuffer=${RUN_CMD_MAX_BUFFER}`);
  const exitCode = overflowed && result.exitCode === 0 ? 1 : result.exitCode;

  return {
    exitCode,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    durationMs: Date.now() - start,
  };
}

/**
 * Parse vitest/jest output for pass/fail counts.
 * Looks for patterns like "Tests  42 passed (42)" or "42 passed | 2 failed".
 *
 * Returns `{ passed, failed, total, recognised }` where `recognised` is true
 * if at least one known summary pattern matched. A `recognised: false`
 * result paired with `exitCode === 0` is the silent-no-op shape — the test
 * command appeared to succeed but the parser found nothing to read. Callers
 * (see `groundProject` below) translate that into a `testParseStatus` field
 * on the grounding snapshot so consumers can distinguish "ran 0 tests" from
 * "we couldn't read the result". See issue #456.
 */
function parseTestCounts(stdout, stderr) {
  // Strip ANSI codes first — see stripAnsi() docs above.
  const combined = stripAnsi((stdout || "") + "\n" + (stderr || ""));
  let passed = 0, failed = 0, total = 0;
  let recognised = false;

  // Vitest outputs two lines: "Test Files  43 passed (43)" and "Tests  352 passed (352)"
  // We want the "Tests" line (individual test count), not "Test Files" (file count)
  const testsLineMatch = combined.match(/^\s*Tests\s+(\d+)\s+passed/m);
  const testsFailMatch = combined.match(/^\s*Tests\s+.*?(\d+)\s+failed/m);
  if (testsLineMatch) {
    passed = parseInt(testsLineMatch[1]);
    recognised = true;
  }
  if (testsFailMatch) {
    failed = parseInt(testsFailMatch[1]);
    recognised = true;
  }

  // Fallback: generic "N passed" if the vitest-specific pattern didn't match
  if (passed === 0) {
    const genericPass = combined.match(/(\d+)\s+passed/);
    if (genericPass) {
      passed = parseInt(genericPass[1]);
      recognised = true;
    }
  }
  if (failed === 0) {
    const genericFail = combined.match(/(\d+)\s+failed/);
    if (genericFail) {
      failed = parseInt(genericFail[1]);
      recognised = true;
    }
  }

  total = passed + failed;

  // Try "Test Suites: X passed, Y total" (jest)
  if (total === 0) {
    const jestMatch = combined.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
    if (jestMatch) {
      passed = parseInt(jestMatch[1]);
      total = parseInt(jestMatch[2]);
      failed = total - passed;
      recognised = true;
    }
  }

  return { passed, failed, total, recognised };
}

/**
 * Extract failing test names from vitest/jest output.
 */
function parseFailingTests(stdout, stderr) {
  // Strip ANSI codes first — see stripAnsi() docs above.
  const combined = stripAnsi((stdout || "") + "\n" + (stderr || ""));
  const failures = [];

  // Vitest: "FAIL  src/foo.test.ts > suite > test name"
  // Or: "× test name" / "✗ test name"
  for (const line of combined.split("\n")) {
    const failLine = line.match(/(?:FAIL|×|✗|✘)\s+(.+)/);
    if (failLine) {
      failures.push(failLine[1].trim());
    }
  }

  return failures.slice(0, 20); // cap at 20
}

/**
 * Deep repo inspection. Returns structured evidence about the project.
 *
 * @param {string} projectDir - Path to the target project
 * @param {object} opts - { focusPaths?: string[], testCmd?: string }
 * @returns {GroundingReport}
 */
export async function groundProject(projectDir,  opts: Record<string, any> = {}) {
  const timestamp = Date.now();
  const testCmd = opts.testCmd || "npm";
  const testArgs = opts.testArgs || ["test"];

  // Grounding is READ-ONLY. Workspace cleanup (checkout main, discard
  // tracked changes, delete stale feature branches) now lives in
  // prepare-workspace.mjs — the control loop calls it explicitly BEFORE
  // grounding so "reading the truth" can never mutate that truth.

  // Detect app directory — some projects have code in a subdirectory (e.g., web/)
  let appDir = projectDir;
  try {
    await readFile(join(projectDir, "package.json"), "utf-8");
  } catch { /* intentional: no package.json at root — probe subdirs */
    for (const sub of ["web", "app", "packages/app"]) {
      try {
        await readFile(join(projectDir, sub, "package.json"), "utf-8");
        appDir = join(projectDir, sub);
        break;
      } catch { /* intentional: sub-dir does not have package.json, try next */ }
    }
  }

  // Run all inspections in parallel
  const [
    branchResult,
    headResult,
    logResult,
    statusResult,
    lsFilesResult,
    diffStatResult,
    testResult,
    tscResult,
    pkgResult,
    todoResult,
    readmeContent,
  ] = await Promise.all([
    // Git state (always from project root)
    runCmd("git", ["branch", "--show-current"], { cwd: projectDir, timeout: 5000 }),
    runCmd("git", ["log", "--oneline", "-1"], { cwd: projectDir, timeout: 5000 }),
    runCmd("git", ["log", "--oneline", "-20"], { cwd: projectDir, timeout: 5000 }),
    runCmd("git", ["status", "--short"], { cwd: projectDir, timeout: 5000 }),
    runCmd("git", ["ls-files"], { cwd: projectDir, timeout: 10000 }),
    runCmd("git", ["diff", "--stat", "HEAD~3"], { cwd: projectDir, timeout: 10000 }).catch(() => ({
      exitCode: 1, stdout: "", stderr: "not enough history", durationMs: 0,
    })),
    // Tests (from app directory where package.json lives)
    runCmd(testCmd, testArgs, { cwd: appDir, timeout: CMD_TIMEOUT }),
    // Typecheck (from app directory — use project's own script if available)
    runCmd("npm", ["run", "typecheck"], { cwd: appDir, timeout: 60_000 }),
    // Package.json
    readFile(join(appDir, "package.json"), "utf-8").catch(() => "{}"),
    // TODO/FIXME markers — cheap signal for known gaps (exclude build artifacts)
    runCmd("grep", ["-rn", "--include=*.ts", "--include=*.tsx", "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=dist", "--exclude-dir=.turbo", "-E", "TODO|FIXME|HACK|XXX", "."], { cwd: projectDir, timeout: 10000 }),
    // README for project context
    readFile(join(projectDir, "README.md"), "utf-8").catch(() =>
      readFile(join(appDir, "README.md"), "utf-8").catch(() => "")
    ),
  ]);

  const testCounts = parseTestCounts(testResult.stdout, testResult.stderr);
  const failingTests = parseFailingTests(testResult.stdout, testResult.stderr);

  // Classify the parse result so consumers can distinguish "ran 0 tests" from
  // "we ran tests but couldn't read the result" (silent-no-op). See issue #456.
  // - "ok":           parser matched a known summary pattern.
  // - "unrecognised": test command exited 0 but no known summary line appeared
  //                   (silent-no-op shape — informational consumers should warn).
  // - "errored":      test command exited non-zero. Standard failure mode; the
  //                   exitCode + stderr already carry the signal.
  // - "not-run":      test command was not found (exitCode 127).
  let testParseStatus: "ok" | "unrecognised" | "errored" | "not-run";
  if (testResult.exitCode === 127) {
    testParseStatus = "not-run";
  } else if (testResult.exitCode !== 0) {
    testParseStatus = "errored";
  } else if (!testCounts.recognised) {
    testParseStatus = "unrecognised";
  } else {
    testParseStatus = "ok";
  }

  return {
    branch: branchResult.stdout.trim(),
    headCommit: headResult.stdout.trim(),
    recentCommits: logResult.stdout.trim().split("\n").filter(Boolean),
    dirtyFiles: statusResult.stdout.trim().split("\n").filter(Boolean),
    fileTree: lsFilesResult.stdout.trim(),
    fileCount: lsFilesResult.stdout.trim().split("\n").filter(Boolean).length,

    testReport: {
      ran: testResult.exitCode !== 127, // 127 = command not found
      exitCode: testResult.exitCode,
      stdout: testResult.stdout,
      stderr: testResult.stderr,
      passed: testCounts.passed,
      failed: testCounts.failed,
      total: testCounts.total,
      // testParseStatus distinguishes recognised output from silent-no-op runs.
      // A 0-exit command whose output matched no vitest/jest summary pattern
      // is `unrecognised` — consumers should render this as a warning rather
      // than "0 tests ran". See issue #456 (post-PR-400 reframe).
      parseStatus: testParseStatus,
      recognised: testCounts.recognised,
      durationMs: testResult.durationMs,
    },

    typecheckReport: {
      ran: tscResult.exitCode !== 127,
      exitCode: tscResult.exitCode,
      stdout: tscResult.stdout,
      stderr: tscResult.stderr,
      durationMs: tscResult.durationMs,
    },

    failingTests,

    recentDiffs: diffStatResult.stdout,

    // TODO/FIXME markers — known gaps and tech debt
    todoMarkers: todoResult.exitCode === 0
      ? todoResult.stdout.trim().split("\n").filter(Boolean).slice(0, 20)
      : [],

    // README summary
    readme: typeof readmeContent === "string" ? readmeContent.slice(0, 2000) : "",

    packageJson: pkgResult,

    timestamp,
    groundingDurationMs: Date.now() - timestamp,
  };
}

/**
 * Summarize a grounding report into a concise string for agent prompts.
 * This replaces the old getProjectState() output.
 */
export function summarizeForPrompt(report,  opts: Record<string, any> = {}) {
  const parts = [];

  parts.push(`## Current Repository State (grounded at ${new Date(report.timestamp).toISOString()})`);
  parts.push(`Branch: ${report.branch}`);
  parts.push(`HEAD: ${report.headCommit}`);
  parts.push(`Files: ${report.fileCount}`);

  // Tests — the most critical grounding signal
  if (report.testReport.ran) {
    const t = report.testReport;
    if (t.failed > 0) {
      parts.push(`\n### TESTS: ${t.passed} passing, ${t.failed} FAILING`);
      if (report.failingTests.length > 0) {
        parts.push(`Failing tests:`);
        for (const f of report.failingTests) {
          parts.push(`  - ${f}`);
        }
      }
      parts.push(`\nFailing test output (last 2000 chars):`);
      parts.push(t.stderr.slice(-2000) || t.stdout.slice(-2000));
    } else if (t.parseStatus === "unrecognised") {
      // Silent-no-op shape — npm test exited 0 but the parser found no
      // recognised summary line. Surface this explicitly so consumers don't
      // mistake "0 tests ran" for "we couldn't read the result" (issue #456).
      parts.push(`\n### TESTS: parse status = UNRECOGNISED (exit 0, no vitest/jest summary line)`);
      parts.push(`Last 1000 chars of stdout:`);
      parts.push((t.stdout || "").slice(-1000));
    } else {
      parts.push(`\n### TESTS: ${t.passed} passing, 0 failing (${t.durationMs}ms)`);
    }
  } else {
    parts.push(`\n### TESTS: Could not run tests`);
  }

  // Typecheck
  if (report.typecheckReport.ran) {
    const tc = report.typecheckReport;
    if (tc.exitCode === 0) {
      parts.push(`\n### TYPECHECK: Clean`);
    } else {
      parts.push(`\n### TYPECHECK: ERRORS`);
      parts.push(tc.stderr.slice(-1000) || tc.stdout.slice(-1000));
    }
  }

  // Dirty files
  if (report.dirtyFiles.length > 0) {
    parts.push(`\n### Uncommitted changes:`);
    for (const f of report.dirtyFiles.slice(0, 10)) {
      parts.push(`  ${f}`);
    }
  }

  // Recent commits
  parts.push(`\n### Recent commits:`);
  for (const c of report.recentCommits.slice(0, 10)) {
    parts.push(`  ${c}`);
  }

  // File tree (truncated — keep short for planner/skeptic, executor reads files directly)
  const files = report.fileTree.split("\n").filter(Boolean);
  const fileLimit = opts?.compact ? 15 : 30;
  parts.push(`\n### File tree (${files.length} files):`);
  for (const f of files.slice(0, fileLimit)) {
    parts.push(`  ${f}`);
  }
  if (files.length > fileLimit) {
    parts.push(`  ... (${files.length - fileLimit} more)`);
  }

  // TODO/FIXME markers — known gaps
  if (report.todoMarkers?.length > 0) {
    const todoLimit = opts?.compact ? 5 : 10;
    parts.push(`\n### TODO/FIXME markers (${report.todoMarkers.length} found):`);
    for (const t of report.todoMarkers.slice(0, todoLimit)) {
      parts.push(`  ${t}`);
    }
    if (report.todoMarkers.length > todoLimit) {
      parts.push(`  ... (${report.todoMarkers.length - todoLimit} more)`);
    }
  }

  return parts.join("\n");
}

/**
 * Internal helpers exposed for regression tests only. Not part of the public
 * API — external modules should use groundProject() / summarizeForPrompt()
 * instead.
 */
export const _testing = { truncate, stripAnsi, parseTestCounts, parseFailingTests, runCmd };
