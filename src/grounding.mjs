import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CMD_TIMEOUT = 120_000; // 2 min per command
const OUTPUT_LIMIT = 10_000; // truncate stdout/stderr to 10KB

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
async function runCmd(cmd, args, opts = {}) {
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
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout,
      env: childEnv,
      maxBuffer: 1024 * 1024 * 5, // 5MB
    });
    return {
      exitCode: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      exitCode: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? 1 : (err.status ?? err.code ?? 1),
      stdout: truncate(err.stdout),
      stderr: truncate(err.stderr || err.message),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Parse vitest/jest output for pass/fail counts.
 * Looks for patterns like "Tests  42 passed (42)" or "42 passed | 2 failed".
 */
function parseTestCounts(stdout, stderr) {
  // Strip ANSI codes first — see stripAnsi() docs above.
  const combined = stripAnsi((stdout || "") + "\n" + (stderr || ""));
  let passed = 0, failed = 0, total = 0;

  // Vitest outputs two lines: "Test Files  43 passed (43)" and "Tests  352 passed (352)"
  // We want the "Tests" line (individual test count), not "Test Files" (file count)
  const testsLineMatch = combined.match(/^\s*Tests\s+(\d+)\s+passed/m);
  const testsFailMatch = combined.match(/^\s*Tests\s+.*?(\d+)\s+failed/m);
  if (testsLineMatch) passed = parseInt(testsLineMatch[1]);
  if (testsFailMatch) failed = parseInt(testsFailMatch[1]);

  // Fallback: generic "N passed" if the vitest-specific pattern didn't match
  if (passed === 0) {
    const genericPass = combined.match(/(\d+)\s+passed/);
    if (genericPass) passed = parseInt(genericPass[1]);
  }
  if (failed === 0) {
    const genericFail = combined.match(/(\d+)\s+failed/);
    if (genericFail) failed = parseInt(genericFail[1]);
  }

  total = passed + failed;

  // Try "Test Suites: X passed, Y total" (jest)
  if (total === 0) {
    const jestMatch = combined.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
    if (jestMatch) {
      passed = parseInt(jestMatch[1]);
      total = parseInt(jestMatch[2]);
      failed = total - passed;
    }
  }

  return { passed, failed, total };
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
export async function groundProject(projectDir, opts = {}) {
  const timestamp = Date.now();
  const testCmd = opts.testCmd || "npm";

  // Cleanup: ensure we're on main, discard modified tracked files, and delete stale feature branches
  // NOTE: Do NOT run git clean -fd here — it deletes untracked new files before they can be committed
  try {
    await runCmd("git", ["checkout", "main"], { cwd: projectDir, timeout: 5000 });
    await runCmd("git", ["checkout", "."], { cwd: projectDir, timeout: 5000 });
    const { stdout: branches } = await runCmd("git", ["branch", "--list", "feature/*"], { cwd: projectDir, timeout: 5000 });
    const stale = branches.trim().split("\n").map(b => b.trim()).filter(Boolean);
    for (const branch of stale) {
      await runCmd("git", ["branch", "-D", branch], { cwd: projectDir, timeout: 5000 });
    }
    if (stale.length > 0) console.log(`[Grounding] Cleaned up ${stale.length} stale feature branches`);
  } catch {}
  const testArgs = opts.testArgs || ["test"];

  // Detect app directory — some projects have code in a subdirectory (e.g., web/)
  let appDir = projectDir;
  try {
    await readFile(join(projectDir, "package.json"), "utf-8");
  } catch {
    // No package.json at root — check common subdirs
    for (const sub of ["web", "app", "packages/app"]) {
      try {
        await readFile(join(projectDir, sub, "package.json"), "utf-8");
        appDir = join(projectDir, sub);
        break;
      } catch {}
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
 * Get the diff between current state and a reference.
 */
export async function getDiff(projectDir, ref = "HEAD~1") {
  const result = await runCmd("git", ["diff", ref], { cwd: projectDir, timeout: 15000 });
  return result.stdout;
}

/**
 * Get the diff stat (summary) between current state and a reference.
 */
export async function getDiffStat(projectDir, ref = "HEAD~1") {
  const result = await runCmd("git", ["diff", "--stat", ref], { cwd: projectDir, timeout: 10000 });
  return result.stdout;
}

/**
 * Summarize a grounding report into a concise string for agent prompts.
 * This replaces the old getProjectState() output.
 */
export function summarizeForPrompt(report, opts = {}) {
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
