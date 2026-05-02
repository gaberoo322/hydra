/**
 * cycle-helpers.ts — Shared helpers for control-loop.ts
 *
 * Extracted from control-loop.ts (issue #1, Module 6). Contains:
 *   - groundProjectCached() — grounding cache (skip re-running 49s test suite if HEAD unchanged)
 *   - generateCycleId() — deterministic cycle ID from current time
 *   - safeKanban() — REMOVED (replaced by backlog facade: claim/complete/fail/block)
 *   - isAnchorStale() — pre-validate anchor before planner
 *   - CycleContext — shared context threaded through all pipeline steps
 *   - handleEarlyExit() — encapsulates the metrics + OV session + cleanup pattern
 *   - cleanupBrokenBranch() — discard a broken feature branch to leave repo clean
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { groundProject } from "./grounding.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { clearProcessingItem } from "./anchor-selection.ts";

const execFileAsync = promisify(execFile);

export const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME!, "hydra-betting");

// ---------------------------------------------------------------------------
// CycleContext — threaded through all pipeline steps
// ---------------------------------------------------------------------------
export interface CycleContext {
  cycleId: string;
  startTime: number;
  grounding: any;
  groundingSummary: string;
  ovSession: any;
  eventBus: any;
  anchor: any;
  anchorConfidence: { score: number; reason: string; tier: "heuristic" | "classifier" } | null;
}

// ---------------------------------------------------------------------------
// Grounding cache — skip re-running 49s test suite if HEAD hasn't changed
// ---------------------------------------------------------------------------
let _groundingCache: { headCommit: string; result: any; cachedAt: number } | null = null;
const GROUNDING_CACHE_MAX_AGE_MS = 5 * 60_000; // 5 min staleness limit

export async function groundProjectCached(projectDir: string): Promise<any> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir, timeout: 5000 });
  const currentHead = stdout.trim();

  if (
    _groundingCache &&
    _groundingCache.headCommit === currentHead &&
    Date.now() - _groundingCache.cachedAt < GROUNDING_CACHE_MAX_AGE_MS
  ) {
    console.log(`[ControlLoop] Grounding cache HIT (HEAD ${currentHead.slice(0, 7)} unchanged)`);
    return _groundingCache.result;
  }

  const result = await groundProject(projectDir);
  _groundingCache = { headCommit: currentHead, result, cachedAt: Date.now() };
  return result;
}

export function generateCycleId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `cycle-${date}-${hour}${min}`;
}


/**
 * Pre-validate an anchor before invoking the planner. Returns a skip reason
 * string if the anchor is stale/completed, or null if it should proceed.
 *
 * Checks:
 * 1. Reference matches a completed item in priorities.md
 * 2. Queue item is marked COMPLETED: in its reference
 * 3. Reference is a duplicate of another item already in the work queue
 */
export async function isAnchorStale(anchor: any): Promise<string | null> {
  const ref = (anchor.reference || "").toLowerCase().trim();
  if (!ref) return null;

  // Check for COMPLETED: prefix in queue items
  if (ref.startsWith("completed:")) {
    return "Queue item already marked as completed";
  }

  // Check against completed items in priorities.md
  try {
    const CONFIG_DIR = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");
    const priorities = await readFile(join(CONFIG_DIR, "direction", "priorities.md"), "utf-8");

    // Extract the "What's been completed" section
    const completedMatch = priorities.match(/# What's been completed[^\n]*\n([\s\S]*?)(?=\n#|$)/i);
    if (completedMatch) {
      const completedLines = completedMatch[1]
        .split("\n")
        .map(l => l.replace(/^[-*]\s*/, "").trim().toLowerCase())
        .filter(l => l.length > 10);

      for (const completed of completedLines) {
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const compWords = new Set<string>(completed.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || compWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => compWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, compWords.size);
        if (similarity > 0.6) {
          return `Matches completed item: "${completed.slice(0, 80)}"`;
        }
      }
    }

    // Also check "What NOT to work on" section
    const notWorkMatch = priorities.match(/# What NOT to work on[^\n]*\n([\s\S]*?)(?=\n#|$)/i);
    if (notWorkMatch) {
      const notWorkLines = notWorkMatch[1]
        .split("\n")
        .map(l => l.replace(/^[-*]\s*/, "").trim().toLowerCase())
        .filter(l => l.length > 10);

      for (const blocked of notWorkLines) {
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const blockWords = new Set<string>(blocked.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || blockWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => blockWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, blockWords.size);
        if (similarity > 0.6) {
          return `Matches 'do not work on': "${blocked.slice(0, 80)}"`;
        }
      }
    }
  } catch {
    // priorities.md not readable — proceed without this check
  }

  return null;
}

// ---------------------------------------------------------------------------
// Early-exit helper — encapsulates the repetitive metrics + OV + cleanup pattern
// ---------------------------------------------------------------------------

export interface EarlyExitOpts {
  cycleId: string;
  startTime: number;
  grounding: any;
  ovSession: any;
  anchor: any;
  /** "skipped" | "no-work" | "abandoned" | "failed" | "usage-limit" */
  outcome: string;
  reason: string;
  /** Extra fields merged into metrics */
  metricsOverrides?: Record<string, any>;
  /** Whether to call clearProcessingItem (default true) */
  clearProcessing?: boolean;
  /** Task object if available (for metrics fields) */
  task?: any;
}

/**
 * Shared early-exit handler: record metrics, commit OV session, clear processing.
 * Does NOT return the result — caller still builds and returns the LoopResult.
 */
export async function handleEarlyExit(opts: EarlyExitOpts): Promise<void> {
  const { cycleId, startTime, grounding, ovSession, anchor, outcome, reason, metricsOverrides, task } = opts;
  const clearProcessing = opts.clearProcessing !== false;

  await ovSession.logOutcome(outcome, reason);
  await ovSession.commit();

  if (clearProcessing) {
    await clearProcessingItem(anchor);
  }

  await recordCycleMetrics(cycleId, {
    tasksAttempted: 0,
    tasksFailed: 0,
    tasksMerged: 0,
    tasksVerified: 0,
    tasksAbandoned: 0,
    testsBefore: grounding.testReport.passed,
    testsAfter: grounding.testReport.passed,
    testsPassingBefore: grounding.testReport.passed,
    testsPassingAfter: grounding.testReport.passed,
    filesChanged: 0,
    totalDurationMs: Date.now() - startTime,
    groundingDurationMs: grounding.groundingDurationMs,
    verificationDurationMs: 0,
    regressionIntroduced: false,
    taskTitle: task?.title || `${outcome}: ${reason}`,
    anchorType: anchor?.type || "unknown",
    anchorReference: anchor?.reference || "unknown",
    plannerModel: task?.__plannerModel || "none",
    planCacheHit: task?.__planCacheHit ? "true" : "false",
    ...metricsOverrides,
  });
}

// ---------------------------------------------------------------------------
// Branch cleanup — discard a broken feature branch to leave repo clean
// ---------------------------------------------------------------------------
export async function cleanupBrokenBranch(projectDir: string): Promise<void> {
  try {
    const { stdout: branchName } = await execFileAsync("git", ["branch", "--show-current"], { cwd: projectDir, timeout: 5000 });
    const broken = branchName.trim();
    await execFileAsync("git", ["checkout", "main"], { cwd: projectDir, timeout: 10000 });
    await execFileAsync("git", ["clean", "-fd"], { cwd: projectDir, timeout: 10000 });
    await execFileAsync("git", ["checkout", "."], { cwd: projectDir, timeout: 10000 });
    if (broken && broken !== "main") {
      await execFileAsync("git", ["branch", "-D", broken], { cwd: projectDir, timeout: 5000 });
      console.log(`[ControlLoop] Deleted broken branch ${broken}`);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Broken branch cleanup failed (may leave stale branch): ${err.message}`);
  }
}
