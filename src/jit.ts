/**
 * jit.ts — JIT (Just-in-Time) test generation
 *
 * Extracted from verification.ts (issue #161).
 *
 * Exports:
 *   - runJitTests()          — run JIT test generation for a diff
 *   - buildJitPrompt()       — build prompt for JIT model
 *   - parseJitResult()       — parse model response
 *   - summarizeJitTests()    — format report for logging
 *   - JitTestResult type     — result shape
 */

import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { getTracker } from "./task-tracker.ts";
import { recordOutcome } from "./learning.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { fail } from "./backlog.ts";
import { cleanupBrokenBranch, PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JIT_TEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Prompt builder
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

// ---------------------------------------------------------------------------
// Result parser
// ---------------------------------------------------------------------------

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
// Main runner
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
      model: "local",
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
            await execFileAsync("git", ["commit", "-m", `test: add JiT regression test \u2014 ${testDef.description || basename(testDef.filename)}`], {
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

// ---------------------------------------------------------------------------
// Summarizer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pipeline orchestration — mutation-aware JIT (step 6.8)
// ---------------------------------------------------------------------------

/**
 * Generate tests targeting surviving mutants when kill rate is below 80%.
 *
 * If new tests pass, returns the updated verification. Otherwise returns
 * the original verification unchanged. Never throws.
 *
 * @param runVerification — verification runner callback (injected from verification.ts)
 */
export async function runMutationAwareJitTests(
  ctx: CycleContext, task: any, verification: any, verificationPlan: any[],
  mutationReport: any, taskId: string,
  runVerification: (projectDir: string, plan: any[]) => Promise<any>,
): Promise<any> {
  const { cycleId } = ctx;
  const tracker = getTracker();

  const testable = mutationReport.totalMutants - mutationReport.skipped;
  const killRate = testable > 0 ? Math.round((mutationReport.killed / testable) * 100) : 100;

  if (killRate >= 80) return verification;

  console.log(`[ControlLoop] Step 6.8: Generating diff-aware tests for ${mutationReport.survived} surviving mutants...`);
  try {
    const survivorDetails = mutationReport.survivors.slice(0, 5).map((s: any) =>
      `- ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]: ${s.mutation.description || "mutation survived"}`
    ).join("\n");

    const jitPrompt = [
      `## GENERATE TESTS FOR UNCOVERED CODE`,
      ``,
      `The executor just implemented: "${task.title}"`,
      `Mutation testing found ${mutationReport.survived} surviving mutants — the existing tests don't cover these code paths.`,
      ``,
      `### Surviving mutants (tests needed for these):`,
      survivorDetails,
      ``,
      `### Changed files:`,
      verification.filesChanged.map((f: string) => `- ${f}`).join("\n"),
      ``,
      `## YOUR JOB`,
      `Write tests that would FAIL if these mutations were applied. Each test should:`,
      `1. Target a specific surviving mutant`,
      `2. Assert the correct behavior that the mutation would break`,
      `3. Follow the project's existing test patterns`,
      ``,
      `Do NOT modify implementation code. Only add/modify test files.`,
      `Run \`npm test\` after writing tests to verify they pass.`,
      `Commit with message: "test: add diff-aware tests for [description]"`,
      ``,
      `Output JSON: { "summary": "what tests you added", "filesChanged": [...], "testsAdded": N }`,
    ].join("\n");

    const jitPersonality = await findPersonality("executor");
    const jitResult = await runAgent({
      agentName: "jit-tester",
      personality: jitPersonality,
      prompt: jitPrompt,
      model: "codex",
      taskId: `${taskId}-jit`,
      correlationId: cycleId,
      workDir: PROJECT_WORKSPACE,
    });

    await tracker.logAgentRun(cycleId, "jit-tester", taskId, jitResult.duration, jitResult.exitCode === 0 ? "tests-generated" : "generation-failed", jitResult.usage, jitResult.costUsd);
    console.log(`[ControlLoop] JIT test generation: ${Math.round(jitResult.duration / 1000)}s, exit ${jitResult.exitCode}`);

    // Re-verify after adding tests
    if (jitResult.exitCode === 0) {
      console.log(`[ControlLoop] Re-verifying after JIT test generation...`);
      const jitVerification = await runVerification(PROJECT_WORKSPACE, verificationPlan);
      if (!jitVerification.allPassed) {
        console.log(`[ControlLoop] JIT tests introduced failures — reverting test changes`);
        try {
          await execFileAsync("git", ["checkout", "HEAD~1", "--", "."], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
        } catch { /* intentional: revert best-effort */ }
      } else {
        console.log(`[ControlLoop] JIT tests pass — included in merge`);
        return jitVerification;
      }
    }
  } catch (err: any) {
    console.error(`[ControlLoop] JIT test generation failed (non-fatal): ${err.message}`);
  }

  return verification;
}

// ---------------------------------------------------------------------------
// Pipeline orchestration — diff-aware JIT (step 6.85)
// ---------------------------------------------------------------------------

/**
 * Generate adversarial regression tests from the raw diff. Blocks merge
 * if a generated test catches a bug.
 *
 * Never throws — returns { report, earlyReturn?, updatedVerification? }.
 *
 * @param runVerification — verification runner callback (injected from verification.ts)
 */
export async function runDiffAwareJitTests(
  ctx: CycleContext, task: any, verification: any, verificationPlan: any[],
  diff: string, execResult: any, complexity: string, filesInScope: number,
  criteriaCount: number, taskId: string,
  runVerification: (projectDir: string, plan: any[]) => Promise<any>,
  // Issue #212: thread mutationReport through so JIT bug-catch path can record
  // mutation metrics (mutationsTested, killed, survived) alongside gateBlocked.
  mutationReport: any = null,
): Promise<{ report: any; earlyReturn?: any; updatedVerification?: any }> {
  const { cycleId, startTime, grounding, ovSession, eventBus, anchor } = ctx;
  const tracker = getTracker();

  console.log(`[ControlLoop] Step 6.85: Running JiT test generation on diff...`);
  try {
    const jitReport = await runJitTests(
      PROJECT_WORKSPACE,
      diff,
      verification.filesChanged,
      task.title,
      cycleId,
      taskId,
    );
    console.log(`[ControlLoop] JiT tests: ${jitReport.generated} generated, ${jitReport.kept} kept, ${jitReport.discarded} discarded${jitReport.caughtBug ? " — BUG DETECTED" : ""}`);

    if (jitReport.caughtBug) {
      console.error(`[ControlLoop] JIT GATE: generated test caught a bug — blocking merge`);
      console.error(`[ControlLoop] Bug details: ${jitReport.bugDetails?.slice(0, 300)}`);
      await tracker.transitionTask(taskId, "failed", { reason: `JiT test caught bug: ${jitReport.bugDetails?.slice(0, 200)}` });
      await recordOutcome({
        agents: ["planner"],
        cycleId, task, finalState: "failed",
        anchorRef: anchor.reference, anchorType: anchor.type,
        context: { failReason: "JiT test caught a regression bug", failedSteps: ["jit-testing"] },
      });
      await fail(anchor.reference, "JiT test caught bug", { eventBus, cycleId });

      await cleanupBrokenBranch(PROJECT_WORKSPACE);
      await reportOutcome(anchor, { status: "failed", reason: `JiT test caught bug: ${jitReport.bugDetails?.slice(0, 200)}`, verification, taskId });
      await ovSession.logOutcome("failed", `JiT test caught bug: ${jitReport.bugDetails?.slice(0, 200)}`);
      await ovSession.commit();
      await recordCycleMetrics(cycleId, {
        tasksAttempted: 1, tasksFailed: 1, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
        testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
        testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
        filesChanged: verification.filesChanged.length, totalDurationMs: Date.now() - startTime,
        groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: verification.totalDurationMs,
        regressionIntroduced: false, taskTitle: task.title,
        anchorType: task.anchorType, anchorReference: task.anchorReference,
        complexity, filesInScope, criteriaCount,
        plannerModel: task.__plannerModel || "unknown",
        executorModel: execResult?.__executorModel || "unknown",
        jitTestsGenerated: jitReport.generated,
        jitTestsKept: jitReport.kept,
        jitTestsCaughtBug: 1,
        // Quality gate trend fields (issue #212): JIT bug-catch is a gate block
        gateBlocked: 1,
        mutationsTested: mutationReport ? (mutationReport.totalMutants - (mutationReport.skipped || 0)) : 0,
        mutationKilled: mutationReport?.killed ?? 0,
        mutationSurvived: mutationReport?.survived ?? 0,
      });
      return {
        report: jitReport,
        earlyReturn: {
          cycleId,
          tasks: [{ taskId, finalState: "failed", reason: `JiT test caught bug` }],
          durationMs: Date.now() - startTime,
        },
      };
    }

    // If JiT tests were kept, re-verify
    if (jitReport.kept > 0) {
      console.log(`[ControlLoop] Re-verifying after JiT test generation (${jitReport.kept} tests added)...`);
      const jitVerification = await runVerification(PROJECT_WORKSPACE, verificationPlan);
      if (!jitVerification.allPassed) {
        console.log(`[ControlLoop] JiT tests caused verification failure — reverting JiT test commits`);
        for (let i = 0; i < jitReport.kept; i++) {
          try {
            await execFileAsync("git", ["revert", "--no-edit", "HEAD"], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
          } catch { /* intentional: revert best-effort */ }
        }
        jitReport.kept = 0;
        jitReport.discarded = jitReport.generated;
      } else {
        return { report: jitReport, updatedVerification: jitVerification };
      }
    }

    return { report: jitReport };
  } catch (err: any) {
    console.error(`[ControlLoop] JiT test generation failed (non-fatal): ${err.message}`);
    return { report: null };
  }
}
