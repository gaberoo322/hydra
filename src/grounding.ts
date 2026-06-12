import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CMD_TIMEOUT, runCmd } from "./grounding-cmd.ts";
import { parseTestCounts, parseFailingTests } from "./grounding-parser.ts";

/**
 * Deep repo inspection. Returns structured evidence about the project.
 *
 * @param {string} projectDir - Path to the target project
 * @param {object} opts - { focusPaths?: string[], testCmd?: string }
 * @returns {GroundingReport}
 */
export async function groundProject(projectDir: string, opts: Record<string, any> = {}) {
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
 *
 * Module-private: nothing outside this file consumes it any longer. Kept (not
 * deleted) as the canonical report→prompt formatter colocated with
 * groundProject(); demoted from `export` to clear a knip unused-export finding
 * (issue #1589). Read-only — formats a report, never touches the workspace.
 */
function summarizeForPrompt(report: any, opts: Record<string, any> = {}) {
  const parts: string[] = [];

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
