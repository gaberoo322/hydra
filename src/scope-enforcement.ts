/**
 * scope-enforcement.ts — Step 6.9 of the control loop: scope gate
 *
 * Extracted from verification.ts (issue #161).
 *
 * Exports:
 *   - runScopeEnforcement()  — block merge when >80% of changed files are out of scope
 */

import { getTracker } from "./task-tracker.ts";
import { recordOutcome } from "./learning.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { fail } from "./backlog.ts";
import { cleanupBrokenBranch, PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

// ---------------------------------------------------------------------------
// Scope enforcement gate
// ---------------------------------------------------------------------------

/**
 * Check that the executor stayed within the planned scope boundary.
 * Blocks merge when >80% of changed files are outside the declared scope.
 *
 * Never throws — returns { earlyReturn } if blocked, empty object if passed.
 */
export async function runScopeEnforcement(
  ctx: CycleContext, task: any, verification: any, taskId: string,
): Promise<{ earlyReturn?: any }> {
  const { cycleId, startTime, ovSession, anchor } = ctx;
  const tracker = getTracker();

  // Combine modify-intent (`in`) and create-intent (`creates`, issue #190).
  // Without including creates, the post-merge scope gate would flag every
  // newly-created file from a refactor/extract task as out-of-scope.
  const declaredScope = [
    ...((task.scopeBoundary.in as string[]) || []),
    ...((task.scopeBoundary.creates as string[]) || []),
  ];
  const inScope = new Set(declaredScope.map((f: string) => f.replace(/^web\//, "")));
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
