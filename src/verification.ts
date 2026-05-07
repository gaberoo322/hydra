/**
 * verification.ts — Steps 6 through 6.9 of the control loop
 *
 * Unified verification module. Contains:
 *   - Verification pipeline (verify → fixer → reconcile → mutation gate →
 *     JIT test generation → scope enforcement)
 *   - Core verification runner (inlined from verifier.ts — issue #66)
 *   - Mutation testing (inlined from mutation-testing.ts — issue #67)
 *   - JiT test generation (inlined from jit-testing.ts — issue #67)
 *   - Adversarial validation (inlined from adversarial-validation.ts — issue #68)
 *
 * Public API (3 exports):
 *   - verify()              — run the full verification pipeline
 *   - VerificationResult    — result type
 *   - trackMergedCommit()   — record a merge for revert-correlation (used by post-merge.ts)
 */

import * as Sentry from "@sentry/node";
import { execFile } from "node:child_process";
import { access, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.ts";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { getTracker } from "./task-tracker.ts";
import { recordOutcome } from "./learning.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { fail, block } from "./backlog.ts";
import { looksOperatorBlocked, reconcilePlanVsActual } from "./preflight.ts";
import { cleanupBrokenBranch, PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import { pushTrackedMerge, getTrackedMerges, setAdversarialStats } from "./redis-adapter.ts";
import type { CycleContext } from "./cycle-helpers.ts";

const execFileAsync = promisify(execFile);

// =========================================================================
// Public types
// =========================================================================

export interface VerificationResult {
  /** Whether the pipeline passed all gates and is ready for merge */
  passed: boolean;
  /** The final verification result (may be updated by fixer/JIT) */
  verification: any;
  /** Reconciliation report */
  reconciliation: any;
  /** Mutation testing report (null if skipped) */
  mutationReport: any;
  /** JIT testing report (null if skipped) */
  jitReport: any;
  /** If failed, the early return value for the caller */
  earlyReturn?: any;
}

/** @deprecated Use VerificationResult instead */
export type VerificationPipelineResult = VerificationResult;

// =========================================================================
// Verification pipeline — public entry point
// =========================================================================

/**
 * Run the full verification pipeline (steps 6 through 6.9).
 *
 * @param ctx       — shared cycle context
 * @param task      — planner task
 * @param diff      — git diff from executor
 * @param execResult — executor result (for metrics)
 * @param complexity — "quick-fix" | "standard" | "complex"
 * @param filesInScope — number of files in scope boundary
 * @param criteriaCount — number of acceptance criteria
 * @param taskId    — task identifier
 */
export async function verify(
  ctx: CycleContext,
  task: any,
  diff: string,
  execResult: any,
  complexity: string,
  filesInScope: number,
  criteriaCount: number,
  taskId: string,
): Promise<VerificationResult> {
  const { cycleId, ovSession } = ctx;
  const tracker = getTracker();

  // =========================================================================
  // Step 6: VERIFY — run hard checks (command execution, NOT an agent)
  // =========================================================================
  console.log(`[ControlLoop] Step 6: Verifying...`);
  let verificationPlan = task.verificationPlan?.length > 0
    ? task.verificationPlan
    // @ts-expect-error — migrate to proper types
    : defaultVerificationPlan(PROJECT_WORKSPACE);

  // Always include build check — catches Vercel deploy failures before merge
  const hasBuild = verificationPlan.some((s: any) => s.command?.includes("build"));
  if (!hasBuild) {
    verificationPlan = [...verificationPlan, { command: "npm run build", expected: "exit code 0", label: "build" }];
  }

  let verification = await runVerification(PROJECT_WORKSPACE, verificationPlan);
  await ovSession.logVerification(verification, verification.allPassed);

  // =========================================================================
  // Step 6.5: FIXER — if verification failed, give a fixer agent one shot
  // =========================================================================
  if (!verification.allPassed) {
    verification = await runFixerAttempt(ctx, task, verification, verificationPlan, taskId);
  }

  if (!verification.allPassed) {
    const earlyReturn = await handleVerificationFailure(ctx, task, verification, execResult, complexity, filesInScope, criteriaCount, taskId);
    return { passed: false, verification, reconciliation: null, mutationReport: null, jitReport: null, earlyReturn };
  }

  await tracker.transitionTask(taskId, "verified", { verification });
  console.log(`[ControlLoop] Verification PASSED (${verification.totalDurationMs}ms)`);

  // =========================================================================
  // Step 6.5b: RECONCILE — plan vs actual diff
  // =========================================================================
  const reconciliation = reconcilePlanVsActual(task, verification);
  if (!reconciliation.aligned) {
    for (const w of reconciliation.warnings) {
      console.log(`[ControlLoop] RECONCILE: ${w}`);
    }
    if (reconciliation.scopeCreep.length > 0) {
      await recordOutcome({
        agents: ["planner"],
        cycleId, task, finalState: "merged",
        anchorRef: "", anchorType: "",
        context: { filesChanged: verification.filesChanged.length, scopeCreep: reconciliation.scopeCreep },
      });
    }
  } else if (task.scopeBoundary?.in?.length > 0) {
    console.log(`[ControlLoop] RECONCILE: plan-vs-actual aligned (${verification.filesChanged.length} files)`);
  }

  // =========================================================================
  // Step 6.7: MUTATION TESTING — coverage quality gate
  // =========================================================================
  let mutationReport: any = null;
  if (verification.filesChanged?.length > 0) {
    const mutResult = await runMutationGate(ctx, task, verification, execResult, complexity, filesInScope, criteriaCount, taskId);
    if (mutResult.earlyReturn) {
      return { passed: false, verification, reconciliation, mutationReport: mutResult.report, jitReport: null, earlyReturn: mutResult.earlyReturn };
    }
    mutationReport = mutResult.report;
  }

  // =========================================================================
  // Step 6.8: DIFF-AWARE TEST GENERATION (mutation-survivor-aware)
  // =========================================================================
  if (mutationReport?.survived > 0 && complexity !== "quick-fix") {
    verification = await runMutationAwareJitTests(ctx, task, verification, verificationPlan, mutationReport, taskId);
  }

  // =========================================================================
  // Step 6.85: JIT TEST GENERATION — adversarial regression tests from diff
  // =========================================================================
  let jitReport: any = null;
  if (complexity !== "quick-fix" && diff && verification.filesChanged?.length > 0) {
    const jitResult = await runDiffAwareJitTests(ctx, task, verification, verificationPlan, diff, execResult, complexity, filesInScope, criteriaCount, taskId);
    if (jitResult.earlyReturn) {
      return { passed: false, verification, reconciliation, mutationReport, jitReport: jitResult.report, earlyReturn: jitResult.earlyReturn };
    }
    jitReport = jitResult.report;
    if (jitResult.updatedVerification) {
      verification = jitResult.updatedVerification;
    }
  }

  // =========================================================================
  // Step 6.9: SCOPE ENFORCEMENT
  // =========================================================================
  if (task.scopeBoundary?.in?.length > 0 && verification.filesChanged?.length > 0) {
    const scopeResult = await runScopeEnforcement(ctx, task, verification, taskId);
    if (scopeResult.earlyReturn) {
      return { passed: false, verification, reconciliation, mutationReport, jitReport, earlyReturn: scopeResult.earlyReturn };
    }
  }

  return { passed: true, verification, reconciliation, mutationReport, jitReport };
}

// ---------------------------------------------------------------------------
// Internal step functions
// ---------------------------------------------------------------------------

async function runFixerAttempt(
  ctx: CycleContext, task: any, verification: any, verificationPlan: any[], taskId: string,
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
  await tracker.logAgentRun(cycleId, "fixer", taskId, fixerResult.duration, fixerResult.exitCode === 0 ? "fix-attempted" : "fix-failed", fixerResult.usage, fixerResult.costUsd);
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

async function handleVerificationFailure(
  ctx: CycleContext, task: any, verification: any, execResult: any,
  complexity: string, filesInScope: number, criteriaCount: number, taskId: string,
): Promise<any> {
  const { cycleId, startTime, grounding, ovSession, eventBus, anchor } = ctx;
  const tracker = getTracker();

  const failedSteps = verification.steps.filter((s: any) => !s.passed).map((s: any) => s.label);
  console.log(`[ControlLoop] Verification STILL FAILED after fixer: ${failedSteps.join(", ")}`);
  Sentry.captureMessage(`Cycle ${cycleId} failed verification: ${failedSteps.join(", ")}`, {
    level: "warning",
    tags: { cycleId, taskTitle: task.title, anchorType: task.anchorType },
  });
  await tracker.transitionTask(taskId, "failed", { verification });

  // Record episodic reflections + failure lessons via unified facade
  const failedStderr = verification.steps.find((s: any) => !s.passed)?.stderr || "";
  await recordOutcome({
    agents: ["planner", "executor", "skeptic"],
    cycleId, task, finalState: "failed",
    anchorRef: anchor.reference, anchorType: anchor.type,
    context: { failReason: `Verification failed: ${failedSteps.join(", ")}`, failedSteps, verificationStderr: failedStderr },
    skepticVerdict: "approve",
    reflection: {
      failureMode: "verification-failed", whatFailed: task.title,
      whyItFailed: `Verification failed: ${failedSteps.join(", ")}`,
      whatToTryDifferently: `Address these specific verification failures: ${failedSteps.join(", ")}. Consider narrower scope or fixing verification errors before adding new behavior.`,
      verificationErrors: failedSteps,
    },
  });

  await reportOutcome(anchor, { status: "failed", reason: `Verification failed: ${failedSteps.join(", ")}`, verification, taskId });

  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "task:verification_failed",
    source: "control-loop",
    correlationId: cycleId,
    payload: {
      taskId,
      title: task.title,
      failedSteps,
      verificationSummary: summarizeVerification(verification).slice(0, 500),
    },
  });

  await recordCycleMetrics(cycleId, {
    tasksAttempted: 1, tasksFailed: 1, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
    testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
    testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
    filesChanged: 0, totalDurationMs: Date.now() - startTime,
    groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: verification.totalDurationMs,
    regressionIntroduced: false, taskTitle: task.title,
    anchorType: task.anchorType, anchorReference: task.anchorReference,
    complexity, filesInScope, criteriaCount,
    plannerModel: task.__plannerModel || "unknown",
    planCacheHit: task.__planCacheHit ? "true" : "false",
    executorModel: execResult?.__executorModel || "unknown",
  });

  // Route to Blocked or Backlog
  const blockedReason = looksOperatorBlocked(verification);
  if (blockedReason) {
    console.log(`[ControlLoop] Detected operator-blocked failure: ${blockedReason}`);
    await block(anchor.reference, blockedReason, { eventBus, cycleId });
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "cycle:operator_blocked",
      source: "control-loop",
      correlationId: cycleId,
      payload: { taskId, title: task.title, blockedReason },
    });
  } else {
    await fail(anchor.reference, "verification failed", { eventBus, cycleId });
  }

  await cleanupBrokenBranch(PROJECT_WORKSPACE);
  await ovSession.logOutcome("failed", `Verification failed: ${failedSteps.join(", ")}`);
  await ovSession.commit();

  return {
    cycleId,
    tasks: [{ taskId, finalState: "failed", verification }],
    durationMs: Date.now() - startTime,
  };
}

async function runMutationGate(
  ctx: CycleContext, task: any, verification: any, execResult: any,
  complexity: string, filesInScope: number, criteriaCount: number, taskId: string,
): Promise<{ report: any; earlyReturn?: any }> {
  const { cycleId, startTime, grounding, ovSession, eventBus, anchor } = ctx;
  const tracker = getTracker();

  console.log(`[ControlLoop] Step 6.7: Running mutation tests on ${verification.filesChanged.length} changed files...`);
  try {
    const mutationReport = await runMutationTests(PROJECT_WORKSPACE, verification.filesChanged, {
      timeBudgetMs: 60_000,
      testCommand: "npm test",
    });
    const testable = mutationReport.totalMutants - mutationReport.skipped;
    const killRate = testable > 0
      ? Math.round((mutationReport.killed / testable) * 100)
      : 100;
    console.log(`[ControlLoop] Mutation testing: ${killRate}% kill rate (${mutationReport.killed}/${testable} killed, ${mutationReport.survived} survived)`);
    if (mutationReport.survived > 0) {
      console.log(`[ControlLoop] ${mutationReport.survived} surviving mutants — executor's tests may not cover changed behavior`);
      for (const s of mutationReport.survivors.slice(0, 3)) {
        console.log(`[ControlLoop]   ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]`);
      }
    }

    // Hard gate: block merge when kill rate is critically low on non-trivial tasks
    const MUTATION_KILL_THRESHOLD = 30;
    if (complexity !== "quick-fix" && testable >= 3 && killRate < MUTATION_KILL_THRESHOLD) {
      console.error(`[ControlLoop] MUTATION GATE: kill rate ${killRate}% < ${MUTATION_KILL_THRESHOLD}% threshold — blocking merge`);
      await tracker.transitionTask(taskId, "failed", { reason: `Mutation gate: ${killRate}% kill rate (${mutationReport.survived} survivors)` });
      await recordOutcome({
        agents: ["planner"],
        cycleId, task, finalState: "failed",
        anchorRef: anchor.reference, anchorType: anchor.type,
        context: { failReason: `Mutation gate: ${killRate}% kill rate`, failedSteps: ["mutation-testing"] },
      });
      await fail(anchor.reference, "mutation gate blocked merge", { eventBus, cycleId });

      await cleanupBrokenBranch(PROJECT_WORKSPACE);
      await reportOutcome(anchor, { status: "failed", reason: `Mutation gate: tests don't cover changed behavior (${killRate}% kill rate)`, verification, taskId });
      await ovSession.logOutcome("failed", `Mutation gate: ${killRate}% kill rate`);
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
        mutationKillRate: killRate,
      });
      return {
        report: mutationReport,
        earlyReturn: {
          cycleId,
          tasks: [{ taskId, finalState: "failed", reason: `Mutation gate: ${killRate}% kill rate` }],
          durationMs: Date.now() - startTime,
        },
      };
    }

    return { report: mutationReport };
  } catch (err: any) {
    console.error(`[ControlLoop] Mutation testing failed (non-fatal): ${err.message}`);
    return { report: null };
  }
}

async function runMutationAwareJitTests(
  ctx: CycleContext, task: any, verification: any, verificationPlan: any[],
  mutationReport: any, taskId: string,
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

async function runDiffAwareJitTests(
  ctx: CycleContext, task: any, verification: any, verificationPlan: any[],
  diff: string, execResult: any, complexity: string, filesInScope: number,
  criteriaCount: number, taskId: string,
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

async function runScopeEnforcement(
  ctx: CycleContext, task: any, verification: any, taskId: string,
): Promise<{ earlyReturn?: any }> {
  const { cycleId, startTime, ovSession, anchor } = ctx;
  const tracker = getTracker();

  const inScope = new Set((task.scopeBoundary.in as string[]).map((f: string) => f.replace(/^web\//, "")));
  const outOfScope = verification.filesChanged.filter((f: string) => {
    const normalized = f.replace(/^web\//, "");
    return !inScope.has(normalized) && ![...inScope].some((s: string) => normalized.startsWith(s) || normalized.endsWith(s));
  });
  const outOfScopeRatio = outOfScope.length / verification.filesChanged.length;
  if (outOfScopeRatio > 0.8 && outOfScope.length > 3) {
    console.error(`[ControlLoop] SCOPE GATE: ${outOfScope.length}/${verification.filesChanged.length} files (${Math.round(outOfScopeRatio * 100)}%) outside scope — blocking merge`);
    console.error(`[ControlLoop] Out-of-scope files: ${outOfScope.slice(0, 5).join(", ")}${outOfScope.length > 5 ? ` (+${outOfScope.length - 5} more)` : ""}`);

    await tracker.transitionTask(taskId, "failed", { reason: `Scope gate: ${outOfScope.length}/${verification.filesChanged.length} files outside planned scope` });
    await recordOutcome({
      agents: ["planner"],
      cycleId, task, finalState: "failed",
      anchorRef: anchor.reference, anchorType: anchor.type,
      context: { failReason: `Scope gate: ${outOfScope.length} files outside scope`, failedSteps: ["scope-enforcement"] },
    });
    await fail(anchor.reference, "scope gate blocked merge", { eventBus: ctx.eventBus, cycleId });

    await cleanupBrokenBranch(PROJECT_WORKSPACE);
    await reportOutcome(anchor, { status: "failed", reason: `Scope gate blocked merge: ${Math.round(outOfScopeRatio * 100)}% out of scope`, verification, taskId });
    await ovSession.logOutcome("failed", `Scope gate: ${outOfScope.length} files outside scope`);
    await ovSession.commit();

    return {
      earlyReturn: {
        cycleId,
        tasks: [{ taskId, finalState: "failed", reason: `Scope gate: ${Math.round(outOfScopeRatio * 100)}% out of scope` }],
        durationMs: Date.now() - startTime,
      },
    };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Core verification runner (inlined from verifier.ts — issue #66)
// ---------------------------------------------------------------------------

const STEP_TIMEOUT = 180_000; // 3 min per step
const TOTAL_TIMEOUT = 600_000; // 10 min total
const OUTPUT_LIMIT = 10_000;

function truncate(str: string, limit = OUTPUT_LIMIT) {
  if (!str || str.length <= limit) return str || "";
  return str.slice(0, limit) + `\n... (truncated, ${str.length} total chars)`;
}

/**
 * Run a single verification step. Never throws.
 */
async function runStep(step: any, projectDir: string, timeout = STEP_TIMEOUT) {
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
  } catch (err: any) {
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
function checkExpectation(expected: string, exitCode: number, stdout: string, stderr: string) {
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
 * Run a verification plan against the project. Never throws.
 */
async function runVerification(projectDir: string, plan: any[], opts: { totalTimeoutMs?: number; stepTimeoutMs?: number } = {}) {
  const totalTimeout = opts.totalTimeoutMs || TOTAL_TIMEOUT;
  const stepTimeout = opts.stepTimeoutMs || STEP_TIMEOUT;
  const start = Date.now();

  // Auto-detect app directory (same logic as grounding)
  let appDir = projectDir;
  try {
    await access(join(projectDir, "package.json"));
  } catch { /* intentional: no package.json at root — probe subdirs */
    for (const sub of ["web", "app", "packages/app"]) {
      try {
        await access(join(projectDir, sub, "package.json"));
        appDir = join(projectDir, sub);
        break;
      } catch { /* intentional: sub-dir does not have package.json, try next */ }
    }
  }

  const steps: any[] = [];

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
  let filesChanged: string[] = [];
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
    } catch (err: any) {
      console.error(`[Verification] git diff --stat failed for both main and HEAD~1: ${err.message}`);
      Sentry.addBreadcrumb({ category: "verification", message: `git diff --stat fallback failed: ${err.message}`, level: "warning" });
    }
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
function defaultVerificationPlan() {
  return [
    { command: "npm test", expected: "exit code 0", label: "tests" },
    { command: "npm run typecheck", expected: "exit code 0", label: "typecheck" },
    { command: "npm run build", expected: "exit code 0", label: "build" },
  ];
}

/**
 * Summarize a verification result for agent prompts or reports.
 */
function summarizeVerification(result: any) {
  const parts: string[] = [];
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

// ---------------------------------------------------------------------------
// Mutation testing (inlined from mutation-testing.ts — issue #67)
// ---------------------------------------------------------------------------

const DEFAULT_TIME_BUDGET_MS = 120_000;
const MT_TEST_TIMEOUT_MS = 45_000;

// Files we never mutate
const SKIP_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.config\.[jt]s$/,
  /\.d\.ts$/,
  /drizzle\//,
  /migrations?\//,
  /__mocks__\//,
  /node_modules\//,
];

type Mutation = {
  file: string;
  line: number;
  original: string;
  mutated: string;
  type: string;
};

type MutationResult = {
  mutation: Mutation;
  survived: boolean; // true = tests still passed = bad coverage
  skipped: boolean;
  error?: string;
};

type MutationTestReport = {
  totalMutants: number;
  killed: number;
  survived: number;
  skipped: number;
  timedOut: boolean;
  durationMs: number;
  survivors: MutationResult[]; // only the surviving mutants (uncovered code)
};

/**
 * Mutators — each takes a line and returns a mutated version, or null if
 * the mutation doesn't apply.
 */
const MUTATORS: { type: string; apply: (line: string) => string | null }[] = [
  {
    type: "negate-boolean-return",
    apply: (line) => {
      if (/return\s+true\s*;/.test(line)) return line.replace(/return\s+true\s*;/, "return false;");
      if (/return\s+false\s*;/.test(line)) return line.replace(/return\s+false\s*;/, "return true;");
      return null;
    },
  },
  {
    type: "swap-comparison",
    apply: (line) => {
      // Only swap the first occurrence to keep mutations atomic
      if (line.includes("===")) return line.replace("===", "!==");
      if (line.includes("!==")) return line.replace("!==", "===");
      if (/[^=<>!]>[^=]/.test(line)) return line.replace(/([^=<>!])>([^=])/, "$1<$2");
      if (/[^=<>!]<[^=]/.test(line)) return line.replace(/([^=<>!])<([^=])/, "$1>$2");
      return null;
    },
  },
  {
    type: "negate-condition",
    apply: (line) => {
      // Match `if (...)` and negate the condition
      const match = line.match(/^(\s*if\s*\()(.+)(\)\s*\{?\s*)$/);
      if (match) return `${match[1]}!(${match[2]})${match[3]}`;
      return null;
    },
  },
  {
    type: "remove-early-return",
    apply: (line) => {
      // Only remove returns that have a value (not bare `return;`)
      const match = line.match(/^(\s*)return\s+.+;/);
      if (match && !line.includes("return;")) {
        return `${match[1]}/* MUTANT: removed return */`;
      }
      return null;
    },
  },
];

function shouldSkipMutation(filePath: string): boolean {
  return SKIP_PATTERNS.some((pat) => pat.test(filePath));
}

/**
 * Generate candidate mutations for a single file.
 */
function generateMutations(filePath: string, content: string): Mutation[] {
  const mutations: Mutation[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comment-only lines and imports
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("import ") || trimmed.startsWith("export type") || trimmed.startsWith("export interface")) {
      continue;
    }

    for (const mutator of MUTATORS) {
      const mutated = mutator.apply(line);
      if (mutated && mutated !== line) {
        mutations.push({
          file: filePath,
          line: i + 1,
          original: line,
          mutated,
          type: mutator.type,
        });
        break; // one mutation per line max
      }
    }
  }

  return mutations;
}

/**
 * Run mutation testing on the changed files.
 *
 * @param projectDir - Project root (~/hydra-betting)
 * @param changedFiles - List of changed file paths (from git diff)
 * @param opts.timeBudgetMs - Max time for all mutations (default 60s)
 * @param opts.testCommand - Command to run tests (default: npm test)
 */
async function runMutationTests(
  projectDir: string,
  changedFiles: string[],
  opts: { timeBudgetMs?: number; testCommand?: string } = {},
): Promise<MutationTestReport> {
  const timeBudget = opts.timeBudgetMs || DEFAULT_TIME_BUDGET_MS;
  const testCommand = opts.testCommand || "npm test";
  const start = Date.now();

  const results: MutationResult[] = [];
  const allMutations: Mutation[] = [];

  // Resolve app directory (same logic as verifier)
  let appDir = projectDir;
  try {
    const { readFile: rf } = await import("node:fs/promises");
    await rf(`${projectDir}/package.json`);
  } catch { /* intentional: no package.json at root — probe subdirs */
    for (const sub of ["web", "app"]) {
      try {
        const { readFile: rf } = await import("node:fs/promises");
        await rf(`${projectDir}/${sub}/package.json`);
        appDir = `${projectDir}/${sub}`;
        break;
      } catch { /* intentional: sub-dir does not have package.json, try next */ }
    }
  }

  // Generate all candidate mutations
  for (const file of changedFiles) {
    if (shouldSkipMutation(file)) continue;

    const fullPath = file.startsWith("/") ? file : `${projectDir}/${file}`;
    try {
      const content = await readFile(fullPath, "utf-8");
      const mutations = generateMutations(fullPath, content);
      allMutations.push(...mutations);
    } catch {
      // File might not exist (deleted in diff)
    }
  }

  // Shuffle mutations to get a representative sample if we time out
  for (let i = allMutations.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allMutations[i], allMutations[j]] = [allMutations[j], allMutations[i]];
  }

  let timedOut = false;

  for (const mutation of allMutations) {
    if (Date.now() - start > timeBudget) {
      timedOut = true;
      break;
    }

    let originalContent: string;
    try {
      originalContent = await readFile(mutation.file, "utf-8");
    } catch {
      results.push({ mutation, survived: false, skipped: true, error: "cannot read file" });
      continue;
    }

    // Apply the mutation
    const lines = originalContent.split("\n");
    lines[mutation.line - 1] = mutation.mutated;
    const mutatedContent = lines.join("\n");

    try {
      await writeFile(mutation.file, mutatedContent);

      // Run tests
      const [cmd, ...args] = testCommand.split(/\s+/);
      try {
        await execFileAsync(cmd, args, {
          cwd: appDir,
          timeout: MT_TEST_TIMEOUT_MS,
          env: process.env,
          shell: true,
          maxBuffer: 1024 * 1024 * 5,
        });
        // Tests passed with mutation = SURVIVED (bad)
        results.push({ mutation, survived: true, skipped: false });
      } catch {
        // Tests failed with mutation = KILLED (good)
        results.push({ mutation, survived: false, skipped: false });
      }
    } finally {
      // Always restore the original file
      await writeFile(mutation.file, originalContent);
    }
  }

  const killed = results.filter((r) => !r.survived && !r.skipped).length;
  const survived = results.filter((r) => r.survived).length;
  const skipped = results.filter((r) => r.skipped).length;

  return {
    totalMutants: results.length,
    killed,
    survived,
    skipped,
    timedOut,
    durationMs: Date.now() - start,
    survivors: results.filter((r) => r.survived),
  };
}

/**
 * Format mutation test results for logging / reality report.
 */
function summarizeMutationTests(report: MutationTestReport): string {
  const parts: string[] = [];
  const score = report.totalMutants > 0
    ? Math.round((report.killed / (report.totalMutants - report.skipped)) * 100)
    : 100;

  parts.push(`## Mutation Testing: ${score}% kill rate (${report.killed}/${report.totalMutants - report.skipped} killed)`);
  if (report.timedOut) parts.push(`⚠ Time budget exceeded — ${report.totalMutants} of ${report.totalMutants} candidate mutants tested`);
  parts.push(`Duration: ${report.durationMs}ms`);

  if (report.survivors.length > 0) {
    parts.push(`\n### Surviving Mutants (uncovered code):`);
    for (const s of report.survivors.slice(0, 10)) {
      parts.push(`- ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]`);
      parts.push(`  Original: ${s.mutation.original.trim()}`);
      parts.push(`  Mutated:  ${s.mutation.mutated.trim()}`);
    }
    if (report.survivors.length > 10) {
      parts.push(`  ... and ${report.survivors.length - 10} more`);
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// JiT (Just-in-Time) test generation (inlined from jit-testing.ts — issue #67)
// ---------------------------------------------------------------------------

const JIT_TEST_TIMEOUT_MS = 60_000;

type JitTestResult = {
  generated: number;
  kept: number;
  discarded: number;
  caughtBug: boolean;
  bugDetails: string | null;
  testFiles: string[];
  durationMs: number;
  error: string | null;
};

/**
 * Build the prompt for the JiT test generation model.
 *
 * Takes the diff and file list, returns a structured prompt asking
 * for 2-3 adversarial test cases.
 */
function buildJitPrompt(diff: string, changedFiles: string[], taskTitle: string): string {
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
function parseJitResult(output: string): { tests: Array<{ filename: string; description: string; code: string }>; error: string | null } {
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
async function runJitTests(
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
function summarizeJitTests(result: JitTestResult): string {
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
// Adversarial validation (inlined from adversarial-validation.ts — issue #68)
// ---------------------------------------------------------------------------

type AdversarialFinding = {
  file: string;
  issue: string;
  severity: "low" | "medium" | "high";
  suggestedTest?: string;
};

type AdversarialReport = {
  cycleId: string;
  taskTitle: string;
  findings: AdversarialFinding[];
  durationMs: number;
  error?: string;
};

/**
 * Run adversarial validation on the files changed by a merged cycle.
 *
 * @param cycleId - The cycle that just merged
 * @param taskTitle - Title of the merged task (for context)
 * @param changedFiles - Files changed in the merge
 * @param commitSha - The merge commit SHA
 */
async function runAdversarialValidation(
  cycleId: string,
  taskTitle: string,
  changedFiles: string[],
  commitSha: string,
): Promise<AdversarialReport> {
  const start = Date.now();

  // Filter to source files only (skip tests, configs, migrations)
  const sourceFiles = changedFiles.filter((f) =>
    /\.[jt]sx?$/.test(f) &&
    !/\.test\.[jt]sx?$/.test(f) &&
    !/\.spec\.[jt]sx?$/.test(f) &&
    !/\.config\.[jt]s$/.test(f) &&
    !/drizzle\//.test(f) &&
    !/\.d\.ts$/.test(f)
  );

  if (sourceFiles.length === 0) {
    return {
      cycleId,
      taskTitle,
      findings: [],
      durationMs: Date.now() - start,
    };
  }

  // Read the changed files' content (limit to first 5 files, 2000 chars each)
  const fileContents: string[] = [];
  for (const file of sourceFiles.slice(0, 5)) {
    try {
      const fullPath = file.startsWith("/") ? file : join(PROJECT_WORKSPACE, file);
      const content = await readFile(fullPath, "utf-8");
      fileContents.push(`### ${file}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``);
    } catch {
      // File might not exist (deleted or moved)
    }
  }

  if (fileContents.length === 0) {
    return {
      cycleId,
      taskTitle,
      findings: [],
      durationMs: Date.now() - start,
    };
  }

  // Get the diff for additional context
  let diffContent = "";
  try {
    const { stdout } = await execFileAsync(
      "git", ["diff", `${commitSha}~1`, commitSha, "--", ...sourceFiles.slice(0, 5)],
      { cwd: PROJECT_WORKSPACE, timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    diffContent = stdout.slice(0, 3000);
  } catch { /* intentional: diff is supplementary context */ }

  const prompt = [
    `You are a code adversary. Your job is to find REAL bugs, edge cases, and uncovered error paths in recently merged code.`,
    ``,
    `## Merged Task: "${taskTitle}"`,
    `## Commit: ${commitSha.slice(0, 7)}`,
    ``,
    `## Changed Files`,
    ...fileContents,
    ``,
    diffContent ? `## Diff\n\`\`\`\n${diffContent}\n\`\`\`` : "",
    ``,
    `## Your Task`,
    `Examine this code for:`,
    `1. Edge cases that would cause runtime errors (null/undefined, empty arrays, division by zero)`,
    `2. Missing error handling (unhandled promise rejections, uncaught exceptions)`,
    `3. Logic errors (off-by-one, wrong operator, inverted condition)`,
    `4. Type mismatches that TypeScript wouldn't catch (runtime shape assumptions)`,
    `5. Integration issues (function called with wrong args, missing awaits)`,
    ``,
    `IMPORTANT: Only report REAL issues you are confident about. Do NOT report:`,
    `- Style preferences or naming suggestions`,
    `- "Could be improved" suggestions`,
    `- Issues in code you can't see (imported modules)`,
    `- Hypothetical issues that require knowing the full codebase`,
    ``,
    `Output ONLY valid JSON:`,
    `{ "findings": [{ "file": "path", "issue": "description", "severity": "low|medium|high", "suggestedTest": "test code or null" }] }`,
    `If no real issues found, output: { "findings": [] }`,
  ].join("\n");

  try {
    const personality = await findPersonality("executor"); // reuse executor personality for code understanding
    const result = await runAgent({
      agentName: "adversary",
      personality,
      prompt,
      model: "local",
      taskId: `adversary-${cycleId}`,
      correlationId: cycleId,
      workDir: PROJECT_WORKSPACE,
      timeout: 30_000,
    });

    let findings: AdversarialFinding[] = [];
    try {
      const parsed = JSON.parse(result.output);
      findings = (parsed.findings || []).filter((f: any) =>
        f.file && f.issue && ["low", "medium", "high"].includes(f.severity)
      );
    } catch {
      const match = result.output.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          findings = (parsed.findings || []).filter((f: any) =>
            f.file && f.issue && ["low", "medium", "high"].includes(f.severity)
          );
        } catch { /* intentional: unparseable output = no findings */ }
      }
    }

    return {
      cycleId,
      taskTitle,
      findings,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    console.error(`[Adversarial] Agent call failed: ${err.message}`);
    return {
      cycleId,
      taskTitle,
      findings: [],
      durationMs: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * Convert adversarial findings into work queue items for Hydra to fix.
 * Only queues medium+ severity findings.
 */
function findingsToQueueItems(report: AdversarialReport): Array<{ reference: string; reason: string; source: string }> {
  return report.findings
    .filter((f) => f.severity === "medium" || f.severity === "high")
    .map((f) => ({
      reference: `Fix adversarial finding in ${f.file}: ${f.issue.slice(0, 100)}`,
      reason: `Adversarial validation after ${report.cycleId}: ${f.issue}${f.suggestedTest ? ` (test hint: ${f.suggestedTest.slice(0, 200)})` : ""}`,
      source: "adversarial-validation",
    }));
}

// ---------------------------------------------------------------------------
// Adversarial precision tracking
// ---------------------------------------------------------------------------

type TrackedMerge = {
  cycleId: string;
  commitSha: string;
  findingsCount: number;
  findings: AdversarialFinding[];
  mergedAt: string;
};

/**
 * Record a merged commit for later revert-correlation.
 * Called after adversarial validation runs (whether findings or not).
 */
export async function trackMergedCommit(
  cycleId: string,
  commitSha: string,
  findings: AdversarialFinding[],
): Promise<void> {
  try {
    const entry: TrackedMerge = {
      cycleId,
      commitSha,
      findingsCount: findings.length,
      findings: findings.slice(0, 10),
      mergedAt: new Date().toISOString(),
    };
    // Keep a rolling window of 50 tracked merges
    await pushTrackedMerge(JSON.stringify(entry), 50);
  } catch (err: any) {
    console.error(`[Adversarial] Failed to track merge: ${err.message}`);
  }
}

/**
 * Check recent git history for reverts of tracked commits.
 * Updates precision stats: true positives (findings + reverted),
 * false negatives (no findings + reverted), true negatives (no findings + not reverted).
 * Called once per cycle at startup or after merge.
 */
async function checkRevertCorrelation(projectDir: string): Promise<{
  truePositives: number;
  falseNegatives: number;
  totalReverts: number;
  precision: number | null;
}> {
  try {
    // Get tracked merges
    const rawEntries = await getTrackedMerges();
    if (rawEntries.length === 0) return { truePositives: 0, falseNegatives: 0, totalReverts: 0, precision: null };

    // Check each tracked merge against reverts
    let truePositives = 0; // had findings AND was reverted
    let falseNegatives = 0; // no findings AND was reverted
    let totalReverts = 0;

    for (const raw of rawEntries) {
      try {
        const entry: TrackedMerge = JSON.parse(raw);
        // Check if this commit was reverted
        const { stdout: revertCheck } = await execFileAsync(
          "git", ["log", "--oneline", "--since=14 days ago", "--grep", `Revert.*${entry.commitSha.slice(0, 7)}`],
          { cwd: projectDir, timeout: 5000 },
        ).catch(() => ({ stdout: "" }));

        const wasReverted = revertCheck.trim().length > 0;
        if (wasReverted) {
          totalReverts++;
          if (entry.findingsCount > 0) {
            truePositives++;
          } else {
            falseNegatives++;
          }
        }
      } catch { /* intentional: skip unparseable entries */ }
    }

    // Persist stats
    const stats = { truePositives, falseNegatives, totalReverts, checkedAt: new Date().toISOString() };
    const precision = totalReverts > 0 ? truePositives / totalReverts : null;
    await setAdversarialStats(JSON.stringify({ ...stats, precision }));

    if (totalReverts > 0) {
      console.log(`[Adversarial] Revert correlation: ${truePositives} true positives, ${falseNegatives} false negatives out of ${totalReverts} reverts (precision: ${precision !== null ? Math.round(precision * 100) + "%" : "N/A"})`);
    }

    return { truePositives, falseNegatives, totalReverts, precision };
  } catch (err: any) {
    console.error(`[Adversarial] Revert correlation check failed: ${err.message}`);
    return { truePositives: 0, falseNegatives: 0, totalReverts: 0, precision: null };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (used by post-merge.ts — not part of the public API)
// ---------------------------------------------------------------------------

export const _internal = {
  runAdversarialValidation,
  findingsToQueueItems,
  checkRevertCorrelation,
};

// ---------------------------------------------------------------------------
// Backward-compat alias
// ---------------------------------------------------------------------------

/** @deprecated Use verify() instead */
export const runVerificationPipeline = verify;

// ---------------------------------------------------------------------------
// Test escape hatch — expose internals needed by unit tests
// ---------------------------------------------------------------------------

/**
 * Internal helpers exposed for unit testing only. Not part of the public API.
 */
export const _testing = {
  buildJitPrompt,
  parseJitResult,
  summarizeJitTests,
  summarizeMutationTests,
  MUTATORS,
  SKIP_PATTERNS,
  shouldSkipMutation,
  generateMutations,
  runAdversarialValidation,
  findingsToQueueItems,
  checkRevertCorrelation,
};
