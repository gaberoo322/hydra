import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const AGENTS_PATH = process.env.HYDRA_AGENTS_PATH || resolve(process.env.HOME, "agency-agents");
const CODEX_BIN = process.env.CODEX_BIN || "codex";

// Model routing table from TDD §13
const MODEL_TIERS = {
  frontier: "gpt-5.4",
  codex: "gpt-5.3-codex",
  efficiency: "gpt-5.4-mini",
};

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
  const outputDir = join(VAULT_PATH, "reports", "cycle-summaries");
  await mkdir(outputDir, { recursive: true });

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
  const feedbackPath = join(VAULT_PATH, "agent-feedback", `to-${agentName}.md`);
  let feedback = "";
  try {
    feedback = await readFile(feedbackPath, "utf-8");
  } catch {}

  // Build the full prompt with context
  const fullPrompt = [
    prompt,
    feedback ? `\n\n## Human Feedback\n${feedback}` : "",
  ].join("");

  // Run codex exec with full system access (agents need shell, git, etc.)
  const args = [
    "exec",
    "--full-auto",
    "--json",
    "--skip-git-repo-check",
    "--sandbox", "danger-full-access",
  ];

  // Don't set CODEX_API_KEY — let codex use its OAuth auth from ~/.codex/auth.json
  const env = { ...process.env };

  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, [...args, fullPrompt], {
      cwd: workDir || VAULT_PATH,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("close", async (exitCode) => {
      const duration = Date.now() - startTime;

      // Parse JSON lines output for the final message
      let finalMessage = "";
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          const evt = JSON.parse(line);
          // Codex CLI outputs item.completed with item.text containing the agent's response
          if (evt.type === "item.completed" && evt.item?.text) {
            finalMessage = evt.item.text;
          }
        } catch {}
      }

      // If no structured output, use raw stdout
      if (!finalMessage) {
        finalMessage = stdout.trim();
      }


      // Write agent output to vault
      const outputFile = join(
        VAULT_PATH,
        "reports",
        "cycle-summaries",
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
  const customPath = join(VAULT_PATH, "orchestrator", "config", `${agentName}.md`);
  try {
    await readFile(customPath);
    return customPath;
  } catch {}

  // Fall back to agency-agents repo — search by role name
  const agentMap = {
    strategist: "product/product-manager.md",
    researcher: "product/product-trend-researcher.md",
    architect: "engineering/engineering-software-architect.md",
    builder: "engineering/engineering-senior-developer.md",
    reviewer: "engineering/engineering-code-reviewer.md",
    tester: "testing/testing-evidence-collector.md",
    devops: "engineering/engineering-devops-automator.md",
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

export { runAgent, findPersonality, MODEL_TIERS };
