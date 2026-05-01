/**
 * Adversarial Validation — Self-Play Quality Gate
 *
 * After a feature merges successfully, a nano-model agent examines the changed
 * code and tries to find edge cases, missed error handling, or integration
 * issues that the executor's tests didn't cover.
 *
 * If the adversary finds real issues, it generates failing test code and queues
 * a fix task. This catches latent defects before the operator does, reducing
 * the ~27 reverts/month baseline.
 *
 * Design:
 *   - Uses the nano model for cost efficiency (~$0.20/M tokens)
 *   - Only runs on successful merges (not failures/rollbacks)
 *   - Scoped to changed files only (from the diff)
 *   - Time-budgeted to 30 seconds
 *   - Non-blocking: findings are informational, queued as work items
 *   - Never throws
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgent, findPersonality } from "./codex-runner.ts";
import Redis from "ioredis";
import { redisKeys } from "./redis-keys.ts";

const execFileAsync = promisify(execFile);

const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";

export type AdversarialFinding = {
  file: string;
  issue: string;
  severity: "low" | "medium" | "high";
  suggestedTest?: string;
};

export type AdversarialReport = {
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
export async function runAdversarialValidation(
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
      model: "nano",
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
export function findingsToQueueItems(report: AdversarialReport): Array<{ reference: string; reason: string; source: string }> {
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

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TRACKING_KEY = redisKeys.adversarialTracking();
const STATS_KEY = redisKeys.adversarialStats();

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
  const r = new Redis(REDIS_URL);
  try {
    const entry: TrackedMerge = {
      cycleId,
      commitSha,
      findingsCount: findings.length,
      findings: findings.slice(0, 10),
      mergedAt: new Date().toISOString(),
    };
    // Keep a rolling window of 50 tracked merges
    await r.lpush(TRACKING_KEY, JSON.stringify(entry));
    await r.ltrim(TRACKING_KEY, 0, 49);
  } catch (err: any) {
    console.error(`[Adversarial] Failed to track merge: ${err.message}`);
  } finally {
    r.disconnect();
  }
}

/**
 * Check recent git history for reverts of tracked commits.
 * Updates precision stats: true positives (findings + reverted),
 * false negatives (no findings + reverted), true negatives (no findings + not reverted).
 * Called once per cycle at startup or after merge.
 */
export async function checkRevertCorrelation(projectDir: string): Promise<{
  truePositives: number;
  falseNegatives: number;
  totalReverts: number;
  precision: number | null;
}> {
  const r = new Redis(REDIS_URL);
  try {
    // Get tracked merges
    const rawEntries = await r.lrange(TRACKING_KEY, 0, -1);
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
    await r.set(STATS_KEY, JSON.stringify({ ...stats, precision }));

    if (totalReverts > 0) {
      console.log(`[Adversarial] Revert correlation: ${truePositives} true positives, ${falseNegatives} false negatives out of ${totalReverts} reverts (precision: ${precision !== null ? Math.round(precision * 100) + "%" : "N/A"})`);
    }

    return { truePositives, falseNegatives, totalReverts, precision };
  } catch (err: any) {
    console.error(`[Adversarial] Revert correlation check failed: ${err.message}`);
    return { truePositives: 0, falseNegatives: 0, totalReverts: 0, precision: null };
  } finally {
    r.disconnect();
  }
}
