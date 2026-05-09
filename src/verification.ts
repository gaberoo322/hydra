/**
 * verification.ts — Steps 6 through 6.9 of the control loop
 *
 * Thin orchestrator delegating to focused submodules:
 *   - src/fixer.ts       — fixability classification + fixer orchestration
 *   - src/mutation.ts    — mutation testing gate and runner
 *   - src/jit.ts         — JIT test generation (mutation-aware and diff-aware)
 *   - src/adversarial.ts — adversarial validation and finding-to-queue conversion
 *
 * Public API (3 exports):
 *   - verify()              — run the full verification pipeline
 *   - VerificationResult    — result type
 *   - trackMergedCommit()   — record a merge for revert-correlation (used by post-merge.ts)
 */

import * as Sentry from "@sentry/node";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
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
import type { CycleContext } from "./cycle-helpers.ts";

// Submodule imports
import { isFixableFailure, runFixerAttempt } from "./fixer.ts";
import {
  runMutationTests, summarizeMutationTests,
  MUTATORS, SKIP_PATTERNS, shouldSkipMutation, generateMutations,
} from "./mutation.ts";
import { runJitTests, buildJitPrompt, parseJitResult, summarizeJitTests } from "./jit.ts";
import {
  runAdversarialValidation, findingsToQueueItems, checkRevertCorrelation,
  trackMergedCommit,
} from "./adversarial.ts";

// Re-export trackMergedCommit for post-merge.ts
export { trackMergedCommit } from "./adversarial.ts";

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
  /** Whether the fixer agent was invoked during this pipeline run */
  fixerUsed: boolean;
  /** Whether the fixer agent resolved the verification failure */
  fixerResolved: boolean;
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
  let fixerSkipped = false;
  let fixerCategory = "none";
  let fixerUsed = false;
  let fixerResolved = false;
  if (!verification.allPassed) {
    const fixability = isFixableFailure(verification.steps);
    fixerCategory = fixability.category;
    if (fixability.fixable) {
      fixerUsed = true;
      verification = await runFixerAttempt(ctx, task, verification, verificationPlan, runVerification, taskId);
      fixerResolved = verification.allPassed;
    } else {
      fixerSkipped = true;
      console.log(`[ControlLoop] Fixer SKIPPED: ${fixability.reason} (category: ${fixability.category})`);
    }
  }

  if (!verification.allPassed) {
    const earlyReturn = await handleVerificationFailure(ctx, task, verification, execResult, complexity, filesInScope, criteriaCount, taskId, fixerSkipped, fixerCategory);
    return { passed: false, verification, reconciliation: null, mutationReport: null, jitReport: null, fixerUsed, fixerResolved, earlyReturn };
  }

  // =========================================================================
  // Step 6.05: TEST DISCOVERY GUARD — reject if test count collapsed
  // =========================================================================
  const baselineTests = ctx.grounding.testReport?.passed ?? 0;
  if (baselineTests > 0) {
    const testStep = verification.steps.find((s: any) => s.label === "tests");
    if (testStep) {
      const discoveredTests = parseVerificationTestCount(testStep.stdout, testStep.stderr);
      if (discoveredTests > 0 && discoveredTests < baselineTests * 0.9) {
        console.error(`[ControlLoop] TEST DISCOVERY GUARD: test count collapsed ${baselineTests} → ${discoveredTests} (>${Math.round((1 - discoveredTests / baselineTests) * 100)}% drop) — blocking merge`);
        // Treat as verification failure so the normal failure path handles cleanup
        verification.allPassed = false;
        (verification as any).testDiscoveryBlocked = true;
        const syntheticStep = {
          label: "test-discovery-guard",
          command: "(internal check)",
          passed: false,
          exitCode: -1,
          stdout: "",
          stderr: `Test count collapsed: ${baselineTests} → ${discoveredTests}. Changes likely broke test discovery (config, package.json, import resolution). This is not a test failure — tests that were found still passed, but ${baselineTests - discoveredTests} tests were no longer discovered.`,
          durationMs: 0,
          expected: `>=${Math.floor(baselineTests * 0.9)} tests discovered`,
          actual: `${discoveredTests} tests discovered`,
        };
        verification.steps.push(syntheticStep);
        const earlyReturn = await handleVerificationFailure(ctx, task, verification, execResult, complexity, filesInScope, criteriaCount, taskId);
        return { passed: false, verification, reconciliation: null, mutationReport: null, jitReport: null, fixerUsed, fixerResolved, earlyReturn };
      }
    }
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
      return { passed: false, verification, reconciliation, mutationReport: mutResult.report, jitReport: null, fixerUsed, fixerResolved, earlyReturn: mutResult.earlyReturn };
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
      return { passed: false, verification, reconciliation, mutationReport, jitReport: jitResult.report, fixerUsed, fixerResolved, earlyReturn: jitResult.earlyReturn };
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
      return { passed: false, verification, reconciliation, mutationReport, jitReport, fixerUsed, fixerResolved, earlyReturn: scopeResult.earlyReturn };
    }
  }

  return { passed: true, verification, reconciliation, mutationReport, jitReport, fixerUsed, fixerResolved };
}

// ---------------------------------------------------------------------------
// Internal step functions
// ---------------------------------------------------------------------------

async function handleVerificationFailure(
  ctx: CycleContext, task: any, verification: any, execResult: any,
  complexity: string, filesInScope: number, criteriaCount: number, taskId: string,
  fixerSkipped = false, fixerCategory = "none",
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
    fixerSkipped: fixerSkipped ? "true" : "false",
    fixerCategory,
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
// Core verification runner
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
 * Parse test count from verification step output.
 * Mirrors grounding.ts parseTestCounts() logic — kept inline to avoid
 * importing _testing internals in production code.
 */
function parseVerificationTestCount(stdout: string, stderr: string): number {
  const combined = (stdout || "") + "\n" + (stderr || "");
  // Strip ANSI codes
  const clean = combined.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");

  // Vitest: "Tests  4291 passed (4291)"
  const vitestMatch = clean.match(/^\s*Tests\s+(\d+)\s+passed/m);
  if (vitestMatch) return parseInt(vitestMatch[1]);

  // Generic: "4291 passed"
  const genericMatch = clean.match(/(\d+)\s+passed/);
  if (genericMatch) return parseInt(genericMatch[1]);

  // Jest: "Tests: 4291 passed, 4291 total"
  const jestMatch = clean.match(/Tests:\s+(\d+)\s+passed/);
  if (jestMatch) return parseInt(jestMatch[1]);

  return 0;
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
  parseVerificationTestCount,
  isFixableFailure,
};
