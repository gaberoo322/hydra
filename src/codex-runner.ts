/**
 * Codex Runner — Agent execution via the Codex SDK.
 *
 * Replaces the previous spawn-based approach with in-process SDK calls.
 * Benefits: no process overhead, prompt caching via threads, streaming,
 * structured output via outputSchema.
 */

import { Codex, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

import { getDailySpend, DAILY_COST_CAP_USD } from "./scheduler.ts";

// Model routing table — default tiers (used when under daily spend cap)
const MODEL_TIERS = {
  frontier: "gpt-5.5",
  codex: "gpt-5.3-codex",
  rapid: "gpt-5.3-codex-spark",
  nano: "gpt-5.4-nano",
  efficiency: "gpt-5.4-nano",
};

// Fallback tiers — used when daily spend cap is exceeded.
const MODEL_TIERS_FALLBACK = {
  frontier: "gpt-5.3-codex-spark",
  codex: "gpt-5.3-codex-spark",
  rapid: "gpt-5.3-codex-spark",
  nano: "gpt-5.4-nano",
  efficiency: "gpt-5.4-nano",
};

// Pricing per million tokens (USD)
const MODEL_PRICING = {
  "gpt-5.5":             { input: 3.00, output: 15.00 },
  "gpt-5.4":             { input: 2.50, output: 15.00 },
  "gpt-5.3-codex":       { input: 1.75, output: 14.00 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14.00 },
  "gpt-5.4-mini":        { input: 0.75, output: 4.50 },
  "gpt-5.4-nano":        { input: 0.20, output: 1.25 },
};

async function resolveModel(tierOrModel: string): Promise<string> {
  if (!MODEL_TIERS[tierOrModel]) return tierOrModel;
  try {
    const spend = await getDailySpend();
    if (spend.usd >= DAILY_COST_CAP_USD) {
      const fallback = MODEL_TIERS_FALLBACK[tierOrModel] || MODEL_TIERS_FALLBACK.codex;
      console.log(`[CodexRunner] Spend cap hit ($${spend.usd.toFixed(2)}/$${DAILY_COST_CAP_USD}) — ${tierOrModel} → ${fallback}`);
      return fallback;
    }
  } catch { /* use default tiers */ }
  return MODEL_TIERS[tierOrModel];
}

function computeCost(modelId, usage) {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing || !usage) return 0;
  const inputCost = (usage.inputTokens || usage.input_tokens || 0) / 1_000_000 * pricing.input;
  const outputCost = (usage.outputTokens || usage.output_tokens || 0) / 1_000_000 * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

// Per-agent timeout in ms
const AGENT_TIMEOUTS = {
  planner: 600_000,
  executor: 600_000,
  skeptic: 600_000,
  strategist: 600_000,
  builder: 600_000,
  meta: 600_000,
  "domain-researcher": 600_000,
  "technical-researcher": 600_000,
  "market-researcher": 600_000,
  "research-strategist": 600_000,
  "director": 600_000,
  "fixer": 600_000,
};

// Agents that only produce text/JSON and don't need file/shell access
const READ_ONLY_AGENTS = new Set(["planner", "skeptic", "meta", "high-risk-review"]);

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

// Legacy function — kept for backward compatibility with buildCodexArgs callers
function buildCodexArgs({ prompt, model, workDir }) {
  const args = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
  if (model) args.push("--model", model);
  if (workDir) args.push("--cd", workDir);
  args.push(prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Singleton Codex SDK instance + persistent threads for prompt caching
// ---------------------------------------------------------------------------

let _codex: InstanceType<typeof Codex> | null = null;

function getCodex(): InstanceType<typeof Codex> {
  if (!_codex) {
    _codex = new Codex();
    console.log("[CodexRunner] Codex SDK initialized");
  }
  return _codex;
}

// Persistent threads per agent — reusing a thread lets the model cache
// the system prompt tokens across turns, reducing input cost by 40-80%.
// Threads are keyed by (agentName, model) and recreated on error.
const _persistentThreads = new Map<string, { thread: InstanceType<typeof import("@openai/codex-sdk").Thread>; createdAt: number }>();
const THREAD_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours — prevent unbounded context growth

function getOrCreateThread(
  agentName: string,
  threadOptions: ThreadOptions,
  resolvedModel: string,
): { thread: InstanceType<typeof import("@openai/codex-sdk").Thread>; reused: boolean } {
  // Only reuse threads for read-only agents (planner, skeptic, meta)
  // Executor needs a fresh thread per cycle (file state changes between cycles)
  if (!READ_ONLY_AGENTS.has(agentName)) {
    return { thread: getCodex().startThread(threadOptions), reused: false };
  }

  const key = `${agentName}:${resolvedModel}`;
  const existing = _persistentThreads.get(key);

  if (existing && (Date.now() - existing.createdAt) < THREAD_MAX_AGE_MS) {
    return { thread: existing.thread, reused: true };
  }

  // Create new thread and cache it
  const thread = getCodex().startThread(threadOptions);
  _persistentThreads.set(key, { thread, createdAt: Date.now() });
  if (existing) {
    console.log(`[CodexRunner] Recycled stale ${agentName} thread (age: ${Math.round((Date.now() - existing.createdAt) / 60000)}m)`);
  }
  return { thread, reused: false };
}

// Invalidate a persistent thread on error so the next call gets a fresh one
function invalidateThread(agentName: string, resolvedModel: string) {
  const key = `${agentName}:${resolvedModel}`;
  if (_persistentThreads.delete(key)) {
    console.log(`[CodexRunner] Invalidated ${agentName} thread after error`);
  }
}

// Global stream callback — set by the orchestrator to broadcast agent output
let _globalStreamCallback: ((data: any) => void) | null = null;

function setAgentStreamCallback(cb: ((data: any) => void) | null) {
  _globalStreamCallback = cb;
}

/**
 * Run a task using the Codex SDK.
 */
async function runAgent({ agentName, personality, prompt, model, taskId, correlationId, workDir, onStream, outputSchema }: any) {
  const streamFn = onStream || _globalStreamCallback;
  const startTime = Date.now();
  const resolvedModel = await resolveModel(model || "frontier");
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

  // Load agent-specific feedback
  const feedbackPath = join(CONFIG_PATH, "feedback", `to-${agentName}.md`);
  let feedback = "";
  try {
    feedback = await readFile(feedbackPath, "utf-8");
  } catch { /* intentional: no feedback file */ }

  const fullPrompt = composePrompt({ prompt, systemPrompt, feedback, workDir: workspaceDir });

  // Configure thread based on agent type
  const isReadOnly = READ_ONLY_AGENTS.has(agentName);
  const threadOptions: ThreadOptions = {
    model: resolvedModel,
    workingDirectory: workspaceDir,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    sandboxMode: isReadOnly ? "read-only" : "danger-full-access",
  };

  const timeout = AGENT_TIMEOUTS[agentName] || 300_000;
  const { thread, reused } = getOrCreateThread(agentName, threadOptions, resolvedModel);
  if (reused) {
    console.log(`[CodexRunner] Reusing persistent ${agentName} thread (prompt caching active)`);
  }

  // Set up abort controller for timeout
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    console.error(`[CodexRunner] ${agentName} timed out after ${timeout / 1000}s — aborting`);
    abortController.abort();
  }, timeout);

  let finalMessage = "";
  let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  let timedOut = false;
  let usageLimitHit = false;
  let exitCode = 0;

  try {
    const turnOptions: TurnOptions = {
      signal: abortController.signal,
      ...(outputSchema ? { outputSchema } : {}),
    };

    // Use streaming for real-time output to dashboard
    const streamed = await thread.runStreamed(fullPrompt, turnOptions);

    for await (const event of streamed.events) {
      // Stream events to the dashboard callback
      if (streamFn) {
        streamFn({ agent: agentName, taskId, correlationId, event });
      }

      // Collect usage and final message
      if (event.type === "turn.completed") {
        const u = event.usage;
        usage.inputTokens += u.input_tokens || 0;
        usage.outputTokens += u.output_tokens || 0;
        usage.cachedInputTokens += u.cached_input_tokens || 0;
      }

      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalMessage = event.item.text;
      }

      if (event.type === "error" && event.message?.includes("usage limit")) {
        usageLimitHit = true;
        console.error(`[CodexRunner] Codex usage limit hit for ${agentName}`);
      }

      if (event.type === "turn.failed") {
        const errMsg = event.error?.message || "unknown";
        if (errMsg.includes("UsageLimitExceeded")) {
          usageLimitHit = true;
        }
        console.error(`[CodexRunner] Turn failed for ${agentName}: ${errMsg}`);
        exitCode = 1;
      }
    }
  } catch (err: any) {
    // Invalidate persistent thread on error so next call gets a fresh one
    invalidateThread(agentName, resolvedModel);
    if (abortController.signal.aborted) {
      timedOut = true;
      console.error(`[CodexRunner] ${agentName} aborted after timeout`);
    } else {
      console.error(`[CodexRunner] ${agentName} error: ${err.message}`);
      exitCode = 1;
    }
  } finally {
    clearTimeout(timer);
  }

  const duration = Date.now() - startTime;

  // Write agent output to Redis (2-day TTL)
  const summaryKey = `hydra:reports:summary:${correlationId || "manual"}-${agentName}-${taskId || randomUUID().slice(0, 8)}`;
  const outputContent = JSON.stringify({
    agent: agentName,
    task: taskId || "manual",
    model: resolvedModel,
    duration,
    exitCode,
    signal: null,
    timedOut,
    timeoutMs: timeout,
    killSignal: null,
    timestamp: new Date().toISOString(),
    correlationId: correlationId || "manual",
    output: finalMessage,
  });

  try {
    const Redis = (await import("ioredis")).default;
    const summaryConn = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
    await (summaryConn as any).set(summaryKey, outputContent, "EX", 2 * 24 * 60 * 60);
    (summaryConn as any).disconnect();
  } catch (err) {
    console.error(`[CodexRunner] Failed to write summary to Redis:`, err.message);
  }

  const costUsd = computeCost(resolvedModel, usage);

  return {
    output: finalMessage,
    exitCode,
    signal: null,
    timedOut,
    timeout,
    killSignal: null,
    duration,
    usage,
    costUsd,
    model: resolvedModel,
    stderr: "",
    usageLimitHit,
  };
}

/**
 * Find the personality file for an agent.
 */
async function findPersonality(agentName) {
  const customPath = join(CONFIG_PATH, "agents", `${agentName}.md`);
  try {
    await readFile(customPath);
    return customPath;
  } catch { /* intentional: no custom personality */ }

  const AGENTS_PATH = process.env.HYDRA_AGENTS_PATH || resolve(process.env.HOME, "agency-agents");
  const agentMap = {
    planner: "product/product-manager.md",
    executor: "engineering/engineering-senior-developer.md",
    skeptic: "engineering/engineering-code-reviewer.md",
    strategist: "product/product-manager.md",
    builder: "engineering/engineering-senior-developer.md",
    meta: "engineering/engineering-sre.md",
  };

  const mapped = agentMap[agentName];
  if (mapped) {
    const agencyPath = join(AGENTS_PATH, mapped);
    try {
      await readFile(agencyPath);
      return agencyPath;
    } catch { /* intentional: no agency personality */ }
  }

  return null;
}

/**
 * Search OpenViking knowledge base for relevant context.
 */
async function searchKnowledge(query, limit = 5, sessionId = null) {
  const ovUrl = process.env.OPENVIKING_URL || "http://localhost:1933";
  try {
    const ovKey = process.env.OPENVIKING_API_KEY || "1080bb34205409e58aa433512cb5e5d6344560adce963c442543001808181115";
    const body: Record<string, any> = { query, limit };
    if (sessionId) body.session_id = sessionId;

    const res = await fetch(`${ovUrl}/api/v1/search/find`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": ovKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const data = await res.json();

    const resources = data?.result?.resources || [];
    const memories = data?.result?.memories || [];
    const all = [...resources, ...memories];
    if (all.length === 0) return "";

    const formatted = all.slice(0, limit).map((r, i) => {
      const title = r.title || r.uri || r.path || r.name || `Result ${i + 1}`;
      const score = r.score != null ? ` (${(r.score * 100).toFixed(0)}%)` : "";
      const snippet = (r.abstract || r.content || r.snippet || "").slice(0, 300);
      return `- **${title}**${score}: ${snippet}`;
    }).join("\n");

    return `\n## KNOWLEDGE CONTEXT (from OpenViking)\n${formatted}\n`;
  } catch {
    return "";
  }
}

export { runAgent, findPersonality, searchKnowledge, MODEL_TIERS, MODEL_PRICING, composePrompt, buildCodexArgs, computeCost, setAgentStreamCallback };
