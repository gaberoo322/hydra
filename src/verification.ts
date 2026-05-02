/**
 * verification.ts — Steps 6 through 6.9 of the control loop
 *
 * Contains the full verification pipeline: verify → fixer → reconcile →
 * mutation gate → JIT test generation (mutation-aware) → JIT test generation
 * (diff-aware) → scope enforcement.
 *
 * Also contains the core verification runner (runVerification,
 * defaultVerificationPlan, summarizeVerification) — inlined from the former
 * verifier.ts (issue #66).
 *
 * Returns a VerificationPipelineResult that the caller uses to decide
 * whether to proceed to merge or abort.
 */

import * as Sentry from "@sentry/node";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.ts";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { getTracker } from "./task-tracker.ts";
import { runMutationTests } from "./mutation-testing.ts";
import { runJitTests } from "./jit-testing.ts";
import { recordPlannerLesson, recordExecutorLesson, recordSkepticLesson, recordReflection } from "./agent-memory.ts";
import { recordReflection as recordGlobalReflection } from "./reflections.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { storePriorFailure, clearProcessingItem } from "./anchor-selection.ts";
import { moveToBlocked, returnToBacklog } from "./backlog.ts";
import { looksOperatorBlocked, reconcilePlanVsActual } from "./preflight.ts";
import { safeKanban, cleanupBrokenBranch, PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

const execFileAsync = promisify(execFile);

export interface VerificationPipelineResult {
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
export async function runVerificationPipeline(
  ctx: CycleContext,
  task: any,
  diff: string,
  execResult: any,
  complexity: string,
  filesInScope: number,
  criteriaCount: number,
  taskId: string,
): Promise<VerificationPipelineResult> {
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
      try {
        await recordPlannerLesson(cycleId, task, "merged", {
          filesChanged: verification.filesChanged.length,
          scopeCreep: reconciliation.scopeCreep,
        });
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to record scope-creep lesson: ${err.message}`);
      }
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

  // Record episodic reflections
  await recordReflection({
    cycleId, anchorRef: anchor.reference, taskTitle: task.title,
    outcome: "verification-failed", reason: `Verification failed: ${failedSteps.join(", ")}`,
    verificationErrors: failedSteps,
  }).catch((err: any) => console.error(`[ControlLoop] Failed to record reflection: ${err.message}`));
  await recordGlobalReflection({
    cycleId, anchorType: anchor.type, anchorReference: anchor.reference,
    failureMode: "verification-failed", whatFailed: task.title,
    whyItFailed: `Verification failed: ${failedSteps.join(", ")}`,
    whatToTryDifferently: `Address these specific verification failures: ${failedSteps.join(", ")}. Consider narrower scope or fixing verification errors before adding new behavior.`,
  }).catch((err: any) => console.error(`[ControlLoop] Failed to record global reflection: ${err.message}`));

  await storePriorFailure(taskId, `Verification failed: ${failedSteps.join(", ")}`, verification);

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
    await safeKanban(eventBus, cycleId, "moveToBlocked", anchor.reference, () => moveToBlocked(anchor.reference, blockedReason));
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "cycle:operator_blocked",
      source: "control-loop",
      correlationId: cycleId,
      payload: { taskId, title: task.title, blockedReason },
    });
  } else {
    await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "verification failed"));
  }

  // Record failure lessons
  const failedStderr = verification.steps.find((s: any) => !s.passed)?.stderr || "";
  try {
    await recordPlannerLesson(cycleId, task, "failed", { failReason: `Verification failed: ${failedSteps.join(", ")}`, failedSteps });
    await recordExecutorLesson(cycleId, task, "failed", { failedSteps, verificationStderr: failedStderr });
    await recordSkepticLesson(cycleId, task, "approve", "failed");
  } catch (err: any) {
    console.error(`[ControlLoop] Failed to record verification-failure lessons: ${err.message}`);
  }

  await cleanupBrokenBranch(PROJECT_WORKSPACE);
  await clearProcessingItem(anchor);
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
      await storePriorFailure(taskId, `Mutation gate: tests don't cover changed behavior (${killRate}% kill rate)`, verification);
      await recordPlannerLesson(cycleId, task, "failed", { failReason: `Mutation gate: ${killRate}% kill rate`, failedSteps: ["mutation-testing"] });
      await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "mutation gate blocked merge"));

      await cleanupBrokenBranch(PROJECT_WORKSPACE);
      await clearProcessingItem(anchor);
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
      await storePriorFailure(taskId, `JiT test caught bug: ${jitReport.bugDetails?.slice(0, 200)}`, verification);
      await recordPlannerLesson(cycleId, task, "failed", { failReason: "JiT test caught a regression bug", failedSteps: ["jit-testing"] });
      await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "JiT test caught bug"));

      await cleanupBrokenBranch(PROJECT_WORKSPACE);
      await clearProcessingItem(anchor);
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
    await storePriorFailure(taskId, `Scope gate blocked merge: ${Math.round(outOfScopeRatio * 100)}% out of scope`, verification);
    await recordPlannerLesson(cycleId, task, "failed", { failReason: `Scope gate: ${outOfScope.length} files outside scope`, failedSteps: ["scope-enforcement"] });
    await safeKanban(ctx.eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "scope gate blocked merge"));

    await cleanupBrokenBranch(PROJECT_WORKSPACE);
    await clearProcessingItem(anchor);
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
  } catch {
    for (const sub of ["web", "app", "packages/app"]) {
      try {
        await access(join(projectDir, sub, "package.json"));
        appDir = join(projectDir, sub);
        break;
      } catch {}
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
