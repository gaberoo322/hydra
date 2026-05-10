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
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://100.125.108.68:11434";

import { getDailySpend, DAILY_COST_CAP_USD } from "./scheduler.ts";
import { redisKeys } from "./redis-keys.ts";
import { buildCodexOtelEnv, isOtelEnabled, type OtelAttrs } from "./codex-otel.ts";

// Model routing table — default tiers (used when under daily spend cap)
const MODEL_TIERS = {
  frontier: "gpt-5.5",
  codex: "gpt-5.3-codex",
  rapid: "gpt-5.3-codex-spark",
  mini: "gpt-5.4-mini",
  local: "gemma-4-26b",
};

// Fallback tiers — used when daily spend cap is exceeded.
const MODEL_TIERS_FALLBACK = {
  frontier: "gpt-5.3-codex-spark",
  codex: "gpt-5.3-codex-spark",
  rapid: "gpt-5.3-codex-spark",
  mini: "gpt-5.4-mini",
};

// Pricing per million tokens (USD)
const MODEL_PRICING = {
  "gpt-5.5":             { input: 3.00, output: 15.00 },
  "gpt-5.4":             { input: 2.50, output: 15.00 },
  "gpt-5.3-codex":       { input: 1.75, output: 14.00 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14.00 },
  "gpt-5.4-mini":        { input: 0.75, output: 4.50 },
  "gemma-4-26b":         { input: 0, output: 0 },
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
  } catch { /* intentional: spend lookup failure leaves caller on default tiers */ }
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
  executor: 600_000, // default; overridden by getExecutorTimeout() per complexity
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

/**
 * Return executor timeout in ms based on task complexity.
 * quick-fix: 600s, standard: 900s, complex/high-risk: 1200s.
 */
function getExecutorTimeout(complexity: string): number {
  switch (complexity) {
    case "quick-fix": return 600_000;
    case "complex":
    case "high-risk": return 1_200_000;
    case "standard":
    default: return 900_000;
  }
}

// Agents that only produce text/JSON and don't need file/shell access
const READ_ONLY_AGENTS = new Set(["planner", "skeptic", "meta", "high-risk-review"]);

function composePrompt({ prompt, systemPrompt, feedback, workDir, coreMemory }: {
  prompt: string; systemPrompt?: string; feedback?: string; workDir?: string; coreMemory?: string;
}) {
  const parts = [];
  if (systemPrompt?.trim()) {
    parts.push("## Personality File");
    parts.push(systemPrompt.trim());
  }
  // Core memory — cardinal rules that apply to ALL tasks, injected before task context
  if (coreMemory?.trim()) {
    parts.push(coreMemory.trim());
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
// Codex SDK instances + persistent threads for prompt caching
// ---------------------------------------------------------------------------
//
// Two modes:
//   1. Default — singleton Codex (no per-call env), Thread objects cached.
//   2. OTel-enabled (HYDRA_OTEL_ENABLED=true) — per-call Codex with
//      OTEL_RESOURCE_ATTRIBUTES env merged with Hydra context (cycle_id,
//      agent_role, etc). Persistent thread cache stores thread IDs and
//      re-binds them via resumeThread() so prompt caching still works
//      across cycles even though the Codex instance changes per call.

let _codex: InstanceType<typeof Codex> | null = null;

function getDefaultCodex(): InstanceType<typeof Codex> {
  if (!_codex) {
    _codex = new Codex();
    console.log("[CodexRunner] Codex SDK initialized");
  }
  return _codex;
}

/**
 * Build a Codex instance for one agent call. When OTel is enabled we
 * construct a fresh Codex with per-call resource attributes; otherwise
 * we reuse the process-wide singleton.
 */
function getCodexForCall(otelAttrs: OtelAttrs): InstanceType<typeof Codex> {
  const env = buildCodexOtelEnv(otelAttrs);
  if (env) return new Codex({ env });
  return getDefaultCodex();
}

type PersistentThreadEntry = {
  // First-call thread is held in-memory until its id is populated; subsequent
  // calls resume by id (which works across Codex instances, enabling per-call
  // OTel env without losing prompt-cache-friendly conversation continuity).
  thread: InstanceType<typeof import("@openai/codex-sdk").Thread> | null;
  threadId: string | null;
  createdAt: number;
};

const _persistentThreads = new Map<string, PersistentThreadEntry>();
const THREAD_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours — prevent unbounded context growth

function getOrCreateThread(
  agentName: string,
  threadOptions: ThreadOptions,
  resolvedModel: string,
  otelAttrs: OtelAttrs,
): { thread: InstanceType<typeof import("@openai/codex-sdk").Thread>; reused: boolean; entry?: PersistentThreadEntry } {
  // Only reuse threads for read-only agents (planner, skeptic, meta).
  // Executor needs a fresh thread per cycle (file state changes between cycles).
  if (!READ_ONLY_AGENTS.has(agentName)) {
    const codex = getCodexForCall(otelAttrs);
    return { thread: codex.startThread(threadOptions), reused: false };
  }

  const key = `${agentName}:${resolvedModel}`;
  const existing = _persistentThreads.get(key);

  if (existing && (Date.now() - existing.createdAt) < THREAD_MAX_AGE_MS) {
    const codex = getCodexForCall(otelAttrs);
    // Prefer resumeThread() once we know the id — it works across Codex
    // instances and is required when OTel attaches per-call env.
    if (existing.threadId) {
      return {
        thread: codex.resumeThread(existing.threadId, threadOptions),
        reused: true,
        entry: existing,
      };
    }
    // First-call still in flight — fall back to the cached Thread object.
    if (existing.thread) {
      return { thread: existing.thread, reused: true, entry: existing };
    }
  }

  // Create new thread and cache it
  const codex = getCodexForCall(otelAttrs);
  const thread = codex.startThread(threadOptions);
  const entry: PersistentThreadEntry = { thread, threadId: null, createdAt: Date.now() };
  _persistentThreads.set(key, entry);
  if (existing) {
    console.log(`[CodexRunner] Recycled stale ${agentName} thread (age: ${Math.round((Date.now() - existing.createdAt) / 60000)}m)`);
  }
  return { thread, reused: false, entry };
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

// ---------------------------------------------------------------------------
// Ollama local model support — health-checked with fallback to mini
// ---------------------------------------------------------------------------

let _ollamaHealthy: boolean | null = null;
let _ollamaHealthCheckedAt = 0;
const OLLAMA_HEALTH_CACHE_MS = 60_000;
const OLLAMA_MODEL_NAME = "gemma4:26b";

async function isOllamaAvailable(): Promise<boolean> {
  if (process.env.OLLAMA_DISABLED === "true") {
    return false;
  }
  if (Date.now() - _ollamaHealthCheckedAt < OLLAMA_HEALTH_CACHE_MS && _ollamaHealthy !== null) {
    return _ollamaHealthy;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    _ollamaHealthy = res.ok;
  } catch {
    _ollamaHealthy = false;
  }
  _ollamaHealthCheckedAt = Date.now();
  if (!_ollamaHealthy) {
    console.warn(`[CodexRunner] Ollama at ${OLLAMA_HOST} is unreachable — will fall back to mini`);
  }
  return _ollamaHealthy;
}

async function runLocalAgent({ agentName, personality, prompt, workDir, timeout: timeoutMs }: any) {
  const startTime = Date.now();
  const effectiveTimeout = timeoutMs || AGENT_TIMEOUTS[agentName] || 120_000;

  // Load personality + feedback + core memory using existing composePrompt()
  let systemPrompt = "";
  if (personality) {
    try { systemPrompt = await readFile(personality, "utf-8"); } catch { /* intentional: personality file optional — fall through to empty prompt */ }
  }
  const feedbackPath = join(CONFIG_PATH, "feedback", `to-${agentName}.md`);
  let feedback = "";
  try { feedback = await readFile(feedbackPath, "utf-8"); } catch { /* intentional: feedback file optional — no operator notes for this agent */ }
  const coreMemoryPath = join(CONFIG_PATH, "core-memory", `${agentName}.md`);
  let coreMemory = "";
  try { coreMemory = await readFile(coreMemoryPath, "utf-8"); } catch { /* intentional: core-memory file optional — no consolidated patterns yet */ }

  const fullPrompt = composePrompt({ prompt, systemPrompt, feedback, workDir, coreMemory });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  let output = "";
  let exitCode = 0;
  let timedOut = false;

  try {
    const res = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages: [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          { role: "user", content: fullPrompt },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[CodexRunner] Ollama returned ${res.status}: ${errText.slice(0, 200)}`);
      exitCode = 1;
    } else {
      const data = await res.json();
      output = data.choices?.[0]?.message?.content || "";
    }
  } catch (err: any) {
    if (controller.signal.aborted) {
      timedOut = true;
      console.error(`[CodexRunner] Local agent ${agentName} timed out after ${effectiveTimeout / 1000}s`);
    } else {
      console.error(`[CodexRunner] Local agent ${agentName} error: ${err.message}`);
      exitCode = 1;
    }
  } finally {
    clearTimeout(timer);
  }

  const duration = Date.now() - startTime;
  console.log(`[CodexRunner] Local agent ${agentName} completed in ${(duration / 1000).toFixed(1)}s (model: ${OLLAMA_MODEL_NAME}, output: ${output.length} chars)`);

  return {
    output,
    exitCode,
    signal: null,
    timedOut,
    timeout: effectiveTimeout,
    killSignal: null,
    duration,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    costUsd: 0,
    model: "gemma-4-26b",
    stderr: "",
    usageLimitHit: false,
    threadReused: false,
    promptCacheRate: 0,
  };
}

/**
 * Run a task using the Codex SDK.
 */
async function runAgent({ agentName, personality, prompt, model, taskId, correlationId, workDir, onStream, outputSchema, timeout: explicitTimeout, complexity }: any) {
  const streamFn = onStream || _globalStreamCallback;
  const startTime = Date.now();
  const requestedTier = model || "frontier";
  const resolvedModel = await resolveModel(requestedTier);
  const workspaceDir = workDir || PROJECT_WORKSPACE;

  // OTel resource attributes — passed into the Codex CLI process for span
  // tagging. Disabled by default; opt in via HYDRA_OTEL_ENABLED=true.
  const otelAttrs: OtelAttrs = {
    cycleId: correlationId,
    agentName,
    taskId,
    modelTier: MODEL_TIERS[requestedTier] ? requestedTier : null,
    resolvedModel,
    complexity,
  };

  // Route to Ollama for local model tier (with fallback to mini if unavailable)
  if (resolvedModel === "gemma-4-26b") {
    const available = await isOllamaAvailable();
    if (available) {
      return runLocalAgent({ agentName, personality, prompt, model: resolvedModel, taskId, correlationId, workDir: workspaceDir });
    }
    console.log(`[CodexRunner] Ollama unavailable — falling back to mini for ${agentName}`);
    // Fall through to Codex SDK path with mini model
    const miniModel = MODEL_TIERS.mini;
    return runAgent({ agentName, personality, prompt, model: miniModel, taskId, correlationId, workDir, onStream, outputSchema, complexity });
  }

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

  // Load core memory — cardinal rules that apply to all tasks for this agent
  const coreMemoryPath = join(CONFIG_PATH, "core-memory", `${agentName}.md`);
  let coreMemory = "";
  try {
    coreMemory = await readFile(coreMemoryPath, "utf-8");
  } catch { /* intentional: no core memory file */ }

  const fullPrompt = composePrompt({ prompt, systemPrompt, feedback, workDir: workspaceDir, coreMemory });

  // Configure thread based on agent type
  const isReadOnly = READ_ONLY_AGENTS.has(agentName);
  const threadOptions: ThreadOptions = {
    model: resolvedModel,
    workingDirectory: workspaceDir,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    sandboxMode: isReadOnly ? "read-only" : "danger-full-access",
  };

  const timeout = explicitTimeout || AGENT_TIMEOUTS[agentName] || 300_000;
  const { thread, reused, entry } = getOrCreateThread(agentName, threadOptions, resolvedModel, otelAttrs);
  if (reused) {
    console.log(`[CodexRunner] Reusing persistent ${agentName} thread (prompt caching active)`);
  }
  if (isOtelEnabled()) {
    console.log(`[CodexRunner] OTel attrs: cycle=${correlationId || "n/a"} role=${agentName} model=${resolvedModel}`);
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

      // Collect usage and final message — try multiple event shapes for SDK compatibility
      if (event.type === "turn.completed") {
        const u = (event as any).usage || (event as any).data?.usage || {};
        usage.inputTokens += u.input_tokens || u.inputTokens || 0;
        usage.outputTokens += u.output_tokens || u.outputTokens || 0;
        usage.cachedInputTokens += u.cached_input_tokens || u.cachedInputTokens || 0;
      }
      // Fallback: some SDK versions report usage on response.completed
      if ((event as any).type === "response.completed" && (event as any).response?.usage) {
        const u = (event as any).response.usage;
        if (usage.inputTokens === 0 && usage.outputTokens === 0) {
          usage.inputTokens = u.input_tokens || u.inputTokens || 0;
          usage.outputTokens = u.output_tokens || u.outputTokens || 0;
          usage.cachedInputTokens = u.cached_input_tokens || u.cachedInputTokens || 0;
        }
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

    // Capture thread.id into the persistent cache so the *next* call can
    // resume by id (works across Codex instances, required when OTel
    // attaches per-call env). Safe no-op for ephemeral (executor) threads.
    if (entry && !entry.threadId && thread.id) {
      entry.threadId = thread.id;
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

  // Warn when agent ran but usage tracking failed — helps diagnose $0 cost cycles
  if (finalMessage && usage.inputTokens === 0 && usage.outputTokens === 0) {
    console.warn(`[CodexRunner] ${agentName} produced output but usage is zero — cost will be $0. SDK may not be reporting usage events.`);
  }

  // Write agent output to Redis (2-day TTL)
  const summaryKey = redisKeys.summaryReport(`${correlationId || "manual"}-${agentName}-${taskId || randomUUID().slice(0, 8)}`);
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
    const { setString: setRedisString } = await import("./redis-adapter.ts");
    await setRedisString(summaryKey, outputContent, 2 * 24 * 60 * 60);
  } catch (err) {
    console.error(`[CodexRunner] Failed to write summary to Redis:`, err.message);
  }

  const costUsd = computeCost(resolvedModel, usage);
  const cacheRate = usage.inputTokens > 0
    ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
    : 0;
  if (reused && cacheRate > 0) {
    console.log(`[CodexRunner] ${agentName} prompt cache: ${cacheRate}% of input tokens cached (saved ~$${(costUsd * cacheRate / 100).toFixed(4)})`);
  }

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
    threadReused: reused,
    promptCacheRate: cacheRate,
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
 * Uses trackedOvSearch from learning.ts for metrics tracking + fallback.
 */
async function searchKnowledge(query, limit = 5, sessionId = null) {
  try {
    const { trackedOvSearch } = await import("./learning.ts");
    const { resources, memories } = await trackedOvSearch(query, limit, sessionId);

    const all = [...resources, ...memories];
    if (all.length === 0) {
      // Issue #210: surface knowledge misses to operators when explicitly
      // enabled. Off by default to avoid log spam during routine cycles.
      if (process.env.HYDRA_LOG_KB_MISSES === "1") {
        const truncated = String(query).slice(0, 120);
        console.warn(`[KB] miss: query returned 0 results — "${truncated}"`);
      }
      return "";
    }

    const formatted = all.slice(0, limit).map((r, i) => {
      const title = r.title || r.uri || r.path || r.name || `Result ${i + 1}`;
      const score = r.score != null ? ` (${(r.score * 100).toFixed(0)}%)` : "";
      const snippet = (r.abstract || r.content || r.snippet || "").slice(0, 300);
      return `- **${title}**${score}: ${snippet}`;
    }).join("\n");

    return `\n## KNOWLEDGE CONTEXT (from OpenViking)\n${formatted}\n`;
  } catch (err) {
    // Fail loud (issue #210): silent failures hid the indexing gap for weeks.
    if (process.env.HYDRA_LOG_KB_MISSES === "1") {
      console.warn(`[KB] error during search: ${(err && err.message) || err}`);
    }
    return "";
  }
}

export { runAgent, runLocalAgent, isOllamaAvailable, findPersonality, searchKnowledge, MODEL_TIERS, MODEL_PRICING, composePrompt, buildCodexArgs, computeCost, setAgentStreamCallback, getExecutorTimeout, OLLAMA_HOST };
