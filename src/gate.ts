/**
 * gate.ts — The Tier-0 Untouchable Core merge gate (ADR-0001 work-order step 6).
 *
 * This module is the operator-only merge-proof surface for the Hydra control
 * loop. It is intentionally THIN — a facade that names and re-exports the
 * gate-proof steps so that:
 *
 *   1. There is exactly one import path the control loop uses for every
 *      merge-proof step (grounding, verification, scope, mutation, lock,
 *      merge, rollback, cost cap).
 *   2. The CI tier classifier can pin `src/gate.ts` as Tier 0 — any change
 *      to the gate's *contract* must be operator-approved, even though the
 *      underlying logic in `verification.ts` / `post-merge.ts` / etc. can
 *      still evolve under their own tier rules.
 *   3. Hydra's loop body (`control-loop.ts`) remains mutable so the
 *      orchestration can keep evolving (ADR-0001) — the *gate it calls*
 *      is not.
 *
 * No behavior change. All logic stays in the modules below; gate.ts owns
 * the call surface and the call sequence.
 *
 * Per ADR-0001: any modification to this file is Tier 0 (operator-only)
 * and is enforced by the `tier-gate` CI job against `UNTOUCHABLE_PATHS`
 * in `src/untouchable.ts`.
 */

import type { CycleContext } from "./cycle-helpers.ts";

// ---------------------------------------------------------------------------
// 1. Grounding — read-only project probe (npm test, tsc, git status)
// ---------------------------------------------------------------------------

import { groundProject } from "./grounding.ts";

/**
 * Read-only grounding probe. Runs `npm test`, `tsc`, and `git status` to
 * snapshot the current project state. Never mutates the workspace.
 *
 * Delegates to {@link groundProject} in `src/grounding.ts`.
 */
export async function gateGrounding(
  workspace: string,
  opts: Record<string, any> = {},
): Promise<any> {
  return groundProject(workspace, opts);
}

// ---------------------------------------------------------------------------
// 2. Verification — the full verification pipeline (steps 6 through 6.9)
// ---------------------------------------------------------------------------

import { runVerificationPipeline } from "./verification.ts";
import type { VerificationResult } from "./verification.ts";

/**
 * Run the full verification pipeline: `npm test`, `tsc`, `npm run build`,
 * scope enforcement, mutation kill-rate, JIT tests, fixer attempts, etc.
 *
 * Delegates to {@link runVerificationPipeline} in `src/verification.ts`.
 * Verification logic stays in `verification.ts`; the gate owns only the
 * named entry point.
 */
export async function gateVerify(
  ctx: CycleContext,
  task: any,
  diff: string,
  execResult: any,
  complexity: string,
  filesInScope: number,
  criteriaCount: number,
  taskId: string,
): Promise<VerificationResult> {
  return runVerificationPipeline(
    ctx, task, diff, execResult, complexity, filesInScope, criteriaCount, taskId,
  );
}

// ---------------------------------------------------------------------------
// 3. Scope enforcement — >80% out-of-scope files block merge
// ---------------------------------------------------------------------------

import { runScopeEnforcement } from "./scope-enforcement.ts";

/**
 * Hard gate: block merge when >80% of changed files are outside the
 * planner's declared scope boundary (with >3 files threshold).
 *
 * Delegates to {@link runScopeEnforcement} in `src/scope-enforcement.ts`.
 */
export async function gateScopeEnforcement(
  ctx: CycleContext,
  task: any,
  verification: any,
  taskId: string,
): Promise<{ earlyReturn?: any }> {
  return runScopeEnforcement(ctx, task, verification, taskId);
}

// ---------------------------------------------------------------------------
// 4. Mutation kill-rate — <30% blocks merge for non-quick-fix tasks
// ---------------------------------------------------------------------------

import { runMutationGate } from "./mutation.ts";

/**
 * Hard gate: block merge when mutation kill rate is below 30% on
 * non-quick-fix tasks with >=3 testable mutants.
 *
 * Delegates to {@link runMutationGate} in `src/mutation.ts`.
 */
export async function gateMutationKillRate(
  ctx: CycleContext,
  task: any,
  verification: any,
  execResult: any,
  complexity: string,
  filesInScope: number,
  criteriaCount: number,
  taskId: string,
): Promise<{ report: any; earlyReturn?: any }> {
  return runMutationGate(
    ctx, task, verification, execResult, complexity, filesInScope, criteriaCount, taskId,
  );
}

// ---------------------------------------------------------------------------
// 5/6. Merge lock — 60s Redis lock serializes merges across sources
// ---------------------------------------------------------------------------

import {
  acquireMergeLock as _acquireMergeLock,
  releaseMergeLock as _releaseMergeLock,
  getMergeLockHolder as _getMergeLockHolder,
} from "./redis-adapter.ts";

/**
 * Acquire the cross-source merge lock (60s TTL by default).
 *
 * Delegates to {@link _acquireMergeLock} in `src/redis-adapter.ts`.
 */
export async function gateAcquireMergeLock(
  cycleId: string,
  ttlSeconds: number = 60,
): Promise<boolean> {
  return _acquireMergeLock(cycleId, ttlSeconds);
}

/**
 * Release the cross-source merge lock. Safe to call when no lock is held.
 *
 * Delegates to {@link _releaseMergeLock} in `src/redis-adapter.ts`.
 */
export async function gateReleaseMergeLock(): Promise<void> {
  return _releaseMergeLock();
}

/** Get current merge lock holder (for diagnostics). */
export async function gateGetMergeLockHolder(): Promise<string | null> {
  return _getMergeLockHolder();
}

// ---------------------------------------------------------------------------
// 7. Merge — git merge --no-ff + push to main
// ---------------------------------------------------------------------------

import { mergeToMain } from "./pipeline-steps.ts";

/**
 * Merge a feature branch into main and push. Acquires the merge lock,
 * runs the merge, releases the lock.
 *
 * The lock-acquire / lock-release surface lives in this same module
 * (`gateAcquireMergeLock` / `gateReleaseMergeLock`). Callers should
 * either:
 *
 *   - call `gateAcquireMergeLock` → `gateMergeToMain` → `gateReleaseMergeLock`
 *     when they need fine-grained control over lock contention behaviour, OR
 *   - call this function which delegates to {@link mergeToMain} for the
 *     pure-merge mechanic.
 *
 * Delegates to {@link mergeToMain} in `src/pipeline-steps.ts`.
 */
export async function gateMergeToMain(
  projectDir: string,
  cycleId: string,
  explicitFeatureBranch?: string,
): Promise<{ ok: boolean; commitSha: string; featureBranch: string | null; error: string | null }> {
  return mergeToMain(projectDir, cycleId, explicitFeatureBranch);
}

// ---------------------------------------------------------------------------
// 8. Rollback — revert the merge commit when post-merge tests regress
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GateRollbackResult {
  ok: boolean;
  /** The commit reverted (input echoed back for caller convenience). */
  commitSha: string;
  /** Error message if rollback failed; null otherwise. */
  error: string | null;
}

/**
 * Auto-rollback: `git revert --no-edit -m 1 <sha>` + `git push origin main`.
 *
 * Used by `post-merge.ts` when tests regress after merge. Never throws —
 * returns a result object so the caller decides how to report failures.
 *
 * The revert mechanics live here (in the gate) so the rollback path is
 * itself Tier-0 protected — a Tier-2 change cannot in principle alter
 * how regressions are reverted.
 */
export async function gateRollback(
  projectDir: string,
  commitSha: string,
  reason: string,
): Promise<GateRollbackResult> {
  if (!commitSha) {
    return { ok: false, commitSha: "", error: "no commit to revert" };
  }
  try {
    await execFileAsync(
      "git", ["revert", "--no-edit", "-m", "1", commitSha],
      { cwd: projectDir, timeout: 30000 },
    );
    await execFileAsync(
      "git", ["push", "origin", "main"],
      { cwd: projectDir, timeout: 30000 },
    );
    console.log(`[Gate] Rollback succeeded: reverted ${commitSha.slice(0, 7)} (${reason})`);
    return { ok: true, commitSha, error: null };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[Gate] Rollback failed for ${commitSha.slice(0, 7)}: ${msg}`);
    return { ok: false, commitSha, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 9. Cost cap — per-cycle absolute $-cap circuit breaker
// ---------------------------------------------------------------------------

import { runCostCapCheck, getPerCycleCostCapUsd } from "./cost-cap.ts";
import type { CostCapStepResult } from "./cost-cap.ts";

/**
 * Pipeline step: check accumulated cost vs `HYDRA_PER_CYCLE_COST_CAP_USD`
 * (default $25). If exceeded, abandon the cycle with a stable
 * `Cost cap exceeded` reason. Otherwise continue.
 *
 * Delegates to {@link runCostCapCheck} in `src/cost-cap.ts`.
 */
export async function gateCheckCostCap(
  ctx: CycleContext,
  task: any,
  taskId: string | null,
  checkpoint: string,
): Promise<CostCapStepResult> {
  return runCostCapCheck(ctx, task, taskId, checkpoint);
}

/** Re-export the cost-cap config reader so the loop can log the cap value. */
export { getPerCycleCostCapUsd };
