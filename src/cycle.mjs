import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EventBus, STREAMS } from "./event-bus.mjs";
import { runAgent, findPersonality } from "./codex-runner.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");

// Cycle state
let currentCycle = null;
const cycleHistory = [];

function generateCycleId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = String(now.getHours()).padStart(2, "0");
  return `cycle-${date}-${hour}`;
}

/**
 * Start a new development cycle.
 * The Strategist reads the north star and current state,
 * then decomposes the next goal into tasks.
 */
async function startCycle(eventBus) {
  if (currentCycle?.status === "running") {
    return { error: "A cycle is already running", cycle: currentCycle };
  }

  const cycleId = generateCycleId();
  currentCycle = {
    id: cycleId,
    status: "running",
    startedAt: new Date().toISOString(),
    agents: {},
    tasks: [],
    spending: { tokens: 0, cost: 0 },
  };

  // Publish cycle:start event
  await eventBus.publish(STREAMS.CYCLE, {
    type: "cycle:start",
    source: "orchestrator",
    correlationId: cycleId,
    payload: { cycleId },
  });

  // Run the strategist agent
  currentCycle.agents.strategist = { status: "running", startedAt: new Date().toISOString() };

  // Load north star
  let northStar = "";
  try {
    northStar = await readFile(join(VAULT_PATH, "north-star.md"), "utf-8");
  } catch {
    northStar = "(No north star document found)";
  }

  // Load priorities
  let priorities = "";
  try {
    priorities = await readFile(join(VAULT_PATH, "direction", "priorities.md"), "utf-8");
  } catch {}

  const personality = await findPersonality("strategist");
  const prompt = [
    "You are the Strategist agent in the Hydra autonomous development framework.",
    "Your job is to read the north star objective and current priorities, then decompose the next goal into discrete, actionable tasks.",
    "",
    "## North Star",
    northStar,
    "",
    priorities ? `## Current Priorities\n${priorities}` : "",
    "",
    "## Instructions",
    "1. Analyze the north star and priorities",
    "2. Identify the single most important next goal to work on",
    "3. Decompose it into 1-5 discrete tasks",
    "4. For each task, specify: title, description, taskType (research|design|build), priority (1-5), and acceptanceCriteria",
    "5. Output your response as a JSON object with a 'tasks' array",
    "",
    "Output ONLY valid JSON. No markdown fences, no explanation.",
  ].join("\n");

  try {
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

    // Parse strategist output for tasks
    let tasks = [];
    console.error(`[Cycle:DEBUG] output type=${typeof result.output} output=${JSON.stringify(result.output?.substring?.(0,80) ?? result.output)}`);
    try {
      const parsed = JSON.parse(result.output);
      tasks = parsed.tasks || [];
    } catch {
      // The output might contain the full JSON Lines from codex. Try to extract
      // the agent's text from item.completed events.
      let extracted = result.output;
      for (const line of result.output.split("\n")) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "item.completed" && evt.item?.text) {
            extracted = evt.item.text;
          }
        } catch {}
      }
      // Parse the extracted text
      try {
        const parsed = JSON.parse(extracted);
        tasks = parsed.tasks || [];
      } catch {
        const match = extracted.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsed = JSON.parse(match[0]);
            tasks = parsed.tasks || [];
          } catch {}
        }
      }
    }

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
          model: task.model || "frontier",
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
        taskCount: tasks.length,
        tasks: tasks.map((t) => t.title),
      },
    });

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

function killCycle() {
  if (currentCycle?.status === "running") {
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
