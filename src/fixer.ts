/**
 * fixer.ts — Fixability classification + fixer agent orchestration
 *
 * Extracted from verification.ts (issue #161).
 *
 * Exports:
 *   - isFixableFailure()   — classify whether failures are fixable
 *   - runFixerAttempt()     — run fixer agent and re-verify
 *   - UNFIXABLE_PATTERNS   — exposed for testing
 *   - FIXABLE_PATTERNS     — exposed for testing
 */

import { runAgent, findPersonality } from "./codex-runner.ts";
import { getTracker } from "./task-tracker.ts";
import { PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

// =========================================================================
// Fixability classifier — pure function, no side effects
// =========================================================================

/**
 * Unfixable stderr patterns — these indicate structural problems
 * that a fixer agent cannot resolve in a single pass.
 */
export const UNFIXABLE_PATTERNS: Array<{ pattern: RegExp; category: string; reason: string }> = [
  { pattern: /Cannot find module/i, category: "missing-module", reason: "Missing module — requires install or architectural change" },
  { pattern: /circular dependency/i, category: "circular-dependency", reason: "Circular dependency — requires architectural refactor" },
  { pattern: /Maximum call stack/i, category: "stack-overflow", reason: "Stack overflow — likely infinite recursion" },
  { pattern: /out of memory/i, category: "out-of-memory", reason: "Out of memory — cannot be fixed by code changes" },
  { pattern: /ENOENT/, category: "missing-file", reason: "Missing file or directory (ENOENT)" },
  { pattern: /EPERM/, category: "permission-error", reason: "Permission denied (EPERM)" },
  { pattern: /Cannot read properties of undefined/i, category: "undefined-access", reason: "Undefined property access — likely missing dependency or wrong API shape" },
];

/**
 * Fixable stderr patterns — if any of these match, the failure is likely
 * fixable by the fixer agent.
 */
export const FIXABLE_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /(?:AssertionError|assert\.|toBe|toEqual|not equal|deepEqual|\bExpected\b.*\bgot\b|\bexpected\b.*\bto\b)/i, category: "test-expectation" },
  { pattern: /(?:has no exported member|is not exported|cannot find name)/i, category: "import-error" },
  { pattern: /(?:Module build failed|Failed to compile|Build error)/i, category: "build-error" },
  { pattern: /(?:Type\s+'[^']+'\s+is not assignable|Type error|TS\d{4})/i, category: "type-error" },
];

/**
 * Classify whether a set of failed verification steps are fixable by the fixer agent.
 *
 * Returns { fixable, reason, category }. Defaults to fixable if no unfixable
 * pattern matched (conservative — don't skip when unsure).
 */
export function isFixableFailure(steps: any[]): { fixable: boolean; reason: string; category: string } {
  const failedSteps = steps.filter((s: any) => !s.passed);
  if (failedSteps.length === 0) {
    return { fixable: true, reason: "no failed steps", category: "none" };
  }

  // Combine all stderr/stdout from failed steps for pattern matching
  const combinedOutput = failedSteps
    .map((s: any) => `${s.stderr || ""}\n${s.stdout || ""}`)
    .join("\n");

  // Check unfixable patterns first — any match means skip fixer
  for (const { pattern, category, reason } of UNFIXABLE_PATTERNS) {
    if (pattern.test(combinedOutput)) {
      return { fixable: false, reason, category };
    }
  }

  // Check fixable patterns — if matched, return the specific category
  for (const { pattern, category } of FIXABLE_PATTERNS) {
    if (pattern.test(combinedOutput)) {
      return { fixable: true, reason: `Matched fixable pattern: ${category}`, category };
    }
  }

  // Default: fixable (conservative — don't skip when unsure)
  return { fixable: true, reason: "No unfixable pattern detected (default: fixable)", category: "unknown" };
}

/**
 * Run the fixer agent and re-verify.
 *
 * @param ctx - Cycle context
 * @param task - Planner task
 * @param verification - Current (failed) verification result
 * @param verificationPlan - Steps to re-run
 * @param runVerification - Verification runner function (injected to avoid circular dep)
 * @param taskId - Task identifier
 * @returns Updated verification result after fixer + re-verify
 */
export async function runFixerAttempt(
  ctx: CycleContext, task: any, verification: any, verificationPlan: any[],
  runVerification: (projectDir: string, plan: any[]) => Promise<any>,
  taskId: string,
): Promise<any> {
  const { cycleId, ovSession } = ctx;
  const tracker = getTracker();

  const failedSteps = verification.steps.filter((s: any) => !s.passed);
  const failedLabels = failedSteps.map((s: any) => s.label);
  console.log(`[ControlLoop] Verification FAILED: ${failedLabels.join(", ")} — running fixer agent`);

  const errorDetails = failedSteps.map((s: any) => {
    const stderr = (s.stderr || "").trim();
    const stdout = (s.stdout || "").trim();
    const output = stderr || stdout;
    return `### ${s.label} (${s.command})\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\``;
  }).join("\n\n");

  const fixerPrompt = [
    `## FIX VERIFICATION ERRORS`,
    ``,
    `The executor just wrote code for: "${task.title}"`,
    `Verification ran and these steps FAILED:`,
    ``,
    errorDetails,
    ``,
    `## YOUR JOB`,
    `Fix ONLY the errors shown above. Do not refactor, do not add features, do not change anything unrelated.`,
    ``,
    `Common fixes:`,
    `- Test failures: update test expectations to match the new behavior, or fix the implementation bug`,
    `- TypeScript errors: add missing types, fix type mismatches`,
    `- Build errors: fix import paths, add missing exports, mark server-only pages as dynamic`,
    ``,
    `After fixing:`,
    `1. Run \`npm test\` to verify tests pass`,
    `2. Run \`npm run typecheck\` to verify no type errors`,
    `3. Run \`npm run build\` to verify build succeeds`,
    `4. Commit your fixes with a clear message`,
    ``,
    `Output JSON: { "summary": "what you fixed", "filesChanged": [...] }`,
  ].join("\n");

  const fixerPersonality = await findPersonality("executor");
  const fixerResult = await runAgent({
    agentName: "fixer",
    personality: fixerPersonality,
    prompt: fixerPrompt,
    model: "codex",
    taskId: `${taskId}-fix`,
    correlationId: cycleId,
    workDir: PROJECT_WORKSPACE,
  });

  await ovSession.logExecutor({ summary: `[Fixer] ${fixerResult.output?.slice(0, 200)}`, filesChanged: [] });
  await tracker.logAgentRun(cycleId, "fixer", taskId, fixerResult.duration, fixerResult.exitCode === 0 ? "fix-attempted" : "fix-failed", fixerResult.usage, fixerResult.costUsd, fixerResult.model || "codex");
  console.log(`[ControlLoop] Fixer completed (${Math.round(fixerResult.duration / 1000)}s, exit ${fixerResult.exitCode})`);

  // Re-verify after fixer
  console.log(`[ControlLoop] Re-verifying after fixer...`);
  const reVerification = await runVerification(PROJECT_WORKSPACE, verificationPlan);
  await ovSession.logVerification(reVerification, reVerification.allPassed);

  if (reVerification.allPassed) {
    console.log(`[ControlLoop] Fixer resolved all verification errors!`);
  }

  return reVerification;
}
