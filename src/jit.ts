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
import { execWithGroupCleanup } from "./exec-with-timeout.ts";
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

/**
 * Per-discard-reason counters (issue #299).
 *
 * When a generated JIT test cannot be kept, we classify why so dashboards and
 * prompt-tuning can attribute the failure mode instead of just seeing "all
 * discarded". Categories are mutually exclusive — each discarded test
 * increments exactly one counter.
 *
 *   - import_error    : test referenced a module that could not be resolved
 *                       (Cannot find module / ERR_MODULE_NOT_FOUND / etc).
 *                       Primary failure mode per #299 telemetry and the only
 *                       category that triggers the one-shot retry path.
 *   - compile_error   : SyntaxError or TypeScript strip-types failure.
 *   - runtime_error   : non-assertion, non-import failure (TypeError,
 *                       timeout, non-zero exit without a recognisable message).
 *   - generation_empty: the test file could not be written to disk
 *                       (writeFile threw). Rare but observable.
 */
export type JitDiscardReasons = {
  import_error: number;
  compile_error: number;
  runtime_error: number;
  generation_empty: number;
};

export type JitTestResult = {
  generated: number;
  kept: number;
  discarded: number;
  caughtBug: boolean;
  bugDetails: string | null;
  testFiles: string[];
  durationMs: number;
  error: string | null;
  /**
   * Per-discard-reason counters (issue #299). Always present even when
   * discarded === 0 (all-zero object) so callers don't need null checks.
   */
  discardReasons: JitDiscardReasons;
  /**
   * Whether the one-shot retry path was attempted (issue #299). True when an
   * initial generation produced at least one import_error and a re-prompt
   * was issued with the failure context injected.
   */
  retried: boolean;
  /**
   * Operator-facing summary of what JIT decided this cycle.
   * Examples (issue #235; #299 adds the discard-reason suffix):
   *   - "skipped: kill-rate >= 80%"
   *   - "skipped: quick-fix"
   *   - "skipped: no diff"
   *   - "skipped: no files changed"
   *   - "skipped: no surviving mutants"
   *   - "ran: 3 tests added"
   *   - "ran: 0 tests, no testable behavior"
   *   - "ran: 0 tests, all 2 discarded (import_error)"
   *   - "ran: bug detected — merge blocked"
   *   - "error: <message>"
   * Always present so dashboards can render it without null checks.
   */
  decision: string;
};

/**
 * Build a zeroed JitDiscardReasons object (issue #299). Exported so call
 * sites that synthesise JitTestResult instances (skips, errors, fixtures)
 * don't need to remember the field list.
 */
export function emptyDiscardReasons(): JitDiscardReasons {
  return {
    import_error: 0,
    compile_error: 0,
    runtime_error: 0,
    generation_empty: 0,
  };
}

/**
 * Classify a failing JIT test run from its captured output (issue #299).
 *
 * Order matters: import-resolution failures are checked before generic
 * SyntaxError because ERR_MODULE_NOT_FOUND surfaces as SyntaxError-shaped
 * traces on some Node versions but is conceptually a missing-module failure.
 *
 * Assertion-failure cases are handled by the caller before classification
 * runs (caughtBug path) — this function only runs on the discard path.
 *
 * Pure function — exported for unit testing.
 */
export function classifyJitDiscard(
  output: string,
  exitCode: number,
  timedOut: boolean,
): keyof JitDiscardReasons {
  const text = output || "";
  // Import resolution failures — primary failure mode per #299 telemetry.
  if (
    text.includes("Cannot find module") ||
    text.includes("ERR_MODULE_NOT_FOUND") ||
    text.includes("Cannot find package") ||
    text.includes("ERR_UNSUPPORTED_DIR_IMPORT")
  ) {
    return "import_error";
  }
  // TS strip-types / parse failures.
  if (
    text.includes("SyntaxError") ||
    text.includes("Unexpected token") ||
    text.includes("TransformError") ||
    text.includes("ERR_INVALID_TYPESCRIPT_SYNTAX")
  ) {
    return "compile_error";
  }
  // Anything else that exited non-zero (or timed out) is a runtime issue.
  if (timedOut || exitCode !== 0) {
    return "runtime_error";
  }
  // Defensive default — shouldn't reach here in the discard path.
  return "runtime_error";
}

/**
 * Return the top discard reason for a decision-string suffix (issue #299).
 *
 * Used to annotate `decision` like `"ran: 0 tests, all 2 discarded
 * (import_error)"`. Returns `null` when counters are all zero.
 *
 * Tie-break: order in the reasons array (import_error first) — matches
 * operator intuition that import errors are the loudest actionable signal.
 *
 * Pure function — exported for unit testing.
 */
export function topDiscardReason(reasons: JitDiscardReasons): keyof JitDiscardReasons | null {
  const order: Array<keyof JitDiscardReasons> = [
    "import_error",
    "compile_error",
    "runtime_error",
    "generation_empty",
  ];
  let best: keyof JitDiscardReasons | null = null;
  let bestCount = 0;
  for (const k of order) {
    const c = reasons[k] || 0;
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Synthetic JIT skip decisions (issue #235) — used at call sites that gate
 * JIT off entirely so the cycle still records an observable reason.
 */
export const JIT_SKIP_QUICK_FIX = "skipped: quick-fix";
export const JIT_SKIP_NO_DIFF = "skipped: no diff";
export const JIT_SKIP_NO_FILES_CHANGED = "skipped: no files changed";
export const JIT_SKIP_KILL_RATE = "skipped: kill-rate >= 80%";
export const JIT_SKIP_NO_SURVIVING_MUTANTS = "skipped: no surviving mutants";

/**
 * Build a minimal JitTestResult-shaped report for a skip decision (issue #235).
 *
 * Lets non-JIT call sites record an observable `jitDecision` on the cycle
 * report without inventing a parallel mechanism. All counters are zeroed.
 */
export function jitSkipReport(decision: string): JitTestResult {
  return {
    generated: 0,
    kept: 0,
    discarded: 0,
    caughtBug: false,
    bugDetails: null,
    testFiles: [],
    durationMs: 0,
    error: null,
    discardReasons: emptyDiscardReasons(),
    retried: false,
    decision,
  };
}

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

/**
 * Build the retry prompt for the JIT model when the first generation failed
 * with import_error discards (issue #299).
 *
 * Injects the captured failure output so the model can correct relative
 * import paths or missing-module references. Limits the failure context to
 * keep the prompt compact.
 *
 * Pure function — exported for unit testing.
 */
export function buildJitRetryPrompt(
  diff: string,
  changedFiles: string[],
  taskTitle: string,
  failures: Array<{ filename: string; output: string }>,
): string {
  const base = buildJitPrompt(diff, changedFiles, taskTitle);
  const failureLines: string[] = [];
  for (const f of failures.slice(0, 3)) {
    // Trim each failure transcript to the most informative lines so the prompt
    // stays cheap. Real ERR_MODULE_NOT_FOUND traces include the resolved
    // request path which is exactly what the model needs to correct.
    const trimmed = (f.output || "").split("\n")
      .filter((l) => l.includes("Error") || l.includes("Cannot") || l.includes("ERR_") || l.includes("from"))
      .slice(0, 8)
      .join("\n");
    failureLines.push(`### ${f.filename}`);
    failureLines.push("```");
    failureLines.push(trimmed || (f.output || "").slice(0, 400));
    failureLines.push("```");
  }
  return [
    base,
    ``,
    `## RETRY CONTEXT (issue #299)`,
    `Your previous generation was discarded — every test failed to import the`,
    `module under test. The captured failures are below. Common fixes:`,
    `- Use the correct relative path from \`test/\` to \`src/\` (typically \`../src/<file>.ts\`)`,
    `- Include the \`.ts\` extension on local imports (ESM, no extension resolution)`,
    `- Do NOT import private/un-exported symbols — only what the changed file actually exports`,
    `- Do NOT invent module names; only import paths visible in the diff or file list above`,
    ``,
    `### First-attempt failures:`,
    ...failureLines,
    ``,
    `Generate fresh tests in the same JSON shape. Fix the imports.`,
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
    discardReasons: emptyDiscardReasons(),
    retried: false,
    // Default — overwritten before return at every terminal path below (issue #235)
    decision: "ran: 0 tests, no testable behavior",
  };
  // Track import_error failures for the one-shot retry path (issue #299).
  const importErrorContexts: Array<{ filename: string; output: string }> = [];

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
      result.decision = "error: model call failed";
      result.durationMs = Date.now() - start;
      return result;
    }

    // Parse the model response
    const { tests, error } = parseJitResult(agentResult.output);
    if (error) {
      result.error = `Parse error: ${error}`;
      result.decision = `error: parse failed (${error})`;
      result.durationMs = Date.now() - start;
      return result;
    }

    if (tests.length === 0) {
      result.decision = "ran: 0 tests, no testable behavior";
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

        // Run just this test file to check if it passes.
        //
        // Issue #226: use execWithGroupCleanup so a JIT test that hangs (or
        // pulls in tsx/esbuild via the test code itself) cannot leak its
        // grandchildren past JIT_TEST_TIMEOUT_MS. The old execFileAsync
        // only signalled the immediate `node` process and left esbuild
        // --service daemons spinning indefinitely.
        const jitRun = await execWithGroupCleanup(
          "node",
          ["--experimental-strip-types", "--test", testPath],
          {
            cwd: projectDir,
            timeout: JIT_TEST_TIMEOUT_MS,
            env: process.env,
          },
        );

        if (jitRun.exitCode === 0 && !jitRun.timedOut) {
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
        } else {
          // Test failed (or timed out) — check if it caught a real bug or is just bad generation.
          // Issue #226: timeout no longer throws, so we no longer have a thrown error to inspect;
          // jitRun.timedOut + the captured stderr/stdout are equivalent for this heuristic.
          const stderr = jitRun.stderr || "";
          const stdout = jitRun.stdout || "";
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
            // Bad generation — discard. Classify why (issue #299) so dashboards
            // and prompt-tuning can attribute the failure mode instead of just
            // seeing "all discarded".
            result.discarded++;
            const reason = classifyJitDiscard(output, jitRun.exitCode, jitRun.timedOut);
            result.discardReasons[reason]++;
            if (reason === "import_error") {
              importErrorContexts.push({ filename: testDef.filename, output });
            }
            try {
              await unlink(testPath);
            } catch { /* intentional: file may not exist */ }
          }
        }
      } catch (writeErr: any) {
        // Issue #299: classify the write failure as generation_empty so the
        // discard-reason counters stay total.
        console.error(`[JiT] Failed to write test ${testDef.filename}: ${writeErr.message}`);
        result.discarded++;
        result.discardReasons.generation_empty++;
      }
    }

    // One-shot retry path (issue #299): when the first generation produced
    // at least one import_error AND nothing was kept AND no bug was caught,
    // re-prompt the model once with the failure context injected. Import
    // errors are the dominant JIT failure mode per #299 telemetry — usually
    // the model used a wrong relative path or omitted the .ts extension.
    if (
      !result.retried &&
      !result.caughtBug &&
      result.kept === 0 &&
      importErrorContexts.length > 0
    ) {
      result.retried = true;
      console.log(`[JiT] One-shot retry: ${importErrorContexts.length} import_error discard(s), re-prompting with failure context`);
      try {
        const retryPrompt = buildJitRetryPrompt(diff, changedFiles, taskTitle, importErrorContexts);
        const retryPersonality = await findPersonality("executor");
        const retryAgent = await runAgent({
          agentName: "jit-tester",
          personality: retryPersonality,
          prompt: retryPrompt,
          model: "local",
          taskId: `${taskId}-jit-retry`,
          correlationId: cycleId,
          workDir: projectDir,
        });

        if (retryAgent.exitCode === 0 || retryAgent.output) {
          const { tests: retryTests, error: retryParseErr } = parseJitResult(retryAgent.output);
          if (retryParseErr) {
            console.error(`[JiT] Retry parse error: ${retryParseErr}`);
          } else if (retryTests.length > 0) {
            // Retry generation is treated as additional generated tests.
            // Each is fed through the same per-test pipeline; classification
            // accumulates into the same discardReasons counters.
            result.generated += retryTests.length;
            for (const testDef of retryTests) {
              const testPath = join(testDir, basename(testDef.filename));
              try {
                await writeFile(testPath, testDef.code, "utf-8");
                const jitRun = await execWithGroupCleanup(
                  "node",
                  ["--experimental-strip-types", "--test", testPath],
                  { cwd: projectDir, timeout: JIT_TEST_TIMEOUT_MS, env: process.env },
                );
                if (jitRun.exitCode === 0 && !jitRun.timedOut) {
                  result.kept++;
                  result.testFiles.push(testPath);
                  try {
                    await execFileAsync("git", ["add", testPath], { cwd: projectDir, timeout: 5000 });
                    await execFileAsync("git", ["commit", "-m", `test: add JiT regression test (retry) — ${testDef.description || basename(testDef.filename)}`], {
                      cwd: projectDir,
                      timeout: 10000,
                    });
                  } catch (commitErr: any) {
                    console.error(`[JiT] Failed to commit retry test ${testDef.filename}: ${commitErr.message}`);
                  }
                } else {
                  const out = (jitRun.stderr || "") + (jitRun.stdout || "");
                  const isAssertionFailure = out.includes("AssertionError") ||
                    out.includes("Expected") ||
                    out.includes("assert");
                  const isImportError = out.includes("Cannot find module") ||
                    out.includes("ERR_MODULE_NOT_FOUND");
                  if (isAssertionFailure && !isImportError) {
                    result.caughtBug = true;
                    result.bugDetails = `Test "${testDef.description}" failed with assertion error: ${out.slice(0, 500)}`;
                    result.kept++;
                    result.testFiles.push(testPath);
                  } else {
                    result.discarded++;
                    result.discardReasons[classifyJitDiscard(out, jitRun.exitCode, jitRun.timedOut)]++;
                    try { await unlink(testPath); } catch { /* intentional: best-effort cleanup */ }
                  }
                }
              } catch (writeErr: any) {
                console.error(`[JiT] Failed to write retry test ${testDef.filename}: ${writeErr.message}`);
                result.discarded++;
                result.discardReasons.generation_empty++;
              }
            }
          }
        } else {
          console.error(`[JiT] Retry model call failed (exit ${retryAgent.exitCode})`);
        }
      } catch (retryErr: any) {
        console.error(`[JiT] Retry path errored (non-fatal): ${retryErr.message}`);
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

    // Decision string — observable summary of what JIT did this cycle
    // (issue #235; #299 adds the discard-reason suffix and a retry tag).
    if (result.caughtBug) {
      result.decision = "ran: bug detected — merge blocked";
    } else if (result.kept > 0) {
      const retryTag = result.retried ? " (after retry)" : "";
      result.decision = `ran: ${result.kept} test${result.kept === 1 ? "" : "s"} added${retryTag}`;
    } else if (result.generated > 0 && result.discarded === result.generated) {
      const top = topDiscardReason(result.discardReasons);
      const suffix = top ? ` (${top})` : "";
      result.decision = `ran: 0 tests, all ${result.generated} discarded${suffix}`;
    } else if (result.generated === 0) {
      result.decision = "ran: 0 tests, no testable behavior";
    }
  } catch (err: any) {
    result.error = `JiT testing failed: ${err.message}`;
    result.decision = `error: ${err.message}`;
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
    // Issue #299: surface per-reason breakdown so operators can attribute
    // the failure mode instead of seeing a generic message.
    const r = result.discardReasons;
    const breakdown = [
      r.import_error > 0 ? `${r.import_error} import_error` : null,
      r.compile_error > 0 ? `${r.compile_error} compile_error` : null,
      r.runtime_error > 0 ? `${r.runtime_error} runtime_error` : null,
      r.generation_empty > 0 ? `${r.generation_empty} generation_empty` : null,
    ].filter((x): x is string => x !== null).join(", ");
    const detail = breakdown ? ` (${breakdown})` : " (bad generation or import errors)";
    parts.push(`Discarded: ${result.discarded} tests${detail}`);
  }
  if (result.retried) {
    parts.push(`Retry: one-shot retry path was attempted (issue #299)`);
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

    await tracker.logAgentRun(cycleId, "jit-tester", taskId, jitResult.duration, jitResult.exitCode === 0 ? "tests-generated" : "generation-failed", jitResult.usage, jitResult.costUsd, jitResult.model || "codex");
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
        // Issue #235: surface decision string on the bug-catch path too
        jitDecision: jitReport.decision,
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
