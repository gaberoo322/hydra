import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const AGENTS_PATH = process.env.HYDRA_AGENTS_PATH || resolve(process.env.HOME, "agency-agents");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");
const CODEX_BIN = process.env.CODEX_BIN || "codex";

// Model routing table from TDD §13
const MODEL_TIERS = {
  frontier: "gpt-5.4",
  codex: "gpt-5.3-codex",
  efficiency: "gpt-5.4-mini",
};

// Per-agent timeout in ms
const AGENT_TIMEOUTS = {
  planner: 120_000,
  executor: 600_000,
  skeptic: 120_000,
  strategist: 120_000,  // alias for planner (legacy personality fallback)
  builder: 600_000,     // alias for executor (legacy personality fallback)
  meta: 180_000,
};

function composePrompt({ prompt, systemPrompt, feedback, workDir }) {
  const parts = [];

  if (systemPrompt?.trim()) {
    parts.push("## Personality File");
    parts.push(systemPrompt.trim());
  }

  if (workDir) {
    parts.push("## Workspace");
    parts.push(`Primary workspace: ${workDir}`);
    parts.push("You are expected to inspect and modify files in this workspace when the task requires it.");
  }

  parts.push(prompt);

  if (feedback?.trim()) {
    parts.push("## Human Feedback");
    parts.push(feedback.trim());
  }

  return parts.join("\n\n");
}

function buildCodexArgs({ prompt, model, workDir }) {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];

  if (model) {
    args.push("--model", model);
  }

  if (workDir) {
    args.push("--cd", workDir);
  }

  args.push(prompt);

  return args;
}

/**
 * Run a task using Codex CLI with an agent personality.
 *
 * @param {object} opts
 * @param {string} opts.agentName    - Agent name (e.g., "strategist", "builder")
 * @param {string} opts.personality  - Path to .md personality file
 * @param {string} opts.prompt       - The task prompt
 * @param {string} opts.model        - Model tier key or model ID
 * @param {string} opts.taskId       - Task ID for tracking
 * @param {string} opts.correlationId - Cycle correlation ID
 * @param {string} opts.workDir      - Working directory for codex (defaults to vault)
 * @returns {object} { output, exitCode, duration }
 */
async function runAgent({ agentName, personality, prompt, model, taskId, correlationId, workDir }) {
  const startTime = Date.now();
  const resolvedModel = MODEL_TIERS[model] || model || MODEL_TIERS.frontier;
  const outputDir = join(HYDRA_PATH, "reports", "cycle-summaries");
  await mkdir(outputDir, { recursive: true });
  const workspaceDir = workDir || PROJECT_WORKSPACE;

  // Load personality file
  let systemPrompt = "";
  if (personality) {
    try {
      systemPrompt = await readFile(personality, "utf-8");
    } catch (err) {
      console.error(`[CodexRunner] Failed to load personality ${personality}:`, err.message);
    }
  }

  // Load agent-specific feedback from vault
  const feedbackPath = join(HYDRA_PATH, "agent-feedback", `to-${agentName}.md`);
  let feedback = "";
  try {
    feedback = await readFile(feedbackPath, "utf-8");
  } catch {}

  // Build the full prompt with context
  const fullPrompt = composePrompt({
    prompt,
    systemPrompt,
    feedback,
    workDir: workspaceDir,
  });
  const args = buildCodexArgs({
    prompt: fullPrompt,
    model: resolvedModel,
    workDir: workspaceDir,
  });

  // Don't set CODEX_API_KEY — let codex use its OAuth auth from ~/.codex/auth.json
  const env = { ...process.env };

  const timeout = AGENT_TIMEOUTS[agentName] || 300_000;

  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: workspaceDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Kill if agent exceeds timeout — SIGTERM first, SIGKILL after 10s if still alive
    const timer = setTimeout(() => {
      console.error(`[CodexRunner] ${agentName} timed out after ${timeout / 1000}s — sending SIGTERM`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          console.error(`[CodexRunner] ${agentName} did not exit after SIGTERM — sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, 10_000);
    }, timeout);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("close", async (exitCode) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      // Parse JSON lines output for the final message and token usage
      let finalMessage = "";
      let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "item.completed" && evt.item?.text) {
            finalMessage = evt.item.text;
          }
          if (evt.type === "turn.completed" && evt.usage) {
            usage.inputTokens += evt.usage.input_tokens || 0;
            usage.outputTokens += evt.usage.output_tokens || 0;
            usage.cachedInputTokens += evt.usage.cached_input_tokens || 0;
          }
        } catch {}
      }

      // If no structured output, use raw stdout
      if (!finalMessage) {
        finalMessage = stdout.trim();
      }


      // Write agent output to vault
      const outputFile = join(
        outputDir,
        `${correlationId || "manual"}-${agentName}-${taskId || randomUUID().slice(0, 8)}.md`
      );
      const outputContent = [
        "---",
        `agent: ${agentName}`,
        `task: ${taskId || "manual"}`,
        `model: ${resolvedModel}`,
        `duration: ${duration}ms`,
        `exitCode: ${exitCode}`,
        `timestamp: ${new Date().toISOString()}`,
        `correlationId: ${correlationId || "manual"}`,
        "---",
        "",
        finalMessage,
      ].join("\n");

      try {
        await writeFile(outputFile, outputContent);
      } catch (err) {
        console.error(`[CodexRunner] Failed to write output:`, err.message);
      }

      resolve({
        output: finalMessage,
        exitCode,
        duration,
        outputFile,
        usage,
        stderr: stderr.trim(),
      });
    });

    child.on("error", (err) => {
      reject(new Error(`[CodexRunner] Failed to spawn codex: ${err.message}`));
    });
  });
}

/**
 * Find the personality file for an agent.
 * Looks in orchestrator/config/agents/ first, then falls back to agency-agents repo.
 */
async function findPersonality(agentName) {
  // Check custom personalities first
  const customPath = join(HYDRA_PATH, "agent-config", `${agentName}.md`);
  try {
    await readFile(customPath);
    return customPath;
  } catch {}

  // Fall back to agency-agents repo — search by role name
  // V2 agents map to their personalities; legacy names kept as fallbacks
  const agentMap = {
    planner: "product/product-manager.md",
    executor: "engineering/engineering-senior-developer.md",
    skeptic: "engineering/engineering-code-reviewer.md",
    strategist: "product/product-manager.md",    // fallback for planner
    builder: "engineering/engineering-senior-developer.md", // fallback for executor
    meta: "engineering/engineering-sre.md",
  };

  const mapped = agentMap[agentName];
  if (mapped) {
    const agencyPath = join(AGENTS_PATH, mapped);
    try {
      await readFile(agencyPath);
      return agencyPath;
    } catch {}
  }

  return null;
}

export { runAgent, findPersonality, MODEL_TIERS, composePrompt, buildCodexArgs };
