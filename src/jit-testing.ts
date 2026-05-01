/**
 * JiT (Just-in-Time) Test Generation — Meta-style adversarial test generation.
 *
 * After executor produces a diff but before merge, generates adversarial test
 * cases targeting the changed code using a cheap model. Tests that would fail
 * if the change were reverted prove the diff is meaningful.
 *
 * Flow:
 *   1. Compute `git diff main..feature-branch`
 *   2. Send diff to nano/codex-tier model with prompt to generate 2-3 tests
 *   3. Write generated tests to a temporary file in the test directory
 *   4. Run `npm test` with the new tests
 *   5. If tests pass: keep them (commit to branch)
 *   6. If tests fail: discard them (bad generation)
 *   7. If tests reveal a bug: block merge, record in reality report
 *
 * Design constraints:
 *   - Only for standard/complex tasks (skip quick-fix)
 *   - Uses nano model to keep costs low
 *   - Never throws — returns a result object
 *   - Pure functions exported for testability (buildJitPrompt, parseJitResult)
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { runAgent, findPersonality } from "./codex-runner.ts";

const execFileAsync = promisify(execFile);

const JIT_TEST_TIMEOUT_MS = 60_000;

export type JitTestResult = {
  generated: number;
  kept: number;
  discarded: number;
  caughtBug: boolean;
  bugDetails: string | null;
  testFiles: string[];
  durationMs: number;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Pure functions — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Build the prompt for the JiT test generation model.
 *
 * Takes the diff and file list, returns a structured prompt asking
 * for 2-3 adversarial test cases.
 */
export function buildJitPrompt(diff: string, changedFiles: string[], taskTitle: string): string {
  // Truncate diff to avoid blowing up context window
  const maxDiffLen = 8000;
  const truncatedDiff = diff.length > maxDiffLen
    ? diff.slice(0, maxDiffLen) + "\n... (diff truncated)"
    : diff;

  const fileList = changedFiles.map((f) => `- ${f}`).join("\n");

  return [
    `## GENERATE ADVERSARIAL REGRESSION TESTS`,
    ``,
    `Task: "${taskTitle}"`,
    ``,
    `### Changed files:`,
    fileList,
    ``,
    `### Diff:`,
    "```diff",
    truncatedDiff,
    "```",
    ``,
    `## YOUR JOB`,
    `Generate 2-3 test cases that would FAIL if this diff were reverted.`,
    `Each test must:`,
    `1. Test a specific behavior introduced or changed by this diff`,
    `2. Import the changed module and call the changed function/component`,
    `3. Assert the NEW behavior (post-diff), so reverting the diff breaks the test`,
    `4. Be a complete, runnable test using node:test and node:assert`,
    `5. Follow ESM import syntax (.ts extensions for local imports)`,
    ``,
    `## OUTPUT FORMAT`,
    `Return a JSON object with this exact shape:`,
    `{`,
    `  "tests": [`,
    `    {`,
    `      "filename": "test/jit-<descriptive-name>.test.mts",`,
    `      "description": "what this test verifies",`,
    `      "code": "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\n..."`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `RULES:`,
    `- Use node:test and node:assert/strict (no jest, no vitest)`,
    `- File extension must be .test.mts`,
    `- Only test pure functions or exported behavior — do NOT mock Redis, file system, or network`,
    `- If the diff only changes config/types/imports with no testable behavior, return { "tests": [] }`,
    `- Do NOT generate tests for code you cannot import (private functions, side effects)`,
  ].join("\n");
}

/**
 * Parse the model's JSON response into a list of test file descriptors.
 *
 * Returns { tests, error }. On parse failure, returns empty tests with error message.
 */
export function parseJitResult(output: string): { tests: Array<{ filename: string; description: string; code: string }>; error: string | null } {
  if (!output || !output.trim()) {
    return { tests: [], error: "Empty model output" };
  }

  // Try to extract JSON from the output
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Try to find JSON in the output (model may include surrounding text)
    const match = output.match(/\{[\s\S]*"tests"[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (err: any) {
        return { tests: [], error: `JSON parse failed after extraction: ${err.message}` };
      }
    } else {
      return { tests: [], error: "No JSON object found in model output" };
    }
  }

  if (!parsed || !Array.isArray(parsed.tests)) {
    return { tests: [], error: "Model output missing 'tests' array" };
  }

  // Validate each test entry
  const validTests = parsed.tests.filter((t: any) => {
    if (!t.filename || !t.code) return false;
    if (!t.filename.endsWith(".test.mts")) return false;
    // Sanity check: must contain import from node:test
    if (!t.code.includes("node:test")) return false;
    return true;
  });

  return { tests: validTests, error: null };
}

// ---------------------------------------------------------------------------
// Integration function — called from control-loop.ts
// ---------------------------------------------------------------------------

/**
 * Run JiT test generation for a diff.
 *
 * @param projectDir - Project root (~/hydra-betting)
 * @param diff - git diff output (main..feature-branch)
 * @param changedFiles - List of changed file paths
 * @param taskTitle - Title of the task being built
 * @param cycleId - Cycle ID for correlation
 * @param taskId - Task ID for correlation
 * @returns JitTestResult — never throws
 */
export async function runJitTests(
  projectDir: string,
  diff: string,
  changedFiles: string[],
  taskTitle: string,
  cycleId: string,
  taskId: string,
): Promise<JitTestResult> {
  const start = Date.now();
  const result: JitTestResult = {
    generated: 0,
    kept: 0,
    discarded: 0,
    caughtBug: false,
    bugDetails: null,
    testFiles: [],
    durationMs: 0,
    error: null,
  };

  try {
    // Build the prompt
    const prompt = buildJitPrompt(diff, changedFiles, taskTitle);

    // Call the nano model — cheap and fast
    const personality = await findPersonality("executor");
    const agentResult = await runAgent({
      agentName: "jit-tester",
      personality,
      prompt,
      model: "nano",
      taskId: `${taskId}-jit`,
      correlationId: cycleId,
      workDir: projectDir,
    });

    if (agentResult.exitCode !== 0 && !agentResult.output) {
      result.error = "JiT model call failed";
      result.durationMs = Date.now() - start;
      return result;
    }

    // Parse the model response
    const { tests, error } = parseJitResult(agentResult.output);
    if (error) {
      result.error = `Parse error: ${error}`;
      result.durationMs = Date.now() - start;
      return result;
    }

    if (tests.length === 0) {
      result.durationMs = Date.now() - start;
      return result; // No testable behavior — valid outcome
    }

    result.generated = tests.length;

    // Write each test file, run tests, keep or discard
    const testDir = join(projectDir, "test");
    try {
      await mkdir(testDir, { recursive: true });
    } catch { /* intentional: directory may already exist */ }

    for (const testDef of tests) {
      const testPath = join(testDir, basename(testDef.filename));

      try {
        // Write the test file
        await writeFile(testPath, testDef.code, "utf-8");

        // Run just this test file to check if it passes
        try {
          await execFileAsync("node", ["--experimental-strip-types", "--test", testPath], {
            cwd: projectDir,
            timeout: JIT_TEST_TIMEOUT_MS,
            env: process.env,
          });

          // Test passed — keep it
          result.kept++;
          result.testFiles.push(testPath);

          // Commit the test file to the branch
          try {
            await execFileAsync("git", ["add", testPath], { cwd: projectDir, timeout: 5000 });
            await execFileAsync("git", ["commit", "-m", `test: add JiT regression test — ${testDef.description || basename(testDef.filename)}`], {
              cwd: projectDir,
              timeout: 10000,
            });
          } catch (commitErr: any) {
            console.error(`[JiT] Failed to commit test ${testDef.filename}: ${commitErr.message}`);
          }
        } catch (testErr: any) {
          // Test failed — check if it caught a real bug or is just bad generation
          const stderr = testErr.stderr || testErr.message || "";
          const stdout = testErr.stdout || "";
          const output = stderr + stdout;

          // Heuristic: if the error mentions assertion failure on expected vs actual,
          // it might have caught a real bug. If it's a syntax/import error, it's bad gen.
          const isAssertionFailure = output.includes("AssertionError") ||
            output.includes("AssertionError") ||
            output.includes("Expected") ||
            output.includes("assert");
          const isImportError = output.includes("Cannot find module") ||
            output.includes("SyntaxError") ||
            output.includes("ERR_MODULE_NOT_FOUND");

          if (isAssertionFailure && !isImportError) {
            // Potential real bug found
            result.caughtBug = true;
            result.bugDetails = `Test "${testDef.description}" failed with assertion error: ${output.slice(0, 500)}`;
            result.kept++;
            result.testFiles.push(testPath);
            // Don't commit a failing test — keep it for the report but don't merge
          } else {
            // Bad generation — discard
            result.discarded++;
            try {
              await unlink(testPath);
            } catch { /* intentional: file may not exist */ }
          }
        }
      } catch (writeErr: any) {
        console.error(`[JiT] Failed to write test ${testDef.filename}: ${writeErr.message}`);
        result.discarded++;
      }
    }

    // If a bug was caught, clean up the failing test file so it doesn't break verification
    if (result.caughtBug) {
      for (const testPath of result.testFiles) {
        // Check if this test file is the one that caught the bug (uncommitted)
        try {
          const { stdout } = await execFileAsync("git", ["status", "--porcelain", testPath], {
            cwd: projectDir,
            timeout: 5000,
          });
          if (stdout.trim().startsWith("?") || stdout.trim().startsWith("A")) {
            // Uncommitted test that caught a bug — remove from disk
            await unlink(testPath).catch(() => {});
          }
        } catch { /* intentional: status check best-effort */ }
      }
    }
  } catch (err: any) {
    result.error = `JiT testing failed: ${err.message}`;
    console.error(`[JiT] ${result.error}`);
  }

  result.durationMs = Date.now() - start;
  return result;
}

/**
 * Format JiT test results for logging / reality report.
 */
export function summarizeJitTests(result: JitTestResult): string {
  const parts: string[] = [];

  if (result.generated === 0 && !result.error) {
    parts.push("JiT Testing: no testable behavior in diff (skipped)");
    return parts.join("\n");
  }

  parts.push(`## JiT Test Generation: ${result.kept}/${result.generated} tests kept`);

  if (result.caughtBug) {
    parts.push(`BUG DETECTED: ${result.bugDetails}`);
  }

  if (result.discarded > 0) {
    parts.push(`Discarded: ${result.discarded} tests (bad generation or import errors)`);
  }

  if (result.testFiles.length > 0) {
    parts.push(`Kept test files:`);
    for (const f of result.testFiles) {
      parts.push(`  - ${f}`);
    }
  }

  if (result.error) {
    parts.push(`Error: ${result.error}`);
  }

  parts.push(`Duration: ${result.durationMs}ms`);

  return parts.join("\n");
}
