import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.mjs";
import { runAgent, findPersonality } from "./codex-runner.mjs";
import { getTracker } from "./task-tracker.mjs";
import { groundProject, summarizeForPrompt } from "./grounding.mjs";
import { runControlLoop } from "./control-loop.mjs";

// V2 control loop is now the default. Set HYDRA_LEGACY_PIPELINE=1 to use old 7-agent pipeline.
const USE_CONTROL_LOOP = process.env.HYDRA_LEGACY_PIPELINE !== "1";

const execFileAsync = promisify(execFile);

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

// Cycle state
let currentCycle = null;
const cycleHistory = [];

function generateCycleId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `cycle-${date}-${hour}${min}`;
}

// ---------------------------------------------------------------------------
// Context gatherers — build a rich prompt so the Strategist stays on track
// ---------------------------------------------------------------------------

/**
 * Get current project state from git.
 */
async function getProjectState() {
  try {
    const { stdout: log } = await execFileAsync(
      "git", ["log", "--oneline", "-10"],
      { cwd: PROJECT_WORKSPACE, timeout: 5000 }
    );
    const { stdout: files } = await execFileAsync(
      "git", ["ls-files"],
      { cwd: PROJECT_WORKSPACE, timeout: 5000 }
    );
    const fileList = files.trim().split("\n").filter(Boolean);
    return {
      recentCommits: log.trim(),
      fileCount: fileList.length,
      fileTree: fileList.slice(0, 40).join("\n") + (fileList.length > 40 ? `\n... (${fileList.length} total)` : ""),
    };
  } catch {
    return { recentCommits: "(no git history)", fileCount: 0, fileTree: "(empty repo)" };
  }
}

/**
 * Get a summary of the most recent cycle's results.
 */
async function getLastCycleResults() {
  const reportsDir = join(HYDRA_PATH, "reports", "cycle-summaries");
  try {
    const files = (await readdir(reportsDir))
      .filter((f) => f.endsWith(".md") && !f.includes("-fix-"))
      .sort()
      .reverse();

    if (files.length === 0) return "(No previous cycle results)";

    // Find the most recent cycle ID
    const latestFile = files[0];
    const cycleMatch = latestFile.match(/cycle-\d{4}-\d{2}-\d{2}-\d{2}/);
    if (!cycleMatch) return "(Could not parse last cycle)";
    const lastCycleId = cycleMatch[0];

    // Gather all files from that cycle
    const cycleFiles = files.filter((f) => f.includes(lastCycleId));
    const parts = [`Last cycle: ${lastCycleId} (${cycleFiles.length} agent outputs)`];

    for (const file of cycleFiles.slice(0, 6)) {
      try {
        const content = await readFile(join(reportsDir, file), "utf-8");
        // Extract agent name and summary from the output
        const agentMatch = file.match(new RegExp(`${lastCycleId}-(\\w+)-`));
        const agent = agentMatch?.[1] || "unknown";

        // Try to parse JSON for summary
        const bodyStart = content.indexOf("\n---\n");
        if (bodyStart > 0) {
          const body = content.slice(bodyStart + 5).trim();
          try {
            const parsed = JSON.parse(body);
            const summary = parsed.summary || parsed.verdict || parsed.status || "(completed)";
            parts.push(`- ${agent}: ${typeof summary === "string" ? summary.slice(0, 150) : JSON.stringify(summary).slice(0, 150)}`);
          } catch {
            parts.push(`- ${agent}: (completed, non-JSON output)`);
          }
        }
      } catch {}
    }

    return parts.join("\n");
  } catch {
    return "(No previous cycle results)";
  }
}

/**
 * Load negative constraints — things the Strategist should NOT do.
 * Extracted from priorities and agent-feedback.
 */
async function getConstraints() {
  const constraints = [];

  // Parse priorities for "do NOT" / "NOT" / scope clarification sections
  try {
    const priorities = await readFile(join(HYDRA_PATH, "direction", "priorities.md"), "utf-8");
    const lines = priorities.split("\n");
    for (const line of lines) {
      if (line.match(/\bNOT\b|do not|don't|should not|never\b/i) && line.trim().startsWith("-")) {
        constraints.push(line.trim());
      }
    }
  } catch {}

  // Parse strategist feedback for constraints
  try {
    const feedback = await readFile(join(HYDRA_PATH, "agent-feedback", "to-strategist.md"), "utf-8");
    const lines = feedback.split("\n");
    for (const line of lines) {
      if (line.match(/\bNOT\b|do not|don't|should not|never\b/i) && line.trim().startsWith("-")) {
        constraints.push(line.trim());
      }
    }
  } catch {}

  return constraints;
}

// ---------------------------------------------------------------------------
// Cycle execution
// ---------------------------------------------------------------------------

async function startCycle(eventBus, opts = {}) {
  // Synchronous mutex — set BEFORE any await to prevent concurrent cycles.
  // Node.js is single-threaded, so this flag is checked atomically.
  if (currentCycle?.status === "running") {
    return { error: "A cycle is already running", cycle: currentCycle };
  }

  // V2 control loop — evidence-driven sequential execution
  if (USE_CONTROL_LOOP) {
    currentCycle = { id: "pending", status: "running", startedAt: new Date().toISOString() };
    try {
      const result = await runControlLoop(eventBus, { anchor: opts?.anchor });
      currentCycle = {
        id: result.cycleId,
        status: "completed",
        startedAt: currentCycle.startedAt,
        completedAt: new Date().toISOString(),
        tasks: result.tasks || [],
        result,
      };
      cycleHistory.push({ ...currentCycle });
      const completed = currentCycle;
      currentCycle = null;
      return { cycle: completed, ...result };
    } catch (err) {
      const errorMsg = err?.message || String(err);
      if (currentCycle) {
        currentCycle.status = "failed";
        currentCycle.error = errorMsg;
        currentCycle.completedAt = new Date().toISOString();
        cycleHistory.push({ ...currentCycle });
      }
      currentCycle = null;
      return { error: errorMsg, cycle: { status: "failed" } };
    }
  }

  // V1 legacy pipeline (default when HYDRA_CONTROL_LOOP is not set)
  const cycleId = generateCycleId();
  currentCycle = {
    id: cycleId,
    status: "running",
    startedAt: new Date().toISOString(),
    agents: {},
    tasks: [],
    spending: { tokens: 0, cost: 0 },
  };

  await eventBus.publish(STREAMS.CYCLE, {
    type: "cycle:start",
    source: "orchestrator",
    correlationId: cycleId,
    payload: { cycleId },
  });

  currentCycle.agents.strategist = { status: "running", startedAt: new Date().toISOString() };

  // Phase 1: GROUND — deep repo inspection before any planning
  console.log(`[Cycle] Grounding: inspecting ${PROJECT_WORKSPACE}...`);
  const grounding = await groundProject(PROJECT_WORKSPACE);
  currentCycle.grounding = {
    tests: { passed: grounding.testReport.passed, failed: grounding.testReport.failed },
    typecheck: grounding.typecheckReport.exitCode === 0 ? "clean" : "errors",
    branch: grounding.branch,
    headCommit: grounding.headCommit,
    failingTests: grounding.failingTests,
  };
  console.log(`[Cycle] Grounding complete: ${grounding.testReport.passed} tests passing, ${grounding.testReport.failed} failing (${grounding.groundingDurationMs}ms)`);

  // Gather document context in parallel (priorities, feedback, north star, last cycle)
  const [northStar, priorities, feedback, lastCycle, constraints] = await Promise.all([
    readFile(join(HYDRA_PATH, "north-star.md"), "utf-8").catch(() => "(No north star document found)"),
    readFile(join(HYDRA_PATH, "direction", "priorities.md"), "utf-8").catch(() => ""),
    readFile(join(HYDRA_PATH, "agent-feedback", "to-strategist.md"), "utf-8").catch(() => ""),
    getLastCycleResults(),
    getConstraints(),
  ]);

  // Determine confidence level from grounding
  const hasFailingTests = grounding.testReport.failed > 0;
  const hasTypecheckErrors = grounding.typecheckReport.exitCode !== 0;
  const hasDirtyFiles = grounding.dirtyFiles.length > 0;
  const confidence = hasFailingTests ? "low" : (hasTypecheckErrors || hasDirtyFiles) ? "medium" : "high";
  const maxTasks = confidence === "low" ? 1 : confidence === "medium" ? 2 : 3;

  console.log(`[Cycle] Confidence: ${confidence} (max ${maxTasks} tasks)`);

  // Build grounded prompt — strategist sees REAL test results and project state
  const groundingSummary = summarizeForPrompt(grounding);

  const prompt = [
    "You are the Strategist in the Hydra development framework.",
    "You receive GROUNDED evidence about the repo (real test results, real file tree, real diffs) and must propose anchored, bounded tasks.",
    "",

    // 1. Grounding — REAL repo state with actual test results
    groundingSummary,
    "",

    // 2. Priorities
    "## PRIORITIES (what to work on THIS cycle)",
    priorities || "(No priorities file found)",
    "",

    // 3. Constraints
    constraints.length > 0
      ? `## CONSTRAINTS (do NOT violate these)\n${constraints.join("\n")}\n`
      : "",

    // 4. Operator feedback
    feedback ? `## OPERATOR FEEDBACK\n${feedback}\n` : "",

    // 5. Last cycle continuity
    `## LAST CYCLE RESULTS\n${lastCycle}\n`,

    // 6. North star (context only)
    "## NORTH STAR (vision context — do NOT use this to invent new scope)",
    northStar.split("\n").slice(0, 30).join("\n"),
    "",

    // 7. Anchored task instructions
    "## INSTRUCTIONS",
    `Confidence level: ${confidence.toUpperCase()} — you may create at most ${maxTasks} task(s).`,
    "",
    hasFailingTests
      ? `IMPORTANT: There are ${grounding.testReport.failed} FAILING TESTS. Your first priority is fixing them. Use anchorType "failing-test".`
      : "",
    hasTypecheckErrors
      ? `IMPORTANT: TypeScript has errors. Consider fixing them. Use anchorType "failing-test".`
      : "",
    "",
    "Every task MUST include:",
    "- anchorType: one of 'user-request', 'failing-test', 'prior-failure', 'issue', 'doc'",
    "- anchorReference: exact file path, test name, issue number, or priority item",
    "- whyNow: one sentence explaining why this task is the right next step",
    "- confidence: 'low', 'medium', or 'high' — how confident are you this is correct?",
    "- scopeBoundary: { in: [files/areas to touch], out: [files/areas to NOT touch] }",
    "- acceptanceCriteria: list of concrete criteria",
    "- verificationPlan: list of { command, expected, label } — shell commands that PROVE the task is done",
    "  Example: { command: 'npm test', expected: 'exit code 0', label: 'all tests pass' }",
    "- taskType: 'research', 'design', or 'build'",
    "- model: 'frontier' for design/research, 'codex' for implementation",
    "",
    "Rules:",
    `1. Maximum ${maxTasks} tasks. Prefer 1. Prefer the SMALLEST task that creates verifiable progress.`,
    "2. If all tests pass and no explicit work is anchored, output { tasks: [], goal: 'No actionable work found' }",
    "3. Do NOT invent strategic direction. Only propose tasks anchored to priorities, failing tests, or operator requests.",
    "4. Do NOT create architecture or contract design tasks unless the operator explicitly requested them.",
    "5. Prefer 'build' tasks that directly change code over 'research' or 'design' tasks.",
    "6. Every verificationPlan MUST include at least: { command: 'npm test', expected: 'exit code 0', label: 'tests pass' }",
    "",
    "Output ONLY valid JSON: { goal, tasks: [...] }. No markdown fences, no explanation.",
  ].filter(Boolean).join("\n");

  try {
    const personality = await findPersonality("strategist");
    const result = await runAgent({
      agentName: "strategist",
      personality,
      prompt,
      model: "frontier",
      taskId: "strategist-decompose",
      correlationId: cycleId,
    });

    currentCycle.agents.strategist = {
      status: "completed",
      startedAt: currentCycle.agents.strategist.startedAt,
      completedAt: new Date().toISOString(),
      duration: result.duration,
    };

    // Parse strategist output
    let tasks = [];
    let goal = "";
    try {
      const parsed = JSON.parse(result.output);
      tasks = parsed.tasks || [];
      goal = parsed.goal || "";
    } catch {
      let extracted = result.output;
      for (const line of result.output.split("\n")) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "item.completed" && evt.item?.text) {
            extracted = evt.item.text;
          }
        } catch {}
      }
      try {
        const parsed = JSON.parse(extracted);
        tasks = parsed.tasks || [];
        goal = parsed.goal || "";
      } catch {
        const match = extracted.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsed = JSON.parse(match[0]);
            tasks = parsed.tasks || [];
            goal = parsed.goal || "";
          } catch {}
        }
      }
    }

    // Validate tasks against constraints before publishing
    // Extract forbidden proper nouns from constraint lines (capitalized words that aren't common verbs)
    if (constraints.length > 0) {
      const COMMON_WORDS = new Set(["not", "do", "build", "create", "use", "add", "make", "set", "get", "put", "run", "that", "those", "these", "with", "from", "into", "should", "must", "will", "the", "and", "for", "are", "this", "they", "tasks"]);
      const flagged = [];
      for (const task of tasks) {
        const text = `${task.title} ${task.description}`.toLowerCase();
        for (const c of constraints) {
          // Extract capitalized words (proper nouns) as the forbidden entities
          const words = c.match(/\b[A-Z][a-z]+\b/g) || [];
          const forbidden = words
            .map((w) => w.toLowerCase())
            .filter((w) => w.length > 3 && !COMMON_WORDS.has(w));
          for (const term of forbidden) {
            if (text.includes(term)) {
              flagged.push({ task: task.title, constraint: c, term });
            }
          }
        }
      }

      if (flagged.length > 0) {
        console.log(`[Cycle] WARNING: ${flagged.length} tasks may violate constraints:`);
        for (const f of flagged) {
          console.log(`[Cycle]   "${f.task}" matches constraint "${f.constraint}" (term: ${f.term})`);
        }
        // Don't block — just warn. The operator can review via logs/notifications.
        await eventBus.publish(STREAMS.NOTIFICATIONS, {
          type: "cycle:constraint_warning",
          source: "orchestrator",
          correlationId: cycleId,
          payload: { flagged, taskCount: tasks.length },
        });
      }
    }

    // Validate: reject tasks without verificationPlan
    const validTasks = [];
    for (const task of tasks) {
      const vp = task.verificationPlan;
      if (!vp || !Array.isArray(vp) || vp.length === 0) {
        console.log(`[Cycle] Rejecting task "${task.title}" — missing verificationPlan`);
        continue;
      }
      if (!task.anchorType || !task.anchorReference) {
        console.log(`[Cycle] WARNING: Task "${task.title}" has no anchor — adding anyway but flagging`);
        task.anchorType = task.anchorType || "unknown";
        task.anchorReference = task.anchorReference || "unspecified";
      }
      validTasks.push(task);
    }
    tasks = validTasks;

    // Publish task:created events
    for (const task of tasks) {
      const taskId = `task-${cycleId}-${tasks.indexOf(task) + 1}`;
      await eventBus.publish(STREAMS.TASKS, {
        type: "task:created",
        source: "strategist",
        correlationId: cycleId,
        payload: {
          taskId,
          taskType: task.taskType || "build",
          title: task.title,
          description: task.description,
          priority: task.priority || 3,
          acceptanceCriteria: task.acceptanceCriteria || [],
          dependencies: task.dependencies || [],
          model: task.model || "frontier",
          // V2 fields
          anchorType: task.anchorType,
          anchorReference: task.anchorReference,
          whyNow: task.whyNow || "",
          confidence: task.confidence || confidence,
          scopeBoundary: task.scopeBoundary || {},
          verificationPlan: task.verificationPlan,
        },
      });
      currentCycle.tasks.push({ ...task, taskId, status: "created" });
    }

    // Notify
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "cycle:tasks_created",
      source: "orchestrator",
      correlationId: cycleId,
      payload: {
        cycleId,
        goal,
        confidence,
        groundingSummary: `${grounding.testReport.passed} tests passing, ${grounding.testReport.failed} failing`,
        taskCount: tasks.length,
        tasks: tasks.map((t) => `[${t.taskType}] ${t.title} (anchor: ${t.anchorType})`),
      },
    });

    // Initialize per-task tracking in Redis (v1 for pipeline compat + v2 for new schema)
    if (tasks.length > 0) {
      await getTracker().initCycle(cycleId, currentCycle.tasks);
      // Also init v2 schema for each task
      for (const task of currentCycle.tasks) {
        await getTracker().initTaskV2(cycleId, task);
      }
    }

    if (tasks.length === 0) {
      currentCycle.status = "completed";
      currentCycle.completedAt = new Date().toISOString();
      currentCycle.result = "no_tasks";
    }

    return { cycle: currentCycle, tasks };
  } catch (err) {
    currentCycle.status = "failed";
    currentCycle.error = err.message;
    currentCycle.completedAt = new Date().toISOString();

    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "cycle:failed",
      source: "orchestrator",
      correlationId: cycleId,
      payload: { cycleId, error: err.message },
    });

    return { error: err.message, cycle: currentCycle };
  }
}

function getCycleStatus() {
  return currentCycle || { status: "idle" };
}

function getCycleHistory(limit = 10) {
  return cycleHistory.slice(-limit);
}

async function killCycle(eventBus) {
  if (currentCycle?.status === "running") {
    // Timeout remaining tasks in Redis
    try {
      const timedOut = await getTracker().timeoutStaleTasks(currentCycle.id, eventBus);
      console.log(`[Cycle] Killed cycle ${currentCycle.id} — ${timedOut} tasks timed out`);
    } catch (err) {
      console.error(`[Cycle] Error timing out tasks:`, err.message);
    }

    currentCycle.status = "killed";
    currentCycle.completedAt = new Date().toISOString();
    cycleHistory.push({ ...currentCycle });
    const killed = currentCycle;
    currentCycle = null;
    return { killed: true, cycle: killed };
  }
  return { killed: false, reason: "No running cycle" };
}

export { startCycle, getCycleStatus, getCycleHistory, killCycle };
