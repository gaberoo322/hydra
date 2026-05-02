/**
 * Continuous Code Reviewer — Background deep review using local Gemma model.
 *
 * Runs on a timer, picks up recent merge commits that haven't been reviewed,
 * and does a thorough code review using the free local Gemma 4 26B model via
 * Ollama. Since the model is free and unlimited, reviews can be deeper than
 * the 30-second adversarial validation pass.
 *
 * Design:
 *   - Background setInterval loop (default 10 minutes)
 *   - Tracks reviewed commits in Redis set to avoid duplicates
 *   - Non-blocking: findings published to notifications stream + queued as work items
 *   - Falls back gracefully when Ollama is offline (skips review, retries next interval)
 *   - Never throws
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runLocalAgent, isOllamaAvailable, findPersonality } from "./codex-runner.ts";
import { pushToWorkQueue, getRedisConnection } from "./redis-adapter.ts";

const execFileAsync = promisify(execFile);

const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";
const REVIEW_INTERVAL_MS = parseInt(process.env.CODE_REVIEW_INTERVAL_MS || "600000", 10); // 10 minutes
const REVIEWED_SET_KEY = "hydra:code-reviewer:reviewed";
const REVIEWED_SET_MAX = 200; // keep last 200 reviewed commits

export type DeepReviewFinding = {
  file: string;
  issue: string;
  severity: "low" | "medium" | "high";
  category: "logic" | "integration" | "error-handling" | "test-coverage" | "performance";
};

export type DeepReviewReport = {
  commitSha: string;
  taskTitle: string;
  findings: DeepReviewFinding[];
  durationMs: number;
  error?: string;
};

/**
 * Check if a commit has already been reviewed.
 */
async function isReviewed(commitSha: string): Promise<boolean> {
  try {
    const r = getRedisConnection();
    return (await r.sismember(REVIEWED_SET_KEY, commitSha)) === 1;
  } catch {
    return false;
  }
}

/**
 * Mark a commit as reviewed.
 */
async function markReviewed(commitSha: string): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.sadd(REVIEWED_SET_KEY, commitSha);
    // Trim to max size (remove random old entries if over limit)
    const size = await r.scard(REVIEWED_SET_KEY);
    if (size > REVIEWED_SET_MAX) {
      const toRemove = size - REVIEWED_SET_MAX;
      const members = await r.srandmember(REVIEWED_SET_KEY, toRemove);
      if (members && members.length > 0) {
        await r.srem(REVIEWED_SET_KEY, ...members);
      }
    }
  } catch (err: any) {
    console.error(`[CodeReviewer] Failed to mark commit reviewed: ${err.message}`);
  }
}

/**
 * Get recent merge commits from git log.
 */
async function getRecentMerges(limit = 5): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const { stdout } = await execFileAsync(
      "git", ["log", "--merges", "--oneline", `-${limit}`, "--format=%H %s"],
      { cwd: PROJECT_WORKSPACE, timeout: 10000 },
    );
    return stdout.trim().split("\n").filter(Boolean).map((line) => {
      const spaceIdx = line.indexOf(" ");
      return { sha: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) };
    });
  } catch (err: any) {
    console.error(`[CodeReviewer] Failed to get recent merges: ${err.message}`);
    return [];
  }
}

/**
 * Run a deep code review on a single merge commit.
 */
async function reviewCommit(sha: string, subject: string): Promise<DeepReviewReport> {
  const start = Date.now();

  // Get the full diff for this merge
  let diff = "";
  try {
    const { stdout } = await execFileAsync(
      "git", ["diff", `${sha}~1`, sha],
      { cwd: PROJECT_WORKSPACE, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
    );
    diff = stdout;
  } catch (err: any) {
    return { commitSha: sha, taskTitle: subject, findings: [], durationMs: Date.now() - start, error: `diff failed: ${err.message}` };
  }

  if (!diff.trim()) {
    return { commitSha: sha, taskTitle: subject, findings: [], durationMs: Date.now() - start };
  }

  // Get changed file list
  let changedFiles: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git", ["diff", "--name-only", `${sha}~1`, sha],
      { cwd: PROJECT_WORKSPACE, timeout: 5000 },
    );
    changedFiles = stdout.trim().split("\n").filter(Boolean);
  } catch { /* intentional */ }

  // Filter to source files
  const sourceFiles = changedFiles.filter((f) =>
    /\.[jt]sx?$/.test(f) &&
    !/\.test\.[jt]sx?$/.test(f) &&
    !/\.spec\.[jt]sx?$/.test(f) &&
    !/\.config\.[jt]s$/.test(f) &&
    !/\.d\.ts$/.test(f)
  );

  if (sourceFiles.length === 0) {
    return { commitSha: sha, taskTitle: subject, findings: [], durationMs: Date.now() - start };
  }

  // Read full file contents (not truncated — Gemma is free)
  const fileContents: string[] = [];
  for (const file of sourceFiles.slice(0, 10)) {
    try {
      const fullPath = file.startsWith("/") ? file : join(PROJECT_WORKSPACE, file);
      const content = await readFile(fullPath, "utf-8");
      fileContents.push(`### ${file}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``);
    } catch { /* file might not exist */ }
  }

  // Truncate diff to 16K (Gemma has 128K context but let's be reasonable)
  const truncatedDiff = diff.length > 16000
    ? diff.slice(0, 16000) + "\n... (diff truncated)"
    : diff;

  const prompt = [
    `You are a thorough code reviewer. Examine this merged commit carefully.`,
    ``,
    `## Commit: ${sha.slice(0, 7)} — "${subject}"`,
    `## Changed files: ${sourceFiles.join(", ")}`,
    ``,
    `## Full Diff`,
    "```diff",
    truncatedDiff,
    "```",
    ``,
    `## Current File Contents`,
    ...fileContents,
    ``,
    `## Review Focus`,
    `1. Logic correctness — are conditions, loops, edge cases handled correctly?`,
    `2. Integration issues — do changed functions interact correctly with their callers?`,
    `3. Error handling — are errors caught, logged, and propagated appropriately?`,
    `4. Test coverage — are there obvious behaviors that should have tests but don't?`,
    `5. Performance — any N+1 queries, unbounded loops, or missing caches?`,
    ``,
    `IMPORTANT: Only report REAL, SPECIFIC issues. No style nits, no "could be improved".`,
    `Each finding must reference a specific file and describe a concrete problem.`,
    ``,
    `Output ONLY valid JSON:`,
    `{ "findings": [{ "file": "path", "issue": "description", "severity": "low|medium|high", "category": "logic|integration|error-handling|test-coverage|performance" }] }`,
    `If no real issues found, output: { "findings": [] }`,
  ].join("\n");

  try {
    const personality = await findPersonality("executor");
    const result = await runLocalAgent({
      agentName: "deep-reviewer",
      personality,
      prompt,
      workDir: PROJECT_WORKSPACE,
      timeout: 180_000, // 3 minutes — Gemma is slower but free
    });

    let findings: DeepReviewFinding[] = [];
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

    return { commitSha: sha, taskTitle: subject, findings, durationMs: Date.now() - start };
  } catch (err: any) {
    return { commitSha: sha, taskTitle: subject, findings: [], durationMs: Date.now() - start, error: err.message };
  }
}

/**
 * Start the continuous code reviewer background loop.
 *
 * @param eventBus - Event bus for publishing findings
 * @returns Cleanup function to stop the loop
 */
export function startCodeReviewerLoop(eventBus: any): () => void {
  console.log(`[CodeReviewer] Starting background loop (interval: ${REVIEW_INTERVAL_MS / 1000}s)`);

  const run = async () => {
    try {
      // Check if Ollama is available before doing any work
      const available = await isOllamaAvailable();
      if (!available) {
        return; // Skip this interval — Ollama is offline
      }

      const merges = await getRecentMerges(5);
      if (merges.length === 0) return;

      for (const merge of merges) {
        const alreadyReviewed = await isReviewed(merge.sha);
        if (alreadyReviewed) continue;

        console.log(`[CodeReviewer] Reviewing ${merge.sha.slice(0, 7)}: ${merge.subject.slice(0, 60)}`);
        const report = await reviewCommit(merge.sha, merge.subject);
        await markReviewed(merge.sha);

        if (report.findings.length > 0) {
          console.log(`[CodeReviewer] ${merge.sha.slice(0, 7)}: ${report.findings.length} finding(s) in ${(report.durationMs / 1000).toFixed(1)}s`);

          // Publish to notifications stream
          try {
            await eventBus.publish("hydra:stream:notifications", {
              type: "code:deep_review",
              source: "code-reviewer",
              correlationId: merge.sha,
              payload: {
                commitSha: merge.sha,
                taskTitle: merge.subject,
                findings: report.findings,
                durationMs: report.durationMs,
              },
            });
          } catch (err: any) {
            console.error(`[CodeReviewer] Failed to publish findings: ${err.message}`);
          }

          // Queue medium+ severity findings as work items
          const actionable = report.findings.filter((f) => f.severity === "medium" || f.severity === "high");
          for (const finding of actionable.slice(0, 3)) {
            try {
              await pushToWorkQueue(JSON.stringify({
                reference: `Fix deep-review finding in ${finding.file}: ${finding.issue.slice(0, 100)}`,
                reason: `Deep code review of ${merge.sha.slice(0, 7)}: [${finding.category}] ${finding.issue}`,
                source: "code-reviewer",
              }));
              console.log(`[CodeReviewer] Queued fix: ${finding.issue.slice(0, 60)}`);
            } catch (err: any) {
              console.error(`[CodeReviewer] Failed to queue finding: ${err.message}`);
            }
          }
        } else if (report.error) {
          console.warn(`[CodeReviewer] ${merge.sha.slice(0, 7)}: review failed — ${report.error}`);
        } else {
          console.log(`[CodeReviewer] ${merge.sha.slice(0, 7)}: no findings (${(report.durationMs / 1000).toFixed(1)}s)`);
        }

        // Only review one commit per interval to avoid hogging Ollama
        break;
      }
    } catch (err: any) {
      console.error(`[CodeReviewer] Loop error: ${err.message}`);
    }
  };

  // Run once on startup (after a short delay to let services settle)
  const startupTimer = setTimeout(run, 30_000);
  const interval = setInterval(run, REVIEW_INTERVAL_MS);

  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}
