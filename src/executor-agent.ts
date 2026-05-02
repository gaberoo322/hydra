/**
 * Executor agent orchestration.
 *
 * Extracted from control-loop.ts (issue #11). Encapsulates:
 * - Worktree lifecycle (create, push, cleanup)
 * - Feedback/memory loading
 * - Prompt construction (pure function: buildExecutorPrompt)
 * - Codex SDK call via runAgent
 * - Result parsing into typed ExecutorResult
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { getTracker } from "./task-tracker.ts";
import { loadAgentMemory, formatMemoryForPrompt } from "./agent-memory.ts";
import { generateRepoMap } from "./repo-map.ts";

const execFileAsync = promisify(execFile);

const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutorResult {
  summary: string;
  filesChanged: string[];
  commits: string[];
  branch: string;
  testsRun: { passed: number; failed: number };
  exitCode: number;
  duration: number;
  __executorModel: string;
  __worktreeUsed: boolean;
  __parseError?: string;
}

interface ExecutorTask {
  taskId: string;
  title: string;
  description: string;
  scopeBoundary?: { in?: string[]; out?: string[] };
  acceptanceCriteria?: string[];
  verificationPlan?: Array<{ label: string; command: string; expected: string }>;
}

interface GroundingReport {
  fileTree: string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Pure prompt construction (testable without Codex SDK)
// ---------------------------------------------------------------------------

export interface BuildPromptInput {
  task: ExecutorTask;
  groundingSummary: string;
  executorMemory: any;
  executorKnowledge: string;
  testPatternHint: string;
  useWorktree: boolean;
  branchName: string;
  complexity: string;
  repoMapContext?: string;
}

export function buildExecutorPrompt(input: BuildPromptInput): string {
  const { task, groundingSummary, executorMemory, executorKnowledge, testPatternHint, useWorktree, branchName, complexity, repoMapContext } = input;

  const prompt = [
    `## TASK`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    "",
    `## SCOPE BOUNDARY`,
    `Files to modify: ${JSON.stringify(task.scopeBoundary?.in || [])}`,
    `Files to NOT touch: ${JSON.stringify(task.scopeBoundary?.out || [])}`,
    "",
    `## ACCEPTANCE CRITERIA`,
    ...(task.acceptanceCriteria || []).map((c, i) => `${i + 1}. ${c}`),
    "",
    ...(repoMapContext ? [
      `## CODEBASE CONTEXT`,
      `The following files are most relevant to your task (ranked by import centrality):`,
      repoMapContext,
      "",
    ] : []),
    `## VERIFICATION (these commands will be run AFTER you finish)`,
    ...(task.verificationPlan || []).map((s) => `- ${s.label}: \`${s.command}\` (expected: ${s.expected})`),
    "",
    testPatternHint,
    groundingSummary.slice(0, 3000),
    "",
    formatMemoryForPrompt(executorMemory, "executor"),
    "",
    executorKnowledge,
    "",
    `## RULES`,
    ...(useWorktree ? [
      `1. You are in an isolated worktree on branch \`${branchName}\`. The workspace is clean. Start working immediately — do NOT run git checkout or create branches.`,
    ] : [
      `1. FIRST: \`git checkout main && git pull origin main\` then create feature branch: \`git checkout -b ${branchName}\``,
    ]),
    ...(complexity !== "quick-fix" ? [
      `2. **TEST-FIRST**: Before writing any implementation code, write failing tests that verify each acceptance criterion. Run \`npm test\` to confirm they fail for the right reason.`,
      `3. Then implement the SMALLEST change that makes all tests pass.`,
      `4. Run \`npm test\` again — all tests (old and new) must pass before committing.`,
      `4b. **MUTATION SELF-CHECK**: Pick one key condition or return value in your implementation. Temporarily negate it (e.g. change \`===\` to \`!==\`, \`true\` to \`false\`). Run \`npm test\`. If tests STILL PASS, your tests don't cover that behavior — improve them. Restore the original code after.`,
    ] : [
      `2. Make the SMALLEST change that satisfies the acceptance criteria`,
      `3. Write or update tests for your changes — RUN THEM before committing: \`npm test\``,
      `4. If tests FAIL, fix your code until they pass. Do not commit failing code.`,
    ]),
    `5. **SCOPE CLEANUP**: Before committing, run \`git diff --name-only main\` and \`git checkout main -- <file>\` for ANY file NOT listed in your scopeBoundary.in. Do NOT commit formatting, linting, or other changes to files outside your scope.`,
    `6. Commit to the feature branch with clear commit messages`,
    `7. NEVER merge into main — the control loop handles merging after verification`,
    `8. Push your branch when done`,
    `9. NEVER delete or remove files in src/lib/providers/ — these are foundational venue adapters even if not yet imported elsewhere`,
    `10. NEVER create "cleanup" or "remove unused" commits — if code exists with tests, it is intentional`,
    `11. If you create or modify database migrations (drizzle SQL files), you MUST also update drizzle/meta/_journal.json with the new entry. Migration SQL without a journal entry will silently fail.`,
    "",
    `Output ONLY valid JSON:`,
    `{ "summary": "...", "filesChanged": [...], "commits": [...], "branch": "...", "testsRun": { "passed": N, "failed": N } }`,
  ].join("\n");

  return prompt;
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

export function parseExecutorOutput(raw: string, exitCode: number, duration: number, model: string, worktreeUsed: boolean): ExecutorResult {
  let output: Record<string, any> = {};
  let parseError: string | undefined;

  try {
    output = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        output = JSON.parse(match[0]);
      } catch (err: any) {
        parseError = `Executor output unparseable even after regex extraction: ${err.message}`;
        console.error(`[ExecutorAgent] ${parseError}`);
      }
    } else {
      parseError = `Executor output contained no JSON object`;
      console.error(`[ExecutorAgent] ${parseError}`);
    }
  }

  return {
    summary: output.summary || "",
    filesChanged: output.filesChanged || [],
    commits: output.commits || [],
    branch: output.branch || "",
    testsRun: output.testsRun || { passed: 0, failed: 0 },
    exitCode,
    duration,
    __executorModel: model,
    __worktreeUsed: worktreeUsed,
    ...(parseError ? { __parseError: parseError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runExecutorAgent(
  cycleId: string,
  task: ExecutorTask,
  grounding: GroundingReport,
  groundingSummary: string,
  ovSession: any = null,
  complexity: string = "standard",
): Promise<ExecutorResult> {
  // Create an isolated worktree for the executor to prevent scope creep
  // from shared workspace state (formatting artifacts, operator changes).
  const branchName = `feature/${cycleId}-slug`;
  const worktreeBase = process.env.HYDRA_WORKTREE_DIR || "/dev/shm/hydra-worktrees";
  const worktreePath = join(worktreeBase, `hydra-betting-worktree-${cycleId}`);
  let useWorktree = false;
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branchName, worktreePath, "main"], {
      cwd: PROJECT_WORKSPACE,
      timeout: 15000,
    });
    useWorktree = true;
    console.log(`[ExecutorAgent] Created worktree at ${worktreePath} on branch ${branchName}`);
  } catch (err: any) {
    console.error(`[ExecutorAgent] Worktree creation failed (falling back to shared workspace): ${err.message}`);
  }
  const executorWorkDir = useWorktree ? worktreePath : PROJECT_WORKSPACE;

  // Load executor memory + OV context in parallel
  const [executorMemory, ovCtx] = await Promise.all([
    loadAgentMemory("executor"),
    ovSession?.getAgentContext?.("executor", { reference: task.title, whyNow: (task.scopeBoundary?.in || []).join(" ") }) || Promise.resolve({ formatted: "" }),
  ]);
  const executorKnowledge = ovCtx.formatted || "";

  // Generate scope-aware repo map (cached per file-tree hash)
  let repoMapContext = "";
  try {
    const scopeFiles = task.scopeBoundary?.in || [];
    if (scopeFiles.length > 0 && grounding.fileTree) {
      repoMapContext = await generateRepoMap(
        PROJECT_WORKSPACE,
        grounding.fileTree,
        scopeFiles,
      );
      if (repoMapContext) {
        console.log(`[ExecutorAgent] Generated repo map context (${repoMapContext.split("\n").length} entries)`);
      }
    }
  } catch (err: any) {
    console.error(`[ExecutorAgent] Repo map generation failed (non-fatal): ${err.message}`);
  }

  // Find a representative test file so executor can match the project's test patterns
  let testPatternHint = "";
  try {
    const testFiles = grounding.fileTree.split("\n").filter((f) => f.match(/\.test\.(ts|tsx|js)$/)).slice(-3);
    if (testFiles.length > 0) {
      const sampleTest = testFiles[0];
      const content = await readFile(join(PROJECT_WORKSPACE, sampleTest), "utf-8");
      testPatternHint = `\n## TEST PATTERN (follow this pattern for new tests)\nFile: ${sampleTest}\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\`\n`;
    }
  } catch { /* intentional: test pattern hint is optional context for the executor */ }

  const prompt = buildExecutorPrompt({
    task,
    groundingSummary,
    executorMemory,
    executorKnowledge,
    testPatternHint,
    useWorktree,
    branchName,
    complexity,
    repoMapContext,
  });

  const personality = await findPersonality("executor");
  const result = await runAgent({
    agentName: "executor",
    personality,
    prompt,
    model: "codex",
    taskId: task.taskId,
    correlationId: cycleId,
    workDir: executorWorkDir,
  });

  // If using worktree, push the branch and clean up the worktree
  if (useWorktree) {
    try {
      // Push the branch from the worktree so it's available in the main repo
      await execFileAsync("git", ["push", "origin", branchName], {
        cwd: executorWorkDir,
        timeout: 30000,
      }).catch(() => { /* intentional: push may fail if no commits */ });

      // Fetch the branch into the main repo
      await execFileAsync("git", ["fetch", "origin", branchName], {
        cwd: PROJECT_WORKSPACE,
        timeout: 15000,
      }).catch(() => { /* intentional: fetch may fail if branch doesn't exist on remote */ });

      // Checkout the executor's branch in the main workspace for verification
      await execFileAsync("git", ["checkout", branchName], {
        cwd: PROJECT_WORKSPACE,
        timeout: 10000,
      }).catch(() => { /* intentional: checkout may fail if branch doesn't exist */ });
    } catch (err: any) {
      console.error(`[ExecutorAgent] Worktree branch sync failed: ${err.message}`);
    }

    // Remove the worktree
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: PROJECT_WORKSPACE,
        timeout: 15000,
      });
      console.log(`[ExecutorAgent] Cleaned up worktree at ${worktreePath}`);
    } catch (err: any) {
      console.error(`[ExecutorAgent] Worktree cleanup failed (manual cleanup needed): ${err.message}`);
    }
  }

  const executorResult = parseExecutorOutput(result.output, result.exitCode, result.duration, result.model, useWorktree);

  await getTracker().logAgentRun(cycleId, "executor", task.taskId, result.duration, "completed", result.usage, result.costUsd);
  return executorResult;
}
