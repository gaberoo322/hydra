import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { access } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const STEP_TIMEOUT = 180_000; // 3 min per step
const TOTAL_TIMEOUT = 600_000; // 10 min total
const OUTPUT_LIMIT = 10_000;

function truncate(str, limit = OUTPUT_LIMIT) {
  if (!str || str.length <= limit) return str || "";
  return str.slice(0, limit) + `\n... (truncated, ${str.length} total chars)`;
}

/**
 * Run a single verification step. Never throws.
 */
async function runStep(step, projectDir, timeout = STEP_TIMEOUT) {
  const start = Date.now();
  const { command, expected, label } = step;

  // Parse command into executable + args
  const parts = command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: projectDir,
      timeout,
      env: process.env,
      shell: true,
      maxBuffer: 1024 * 1024 * 5,
    });

    const passed = checkExpectation(expected, 0, stdout, stderr);

    return {
      label,
      command,
      passed,
      exitCode: 0,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      durationMs: Date.now() - start,
      expected,
      actual: passed ? "exit code 0" : "exit code 0 but expectation not met",
    };
  } catch (err) {
    const exitCode = err.status ?? err.code ?? 1;
    const stdout = truncate(err.stdout);
    const stderr = truncate(err.stderr || err.message);
    const passed = checkExpectation(expected, exitCode, stdout, stderr);

    return {
      label,
      command,
      passed,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - start,
      expected,
      actual: `exit code ${exitCode}`,
    };
  }
}

/**
 * Check if the actual result matches the expectation.
 *
 * Supported expectation formats:
 * - "exit code 0" — exitCode === 0
 * - "exit code N" — exitCode === N
 * - "contains X" — stdout contains substring X
 * - "not contains X" — stdout does NOT contain substring X
 */
function checkExpectation(expected, exitCode, stdout, stderr) {
  if (!expected) return exitCode === 0; // default: exit code 0

  const lower = expected.toLowerCase().trim();

  // "exit code N"
  const exitMatch = lower.match(/^exit\s+code\s+(\d+)$/);
  if (exitMatch) return exitCode === parseInt(exitMatch[1]);

  // "contains X"
  const containsMatch = expected.match(/^contains\s+(.+)$/i);
  if (containsMatch) {
    const needle = containsMatch[1];
    return (stdout || "").includes(needle) || (stderr || "").includes(needle);
  }

  // "not contains X"
  const notContainsMatch = expected.match(/^not\s+contains\s+(.+)$/i);
  if (notContainsMatch) {
    const needle = notContainsMatch[1];
    return !(stdout || "").includes(needle) && !(stderr || "").includes(needle);
  }

  // Default: exit code 0
  return exitCode === 0;
}

/**
 * Run a verification plan against the project.
 *
 * @param {string} projectDir - Project root
 * @param {VerificationStep[]} plan - Steps to execute
 * @param {object} opts - { totalTimeoutMs, stepTimeoutMs }
 * @returns {VerificationResult}
 */
export async function runVerification(projectDir, plan, opts = {}) {
  const totalTimeout = opts.totalTimeoutMs || TOTAL_TIMEOUT;
  const stepTimeout = opts.stepTimeoutMs || STEP_TIMEOUT;
  const start = Date.now();

  // Auto-detect app directory (same logic as grounding)
  let appDir = projectDir;
  try {
    await access(join(projectDir, "package.json"));
  } catch {
    for (const sub of ["web", "app", "packages/app"]) {
      try {
        await access(join(projectDir, sub, "package.json"));
        appDir = join(projectDir, sub);
        break;
      } catch {}
    }
  }

  const steps = [];

  for (const step of plan) {
    // Check total timeout
    if (Date.now() - start > totalTimeout) {
      steps.push({
        label: step.label,
        command: step.command,
        passed: false,
        exitCode: -1,
        stdout: "",
        stderr: "Skipped: total verification timeout exceeded",
        durationMs: 0,
        expected: step.expected,
        actual: "skipped (timeout)",
      });
      continue;
    }

    // Normalize step command: if it uses `npm` without `--prefix`, run in appDir
    const normalizedStep = { ...step };
    const cmd = step.command.trim();
    const isNpmCmd = cmd.startsWith("npm ") || cmd.startsWith("npx ");
    const hasPrefix = cmd.includes("--prefix");
    const hasCd = cmd.startsWith("cd ");
    const runDir = (isNpmCmd && !hasPrefix && !hasCd) ? appDir : projectDir;

    const result = await runStep(normalizedStep, runDir, stepTimeout);
    steps.push(result);
  }

  // Get diff summary for the report
  let diffSummary = "";
  let filesChanged = [];
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat", "main"], {
      cwd: projectDir,
      timeout: 10000,
    });
    diffSummary = stdout.trim();
    filesChanged = stdout
      .split("\n")
      .filter((l) => l.includes("|"))
      .map((l) => l.split("|")[0].trim());
  } catch {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD~1"], {
        cwd: projectDir,
        timeout: 10000,
      });
      diffSummary = stdout.trim();
      filesChanged = stdout
        .split("\n")
        .filter((l) => l.includes("|"))
        .map((l) => l.split("|")[0].trim());
    } catch {}
  }

  return {
    allPassed: steps.every((s) => s.passed),
    steps,
    diffSummary,
    filesChanged,
    totalDurationMs: Date.now() - start,
  };
}

/**
 * Default verification plan for a typical Node.js/Next.js project.
 */
export function defaultVerificationPlan() {
  return [
    { command: "npm test", expected: "exit code 0", label: "tests" },
    { command: "npm run typecheck", expected: "exit code 0", label: "typecheck" },
    { command: "npm run build", expected: "exit code 0", label: "build" },
  ];
}

/**
 * Validate that a git diff exists (actual code changes were made).
 * Used to gate the transition from in-progress to changed-code.
 *
 * @param {string} projectDir
 * @param {string} baseBranch - Branch to diff against (default: main)
 * @returns {boolean}
 */
export async function validateDiffExists(projectDir, baseBranch = "main") {
  try {
    // Check for uncommitted changes
    const { stdout: status } = await execFileAsync("git", ["status", "--short"], {
      cwd: projectDir,
      timeout: 5000,
    });
    if (status.trim()) return true;

    // Check for committed changes vs base branch
    const { stdout: diff } = await execFileAsync("git", ["diff", "--stat", baseBranch], {
      cwd: projectDir,
      timeout: 10000,
    });
    return diff.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Summarize a verification result for agent prompts or reports.
 */
export function summarizeVerification(result) {
  const parts = [];
  parts.push(`## Verification Result: ${result.allPassed ? "ALL PASSED" : "FAILURES DETECTED"}`);

  for (const step of result.steps) {
    const icon = step.passed ? "PASS" : "FAIL";
    parts.push(`\n### [${icon}] ${step.label}: \`${step.command}\``);
    parts.push(`Exit code: ${step.exitCode} | Duration: ${step.durationMs}ms`);
    parts.push(`Expected: ${step.expected} | Actual: ${step.actual}`);
    if (!step.passed && step.stderr) {
      parts.push(`Error output:\n${step.stderr.slice(0, 1000)}`);
    }
  }

  if (result.filesChanged.length > 0) {
    parts.push(`\n### Files changed: ${result.filesChanged.length}`);
    for (const f of result.filesChanged) {
      parts.push(`  ${f}`);
    }
  }

  return parts.join("\n");
}
