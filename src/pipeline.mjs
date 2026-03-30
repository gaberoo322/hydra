import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { STREAMS } from "./event-bus.mjs";
import { runAgent, findPersonality } from "./codex-runner.mjs";
import { runMetaAnalysis } from "./proposals.mjs";
import { handleFailure } from "./fix-forward.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");

// Agent pipeline definition from TDD §6.1
// Maps: agent -> { subscribes: [stream, eventTypes], publishes: [stream, eventType] }
const AGENT_PIPELINE = {
  researcher: {
    stream: STREAMS.TASKS,
    group: "researcher",
    filter: (evt) => evt.type === "task:created" && evt.payload?.taskType === "research",
    publishStream: STREAMS.TASKS,
    publishType: "research:completed",
    model: "frontier",
    outputDir: "reports/research-findings",
  },
  architect: {
    stream: STREAMS.TASKS,
    group: "architect",
    filter: (evt) => evt.type === "task:created" && evt.payload?.taskType === "design",
    publishStream: STREAMS.TASKS,
    publishType: "design:completed",
    model: "frontier",
    outputDir: "reports/decisions",
  },
  builder: {
    stream: STREAMS.TASKS,
    group: "builder",
    filter: (evt) =>
      (evt.type === "task:created" && evt.payload?.taskType === "build") ||
      evt.type === "spec:published",
    publishStream: STREAMS.CODE,
    publishType: "code:ready",
    model: "codex",
    outputDir: "reports/cycle-summaries",
  },
  reviewer: {
    stream: STREAMS.CODE,
    group: "reviewer",
    filter: (evt) => evt.type === "code:ready",
    publishStream: STREAMS.REVIEW,
    publishType: null, // determined by verdict: review:passed or review:failed
    model: "frontier",
    outputDir: "reports/cycle-summaries",
  },
  tester: {
    stream: STREAMS.REVIEW,
    group: "tester",
    filter: (evt) => evt.type === "review:passed",
    publishStream: STREAMS.TEST,
    publishType: null, // test:passed or test:failed
    model: "codex",
    outputDir: "reports/cycle-summaries",
  },
  devops: {
    stream: STREAMS.TEST,
    group: "devops",
    filter: (evt) => evt.type === "test:passed",
    publishStream: STREAMS.NOTIFICATIONS,
    publishType: null, // deploy:completed or deploy:failed
    model: "codex",
    outputDir: "reports/cycle-summaries",
  },
};

/**
 * Build the task prompt for an agent, injecting context from OpenViking and the vault.
 */
async function buildPrompt(agentName, event) {
  const payload = event.payload || {};
  const parts = [];

  parts.push(`You are the ${agentName} agent. Process the following event.`);
  parts.push(`\n## Event\n- Type: ${event.type}\n- Source: ${event.source}\n- Correlation ID: ${event.correlationId}`);

  if (payload.title) parts.push(`\n## Task: ${payload.title}`);
  if (payload.description) parts.push(`\n${payload.description}`);
  if (payload.acceptanceCriteria?.length) {
    parts.push(`\n## Acceptance Criteria`);
    payload.acceptanceCriteria.forEach((c, i) => parts.push(`${i + 1}. ${c}`));
  }

  // Load upstream agent output if referenced
  if (payload.upstreamOutput) {
    parts.push(`\n## Upstream Agent Output\n${payload.upstreamOutput}`);
  }

  // Load north star for context (L0 summary)
  try {
    const northStar = await readFile(join(VAULT_PATH, "north-star.md"), "utf-8");
    // Just include the first few lines as context
    const brief = northStar.split("\n").slice(0, 15).join("\n");
    parts.push(`\n## North Star (Summary)\n${brief}`);
  } catch {}

  parts.push(`\n## Instructions\nFollow your personality file. Output ONLY valid JSON as specified in your personality. No markdown fences, no explanation outside the JSON.`);

  return parts.join("\n");
}

/**
 * Process a single event for an agent.
 */
async function processEvent(agentName, config, event, eventBus) {
  console.log(`[Pipeline] ${agentName} processing ${event.type} (${event.id})`);

  const personality = await findPersonality(agentName);
  const prompt = await buildPrompt(agentName, event);

  const result = await runAgent({
    agentName,
    personality,
    prompt,
    model: config.model,
    taskId: event.payload?.taskId || event.id,
    correlationId: event.correlationId,
  });

  console.log(`[Pipeline] ${agentName} completed in ${result.duration}ms (exit: ${result.exitCode})`);

  // Parse agent JSON output
  let agentOutput = {};
  try {
    agentOutput = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try { agentOutput = JSON.parse(match[0]); } catch {}
    }
  }

  // Write agent output to vault
  const outputDir = join(VAULT_PATH, config.outputDir);
  await mkdir(outputDir, { recursive: true });
  const outputFile = join(outputDir, `${event.correlationId || "manual"}-${agentName}-${event.payload?.taskId || "output"}.md`);
  const outputContent = [
    "---",
    `agent: ${agentName}`,
    `event: ${event.type}`,
    `task: ${event.payload?.taskId || "unknown"}`,
    `duration: ${result.duration}ms`,
    `timestamp: ${new Date().toISOString()}`,
    `correlationId: ${event.correlationId || "manual"}`,
    "---",
    "",
    result.output,
  ].join("\n");
  await writeFile(outputFile, outputContent);

  // Write agent memory
  await extractMemory(agentName, event, agentOutput, result);

  // Determine what to publish downstream
  let publishType = config.publishType;
  if (!publishType) {
    // Agent-specific verdict logic
    const verdict = agentOutput.verdict || agentOutput.status;
    if (agentName === "reviewer") {
      publishType = verdict === "pass" ? "review:passed" : "review:failed";
    } else if (agentName === "tester") {
      publishType = verdict === "pass" ? "test:passed" : "test:failed";
    } else if (agentName === "devops") {
      publishType = verdict === "deployed" || agentOutput.status === "deployed"
        ? "deploy:completed" : "deploy:failed";
    }
  }

  // Publish downstream event
  if (publishType && config.publishStream) {
    await eventBus.publish(config.publishStream, {
      type: publishType,
      source: agentName,
      correlationId: event.correlationId,
      payload: {
        taskId: event.payload?.taskId,
        upstreamOutput: result.output.slice(0, 4000), // Truncate for event size
        ...agentOutput,
      },
    });
    console.log(`[Pipeline] ${agentName} published ${publishType} to ${config.publishStream}`);
  }

  // Handle failures: notify and trigger fix-forward
  if (publishType?.includes("failed")) {
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: `${agentName}:failed`,
      source: agentName,
      correlationId: event.correlationId,
      payload: {
        taskId: event.payload?.taskId,
        reason: agentOutput.summary || "Agent reported failure",
        issues: agentOutput.issues,
      },
    });

    // Fix-forward: create a fix task for the failing step
    await handleFailure(
      { type: publishType, correlationId: event.correlationId, payload: { taskId: event.payload?.taskId, summary: agentOutput.summary, issues: agentOutput.issues } },
      eventBus
    );
  }

  // After DevOps completes (success or fail), publish cycle:report to trigger Meta analysis
  if (agentName === "devops") {
    await eventBus.publish(STREAMS.META, {
      type: "cycle:report",
      source: "orchestrator",
      correlationId: event.correlationId,
      payload: { trigger: "pipeline_complete" },
    });
  }

  return { agentOutput, publishType, result };
}

/**
 * Extract learnings from agent output and write to memories/{agent}/
 */
async function extractMemory(agentName, event, agentOutput, result) {
  const memoryDir = join(VAULT_PATH, "memories", agentName);
  await mkdir(memoryDir, { recursive: true });

  // Only write memory if the agent produced meaningful output
  if (!result.output || result.output.length < 50) return;

  const date = new Date().toISOString().split("T")[0];
  const memoryFile = join(memoryDir, `${date}-${event.correlationId || "manual"}.md`);

  const memoryContent = [
    "---",
    `agent: ${agentName}`,
    `date: ${date}`,
    `event: ${event.type}`,
    `task: ${event.payload?.taskId || "unknown"}`,
    `duration: ${result.duration}ms`,
    `exitCode: ${result.exitCode}`,
    "---",
    "",
    `## Summary`,
    agentOutput.summary || "(no summary)",
    "",
    `## Key Decisions`,
    agentOutput.reasoning || agentOutput.recommendation || "(none recorded)",
    "",
    `## Outcome`,
    agentOutput.verdict || agentOutput.status || "completed",
  ].join("\n");

  await writeFile(memoryFile, memoryContent);
}

/**
 * Start the agent pipeline. Each agent runs as a consumer on its Redis stream.
 * Agents process events sequentially within their consumer group.
 */
async function startPipeline(eventBus) {
  console.log("[Pipeline] Starting agent pipeline...");

  for (const [agentName, config] of Object.entries(AGENT_PIPELINE)) {
    // Start each agent's consumer loop (non-blocking)
    consumeForAgent(agentName, config, eventBus).catch((err) => {
      console.error(`[Pipeline] Fatal error in ${agentName} consumer:`, err);
    });
    console.log(`[Pipeline] ${agentName} listening on ${config.stream} (group: ${config.group})`);
  }

  // Start Meta agent consumer on hydra:meta stream
  consumeMetaAgent(eventBus).catch((err) => {
    console.error(`[Pipeline] Fatal error in meta consumer:`, err);
  });
  console.log(`[Pipeline] meta listening on ${STREAMS.META} (group: meta)`);
}

async function consumeMetaAgent(eventBus) {
  const consumer = `meta-${process.pid}`;

  await eventBus.consume(
    STREAMS.META,
    "meta",
    consumer,
    async (event) => {
      if (event.type === "cycle:report" || event.type === "eval:failed") {
        console.log(`[Pipeline] meta processing ${event.type}`);
        await runMetaAnalysis(eventBus, event);
      }
    },
    { count: 1, blockMs: 10000 }
  );
}

async function consumeForAgent(agentName, config, eventBus) {
  const consumer = `${agentName}-${process.pid}`;

  await eventBus.consume(
    config.stream,
    config.group,
    consumer,
    async (event) => {
      // Apply event type filter
      if (!config.filter(event)) {
        return; // ACK and skip — this event isn't for us
      }
      await processEvent(agentName, config, event, eventBus);
    },
    { count: 1, blockMs: 5000 }
  );
}

/**
 * Stop the pipeline.
 */
function stopPipeline(eventBus) {
  eventBus.stopConsuming();
  console.log("[Pipeline] Pipeline stopped");
}

export { startPipeline, stopPipeline, processEvent, AGENT_PIPELINE };
