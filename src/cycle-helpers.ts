/**
 * cycle-helpers.ts — Shared helpers for control-loop.ts
 *
 * Extracted from control-loop.ts (issue #1, Module 6). Contains:
 *   - groundProjectCached() — grounding cache (skip re-running 49s test suite if HEAD unchanged)
 *   - generateCycleId() — deterministic cycle ID from current time
 *   - isAnchorStale() — pre-validate anchor before planner
 *   - CycleContext — shared context threaded through all pipeline steps
 *   - handleEarlyExit() — encapsulates the metrics + OV session + cleanup pattern
 *   - cleanupBrokenBranch() — discard a broken feature branch to leave repo clean
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { groundProject } from "./grounding.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { getRecentReportIds, getRealityReport } from "./redis-adapter.ts";
import { getTargetWorkspace } from "./target-config.ts";

const execFileAsync = promisify(execFile);

export const PROJECT_WORKSPACE = getTargetWorkspace();

// ---------------------------------------------------------------------------
// Shared types — contracts for pipeline step parameters
// ---------------------------------------------------------------------------

/** Anchor selected by selectAnchor() — the work item for this cycle */
export interface Anchor {
  type: string;
  reference: string;
  whyNow?: string;
  [key: string]: any;
}

/** Grounding report from groundProject() — read-only snapshot of project state */
export interface GroundingReport {
  branch: string;
  headCommit: string;
  recentCommits: string[];
  dirtyFiles: string[];
  fileTree: string;
  fileCount: number;
  testReport: {
    ran: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: number;
    failed: number;
    total: number;
    durationMs: number;
  };
  typecheckReport: {
    ran: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  };
  failingTests: string[];
  recentDiffs: string;
  todoMarkers: string[];
  readme: string;
  packageJson: any;
  timestamp: number;
  groundingDurationMs: number;
}

/** OV session interface — subset used by pipeline steps */
export interface OVSession {
  sessionId: string;
  cycleId: string;
  active: boolean;
  logPlanner(anchor: Anchor, task: any): Promise<void>;
  logSkeptic(verdict: string, reason: string): Promise<void>;
  logExecutor(execResult: any): Promise<void>;
  logVerification(verification: any, passed: boolean): Promise<void>;
  logOutcome(finalState: string, details?: string): Promise<void>;
  markUsed(uris: string[]): Promise<void>;
  commit(): Promise<void>;
}

/** Event bus interface — subset used by pipeline steps */
export interface EventBus {
  publish(stream: string, event: any): Promise<void>;
}

/** Anchor confidence score from scoreAnchor() */
export interface AnchorConfidence {
  score: number;
  reason: string;
  tier: "heuristic" | "classifier";
}

// ---------------------------------------------------------------------------
// CycleContext — threaded through all pipeline steps
// ---------------------------------------------------------------------------
export interface CycleContext {
  cycleId: string;
  startTime: number;
  grounding: GroundingReport;
  groundingSummary: string;
  ovSession: OVSession;
  eventBus: EventBus;
  anchor: Anchor;
  anchorConfidence: AnchorConfidence | null;
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

  // Check for duplicate of recently-merged task (last 10 cycle reports)
  try {
    const reportIds = await getRecentReportIds(10);
    for (const rid of reportIds) {
      const raw = await getRealityReport(rid);
      if (!raw) continue;
      try {
        const report = JSON.parse(raw);
        if (report.task?.finalState !== "merged") continue;
        const mergedTitle = (report.task?.title || "").toLowerCase().trim();
        if (!mergedTitle || mergedTitle.length < 10) continue;

        // Word-overlap similarity (same approach as priorities.md check)
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const mergedWords = new Set<string>(mergedTitle.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || mergedWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => mergedWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, mergedWords.size);
        if (similarity > 0.6) {
          return `Duplicates recently merged task: "${mergedTitle.slice(0, 80)}"`;
        }
      } catch { /* intentional: skip unparseable reports */ }
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Recent-merge duplicate check failed (proceeding): ${err.message}`);
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
  } catch (err: any) {
    // priorities.md may be missing on fresh installs; log non-ENOENT failures so
    // a stuck reader is observable, but never block the cycle on this check.
    if (err?.code !== "ENOENT") {
      console.error(`[ControlLoop] priorities.md duplicate-check read failed (proceeding): ${err?.message ?? err}`);
    }
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
  /** Whether to clear processing queue item via reportOutcome (default true) */
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
    await reportOutcome(anchor, { status: "skipped" });
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
    // Issue #193: surface reflection injection on aborted/abandoned cycles too
    reflectionInjected: task?.__hadReflections ? "true" : "false",
    reflectionCount: task?.__reflectionsInjected || 0,
    // Issue #221: include source breakdown so the effectiveness API can
    // attribute outcomes to per-anchor vs global reflections.
    reflectionSources: Array.isArray(task?.__reflectionSources)
      ? task.__reflectionSources.join(",")
      : "",
    ...metricsOverrides,
  });
}

// ---------------------------------------------------------------------------
// Scope path validation — reject plans with non-existent file paths (issue #170)
// ---------------------------------------------------------------------------

export interface ScopePathValidation {
  valid: boolean;
  missingFiles: string[];
  hints: string[];
}

/**
 * Validate that every file in scopeBoundary.in exists in the target project.
 * If a file doesn't exist, check if `web/${file}` exists and provide a hint.
 * Never throws — returns a result object.
 */
export function validateScopePaths(
  scopeIn: string[],
  projectWorkspace: string,
): ScopePathValidation {
  if (!scopeIn || scopeIn.length === 0) {
    return { valid: true, missingFiles: [], hints: [] };
  }

  // Skip validation if the workspace directory itself doesn't exist (e.g., CI/test)
  if (!existsSync(projectWorkspace)) {
    return { valid: true, missingFiles: [], hints: [] };
  }

  const missingFiles: string[] = [];
  const hints: string[] = [];

  for (const filePath of scopeIn) {
    const fullPath = join(projectWorkspace, filePath);
    if (!existsSync(fullPath)) {
      missingFiles.push(filePath);

      // Check for common src/ vs web/src/ confusion
      const webPrefixed = `web/${filePath}`;
      const webFullPath = join(projectWorkspace, webPrefixed);
      if (existsSync(webFullPath)) {
        hints.push(`${filePath} does not exist, but ${webPrefixed} does — did the planner omit the web/ prefix?`);
      }
    }
  }

  return {
    valid: missingFiles.length === 0,
    missingFiles,
    hints,
  };
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
