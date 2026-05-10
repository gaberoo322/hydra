/**
 * verification.ts — Steps 6 through 6.9 of the control loop
 *
 * Thin orchestrator delegating to focused submodules:
 *   - src/fixer.ts             — fixability classification + fixer orchestration
 *   - src/mutation.ts          — mutation testing gate and runner
 *   - src/jit.ts               — JIT test generation (mutation-aware and diff-aware)
 *   - src/adversarial.ts       — adversarial validation and finding-to-queue conversion
 *   - src/scope-enforcement.ts — scope gate (>80% out-of-scope blocks merge)
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
import { getTracker } from "./task-tracker.ts";
import { recordOutcome } from "./learning.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { fail, block } from "./backlog.ts";
import { looksOperatorBlocked, reconcilePlanVsActual } from "./preflight.ts";
import { cleanupBrokenBranch, PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";
import { execWithGroupCleanup } from "./exec-with-timeout.ts";

// Submodule imports
import { isFixableFailure, runFixerAttempt } from "./fixer.ts";
import { runMutationGate } from "./mutation.ts";
import {
  runMutationAwareJitTests, runDiffAwareJitTests, jitSkipReport,
  JIT_SKIP_QUICK_FIX, JIT_SKIP_NO_DIFF, JIT_SKIP_NO_FILES_CHANGED,
} from "./jit.ts";
import { runScopeEnforcement } from "./scope-enforcement.ts";
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

  // Issue #220: pass executor's feature branch so filesChanged reflects the
  // actual diff against main, even if the workspace checkout silently failed
  // and PROJECT_WORKSPACE is still on main.
  const featureBranch = execResult?.branch || undefined;
  let verification = await runVerification(PROJECT_WORKSPACE, verificationPlan, { featureBranch });
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
    verification = await runMutationAwareJitTests(ctx, task, verification, verificationPlan, mutationReport, taskId, runVerification);
  }

  // =========================================================================
  // Step 6.85: JIT TEST GENERATION — adversarial regression tests from diff
  // =========================================================================
  let jitReport: any = null;
  if (complexity !== "quick-fix" && diff && verification.filesChanged?.length > 0) {
    const jitResult = await runDiffAwareJitTests(ctx, task, verification, verificationPlan, diff, execResult, complexity, filesInScope, criteriaCount, taskId, runVerification, mutationReport);
    if (jitResult.earlyReturn) {
      return { passed: false, verification, reconciliation, mutationReport, jitReport: jitResult.report, fixerUsed, fixerResolved, earlyReturn: jitResult.earlyReturn };
    }
    jitReport = jitResult.report;
    if (jitResult.updatedVerification) {
      verification = jitResult.updatedVerification;
    }
  } else {
    // Issue #235: surface why JIT was skipped so the dashboard shows a
    // human-readable reason instead of a silent zero. Order matches the
    // gate predicates above (quick-fix is checked first).
    let decision: string;
    if (complexity === "quick-fix") decision = JIT_SKIP_QUICK_FIX;
    else if (!diff) decision = JIT_SKIP_NO_DIFF;
    else decision = JIT_SKIP_NO_FILES_CHANGED;
    jitReport = jitSkipReport(decision);
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
    // Issue #193: surface reflection injection on verification-failed cycles
    // so the effectiveness API can attribute failures to "had reflections but
    // still failed" vs "no reflections to learn from".
    reflectionInjected: task.__hadReflections ? "true" : "false",
    reflectionCount: task.__reflectionsInjected || 0,
    // Issue #221: source breakdown (per-anchor / global)
    reflectionSources: Array.isArray(task.__reflectionSources)
      ? task.__reflectionSources.join(",")
      : "",
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
 *
 * Issue #226: uses execWithGroupCleanup so a `npm test` step that times out
 * kills its full process tree (sh → npm → node → tsx → esbuild --service)
 * instead of leaving grandchildren behind. The previous
 * `execFileAsync({ shell: true, timeout })` only signalled the immediate
 * `/bin/sh` and silently leaked the rest of the tree.
 */
async function runStep(step: any, projectDir: string, timeout = STEP_TIMEOUT) {
  const { command, expected, label } = step;

  // Parse command into executable + args. shell:true is preserved so PATH
  // lookups + chained `npm run …` commands keep working as they did before.
  const parts = command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  const result = await execWithGroupCleanup(cmd, args, {
    cwd: projectDir,
    env: process.env,
    timeout,
    shell: true,
    maxBuffer: 1024 * 1024 * 5,
  });

  const passed = checkExpectation(
    expected,
    result.exitCode,
    result.stdout,
    result.stderr,
  );

  let actual: string;
  if (result.timedOut) {
    actual = `timeout after ${timeout}ms (process group killed)`;
  } else if (result.exitCode === 0) {
    actual = passed
      ? "exit code 0"
      : "exit code 0 but expectation not met";
  } else {
    actual = `exit code ${result.exitCode}`;
  }

  return {
    label,
    command,
    passed,
    exitCode: result.exitCode,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    durationMs: result.durationMs,
    expected,
    actual,
    timedOut: result.timedOut,
  };
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
 * Extract the list of files changed and a stat summary, choosing the most
 * reliable git ref available. Never throws — returns empty fields on failure.
 *
 * Issue #220: callers may pass an explicit feature branch (pre-merge) or a
 * merge commit SHA (post-merge) to avoid the silent-empty-diff trap when the
 * workspace happens to be on main.
 *
 * Exported so test/verification-files-changed.test.mts can drive it against a
 * real on-disk git fixture.
 */
export async function extractDiff(
  projectDir: string,
  opts: { featureBranch?: string; commitSha?: string } = {},
): Promise<{ diffSummary: string; filesChanged: string[] }> {
  const { featureBranch, commitSha } = opts;

  // Strategy 1: explicit feature branch. `main...<branch>` ignores the
  // workspace's current HEAD entirely.
  if (featureBranch) {
    try {
      const namesPromise = execFileAsync(
        "git",
        ["diff", "--name-only", `main...${featureBranch}`],
        { cwd: projectDir, timeout: 10000 },
      );
      const statPromise = execFileAsync(
        "git",
        ["diff", "--stat", `main...${featureBranch}`],
        { cwd: projectDir, timeout: 10000 },
      );
      const [names, stat] = await Promise.all([namesPromise, statPromise]);
      const filesChanged = names.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (filesChanged.length > 0) {
        return { diffSummary: stat.stdout.trim(), filesChanged };
      }
      // Branch yielded nothing — fall through to other strategies (e.g. branch
      // already merged into main and pointer reset).
    } catch (err: any) {
      console.error(
        `[Verification] git diff main...${featureBranch} failed: ${err.message}`,
      );
      Sentry.addBreadcrumb({
        category: "verification",
        message: `extractDiff featureBranch failed: ${err.message}`,
        level: "warning",
      });
    }
  }

  // Strategy 2: explicit merge commit SHA (post-merge path). `git show
  // --name-only` lists files touched by the merge; for a `--no-ff` merge
  // commit this is the same set of files as the feature branch contributed.
  if (commitSha) {
    try {
      const namesPromise = execFileAsync(
        "git",
        ["show", "--name-only", "--pretty=format:", commitSha],
        { cwd: projectDir, timeout: 10000 },
      );
      const statPromise = execFileAsync(
        "git",
        ["show", "--stat", "--pretty=format:", commitSha],
        { cwd: projectDir, timeout: 10000 },
      );
      const [names, stat] = await Promise.all([namesPromise, statPromise]);
      const filesChanged = names.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (filesChanged.length > 0) {
        return { diffSummary: stat.stdout.trim(), filesChanged };
      }
    } catch (err: any) {
      console.error(
        `[Verification] git show --name-only ${commitSha} failed: ${err.message}`,
      );
      Sentry.addBreadcrumb({
        category: "verification",
        message: `extractDiff commitSha failed: ${err.message}`,
        level: "warning",
      });
    }
  }

  // Strategy 3 (legacy): `git diff --stat main` from the workspace. Only
  // produces output when the workspace HEAD is the feature branch.
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--stat", "main"],
      { cwd: projectDir, timeout: 10000 },
    );
    const diffSummary = stdout.trim();
    const filesChanged = stdout
      .split("\n")
      .filter((l) => l.includes("|"))
      .map((l) => l.split("|")[0].trim());
    if (filesChanged.length > 0) {
      return { diffSummary, filesChanged };
    }
  } catch (err: any) {
    console.error(
      `[Verification] git diff --stat main fallback failed: ${err.message}`,
    );
    Sentry.addBreadcrumb({
      category: "verification",
      message: `extractDiff fallback failed: ${err.message}`,
      level: "warning",
    });
  }

  // Strategy 4 (legacy fallback-of-fallback): HEAD~1 — kept for parity with
  // the pre-#220 behaviour on isolated test workspaces with no `main` ref.
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--stat", "HEAD~1"],
      { cwd: projectDir, timeout: 10000 },
    );
    const diffSummary = stdout.trim();
    const filesChanged = stdout
      .split("\n")
      .filter((l) => l.includes("|"))
      .map((l) => l.split("|")[0].trim());
    return { diffSummary, filesChanged };
  } catch (err: any) {
    console.error(
      `[Verification] git diff --stat HEAD~1 fallback failed: ${err.message}`,
    );
    Sentry.addBreadcrumb({
      category: "verification",
      message: `extractDiff HEAD~1 fallback failed: ${err.message}`,
      level: "warning",
    });
  }

  return { diffSummary: "", filesChanged: [] };
}

/**
 * Run a verification plan against the project. Never throws.
 *
 * Issue #220: opts.featureBranch / opts.commitSha let callers pin the diff
 * extraction to a specific ref instead of trusting `git diff --stat main` from
 * the workspace (which yields empty output when the workspace silently stays
 * on main — the exact failure that motivated this fix).
 */
function runVerification(
  projectDir: string,
  plan: any[],
  opts: {
    totalTimeoutMs?: number;
    stepTimeoutMs?: number;
    featureBranch?: string;
    commitSha?: string;
  } = {},
) {
  const totalTimeout = opts.totalTimeoutMs || TOTAL_TIMEOUT;
  const stepTimeout = opts.stepTimeoutMs || STEP_TIMEOUT;
  const start = Date.now();

  return (async () => {
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

    // Issue #220: extract diff via the most reliable ref available.
    //  1. featureBranch (pre-merge): `main...<branch>` works regardless of
    //     which ref the workspace is currently on, including the failure mode
    //     where the executor's checkout back to main never completed and the
    //     workspace silently stayed on main (yielding an empty diff before).
    //  2. commitSha (post-merge fallback): list files in the merge commit.
    //  3. plain `git diff --stat main` (legacy): only works when workspace is
    //     actually on the feature branch. Last resort.
    const { diffSummary, filesChanged } = await extractDiff(projectDir, {
      featureBranch: opts.featureBranch,
      commitSha: opts.commitSha,
    });

    return {
      allPassed: steps.every((s) => s.passed),
      steps,
      diffSummary,
      filesChanged,
      totalDurationMs: Date.now() - start,
    };
  })();
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

// Re-import from submodules for the _testing escape hatch
import {
  MUTATORS, SKIP_PATTERNS, shouldSkipMutation, generateMutations,
  summarizeMutationTests,
} from "./mutation.ts";
import { buildJitPrompt, parseJitResult, summarizeJitTests } from "./jit.ts";

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
