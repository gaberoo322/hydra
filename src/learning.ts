/**
 * learning.ts — Unified learning system for Hydra
 *
 * Consolidates all learning subsystems into a single module:
 *   - Agent memory patterns (Redis-backed, two-tier)
 *   - Per-anchor episodic reflections (Reflexion pattern)
 *   - Global bounded reflection buffer
 *   - OpenViking session lifecycle (create, log, commit)
 *   - OV skill registration
 *   - Knowledge indexer (background config + Redis polling)
 *
 * Public API (4 exports):
 *   recordOutcome()  — record agent lessons + reflections after a cycle
 *   getContext()     — load all learning context for an agent prompt
 *   consolidate()    — prune stale patterns, commit OV session, promote rules
 *   initLearning()  — start knowledge indexer, register OV skills, migrate rules
 *
 * Internal exports (for API/scheduler backward compat):
 *   getAllReflections()       — GET /api/reflections endpoint
 *   closeReflectionsRedis()  — test cleanup (no-op, kept for compat)
 *   recordPattern()          — POST /api/memory/:agent/pattern
 *   createCycleSession()     — control-loop.ts session creation
 */

import * as Sentry from "@sentry/node";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { watch } from "node:fs";
import { join, resolve, extname, relative } from "node:path";
import { tmpdir } from "node:os";
import { redisKeys } from "./redis-keys.ts";
import {
  getRedisConnection,
  loadPatternsRaw,
  savePatternsRaw,
  getOldRulesCount,
  patternsExist,
  getOldRules,
  deleteOldRules,
  pushAnchorReflection,
  getAnchorReflections,
  deleteReflectionKey,
  pushReflection,
  getReflectionBuffer,
  replaceReflectionBuffer,
  getReportIdsByScore,
  getRealityReport,
  getReportScore,
  getMemoryPatterns,
} from "./redis-adapter.ts";

// ===========================================================================
// Section: Configuration
// ===========================================================================

const OV_URL = process.env.OPENVIKING_URL || "http://localhost:1933";
const OV_KEY = process.env.OPENVIKING_API_KEY || "56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c";
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");
const OV_CONFIG_MOUNT = process.env.OV_CONFIG_MOUNT || "/config";

const MAX_PATTERNS = 15;
const PROMOTION_THRESHOLD = 5;
const MAX_EXAMPLES = 3;
const REFLECTION_TTL = 7 * 24 * 60 * 60; // 7 days
const MAX_REFLECTIONS_PER_ANCHOR = 5;
const MAX_BUFFER_SIZE = 20;

const INDEXABLE_EXTS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS as any) || 2000;
const REDIS_POLL_MS = parseInt(process.env.INDEXER_POLL_MS as any) || 30000;

const OV_HEADERS = {
  "Content-Type": "application/json",
  "X-Api-Key": OV_KEY,
};

// ===========================================================================
// Section: Types
// ===========================================================================

export type OutcomeAgent = "planner" | "executor" | "skeptic";

export interface OutcomeOpts {
  agents: OutcomeAgent[];
  cycleId: string;
  task: any;
  finalState: string;
  anchorRef: string;
  anchorType: string;
  context?: any;
  skepticVerdict?: string;
  reflection?: {
    failureMode: string;
    whatFailed: string;
    whyItFailed: string;
    whatToTryDifferently: string;
    verificationErrors?: string[];
  };
}

type MemoryPattern = {
  category: string;
  severity: "prevent" | "reinforce";
  hitCount: number;
  firstSeen: string;
  lastSeen: string;
  lastCycleId: string;
  action: string;
  examples: string[];
  promoted: boolean;
};

type GlobalReflection = {
  cycleId: string;
  anchorType: string;
  anchorReference: string;
  failureMode: string;
  whatFailed: string;
  whyItFailed: string;
  whatToTryDifferently: string;
  timestamp: string;
};

type AnchorReflection = {
  cycleId: string;
  anchorRef: string;
  taskTitle: string;
  outcome: string;
  reason: string;
  whatWasAttempted: string;
  whyItFailed: string;
  whatShouldChange: string;
  timestamp: string;
};

// ===========================================================================
// Section: Public API — recordOutcome
// ===========================================================================

/**
 * Record outcome for one or more agents + optional reflections.
 * Never throws — all errors are logged with context.
 */
export async function recordOutcome(opts: OutcomeOpts): Promise<void> {
  const {
    agents, cycleId, task, finalState, anchorRef, anchorType,
    context = {}, skepticVerdict, reflection,
  } = opts;

  // Record per-agent lessons
  for (const agent of agents) {
    try {
      switch (agent) {
        case "planner":
          await recordPlannerLesson(cycleId, task, finalState, context);
          break;
        case "executor":
          await recordExecutorLesson(cycleId, task, finalState, context);
          break;
        case "skeptic":
          await recordSkepticLesson(cycleId, task, skepticVerdict ?? "approve", finalState);
          break;
      }
    } catch (err: any) {
      console.error(`[Learning] Failed to record ${agent} lesson for ${cycleId}: ${err.message}`);
    }
  }

  // Record reflections (both per-anchor and global) if provided
  if (reflection) {
    try {
      await recordAnchorReflection({
        cycleId,
        anchorRef,
        taskTitle: reflection.whatFailed,
        outcome: reflection.failureMode,
        reason: reflection.whyItFailed,
        verificationErrors: reflection.verificationErrors,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record per-anchor reflection for ${cycleId}: ${err.message}`);
    }

    try {
      await recordGlobalReflection({
        cycleId,
        anchorType,
        anchorReference: anchorRef,
        failureMode: reflection.failureMode,
        whatFailed: reflection.whatFailed,
        whyItFailed: reflection.whyItFailed,
        whatToTryDifferently: reflection.whatToTryDifferently,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record global reflection for ${cycleId}: ${err.message}`);
    }
  }
}

// ===========================================================================
// Section: Public API — getContext
// ===========================================================================

/**
 * Load all learning context for an agent + anchor in one call.
 * Combines agent memory, per-anchor reflections, and global reflections.
 * Never throws — individual sources degrade gracefully.
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string },
): Promise<string> {
  const parts: string[] = [];

  // 1. Agent memory patterns
  try {
    const memory = await loadAgentMemory(agent);
    const formatted = formatMemoryForPrompt(memory, agent);
    if (formatted) parts.push(formatted);
  } catch (err: any) {
    console.error(`[Learning] getContext: agent memory load failed for ${agent}: ${err.message}`);
  }

  // 2. Per-anchor episodic reflections
  try {
    const reflections = await loadAnchorReflections(anchor.reference);
    if (reflections) parts.push(reflections);
  } catch (err: any) {
    console.error(`[Learning] getContext: per-anchor reflections failed for "${anchor.reference}": ${err.message}`);
  }

  // 3. Global relevant reflections (Reflexion pattern)
  try {
    const relevant = await loadRelevantReflections(anchor);
    const formatted = formatReflectionsForPrompt(relevant);
    if (formatted) parts.push(formatted);
  } catch (err: any) {
    console.error(`[Learning] getContext: global reflections failed for "${anchor.reference}": ${err.message}`);
  }

  return parts.join("\n\n");
}

// ===========================================================================
// Section: Public API — consolidate
// ===========================================================================

/**
 * Run daily consolidation: prune stale patterns across all agents.
 * Called by the scheduler once per day.
 */
export async function consolidate(): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  for (const agent of ["planner", "executor", "skeptic"]) {
    const patterns = await loadPatterns(agent);
    const before = patterns.length;

    const kept = patterns.filter(p =>
      p.hitCount >= 2 || p.lastSeen >= cutoffStr || p.promoted
    );

    if (kept.length < before) {
      await savePatterns(agent, kept);
      console.log(`[Learning] Consolidated ${agent}: ${before} → ${kept.length} patterns (${before - kept.length} stale pruned)`);
    }
  }
}

// ===========================================================================
// Section: Public API — initLearning
// ===========================================================================

/**
 * Initialize the learning system on startup:
 *   1. Migrate old rules to patterns (one-time)
 *   2. Register OV skills (non-blocking)
 *   3. Start knowledge indexer background process
 */
export async function initLearning(): Promise<void> {
  // 1. Migrate old rules → patterns
  try {
    await migrateRulesToPatterns();
  } catch (err: any) {
    console.error(`[Learning] Memory migration failed: ${err.message}`);
  }

  // 2. Register OV skills (non-blocking)
  registerSkills().catch((err: any) => console.error(`[Learning] Skill registration failed: ${err.message}`));

  // 3. Start knowledge indexer
  startKnowledgeIndexer();
}

// ===========================================================================
// Section: Public API — clearOutcomes (post-merge cleanup)
// ===========================================================================

/**
 * Clear per-anchor and global reflections for an anchor reference.
 * Called after a successful merge. Never throws.
 */
export async function clearOutcomes(anchorRef: string): Promise<void> {
  try {
    await deleteReflectionKey(reflectionKey(anchorRef));
  } catch (err: any) {
    console.error(`[Learning] Failed to clear per-anchor reflections for "${anchorRef}": ${err.message}`);
  }

  try {
    await clearReflectionsForAnchor(anchorRef);
  } catch (err: any) {
    console.error(`[Learning] Failed to clear global reflections for "${anchorRef}": ${err.message}`);
  }
}

// ===========================================================================
// Section: Internal exports (backward compat for API/scheduler/control-loop)
// ===========================================================================

/**
 * Record a global reflection (backward compat for tests + direct API use).
 */
export async function recordReflection(opts: {
  cycleId: string;
  anchorType: string;
  anchorReference: string;
  failureMode: string;
  whatFailed: string;
  whyItFailed: string;
  whatToTryDifferently: string;
}): Promise<void> {
  await recordGlobalReflection(opts);
}

/**
 * Return all reflections in the global buffer (for GET /api/reflections).
 * Most recent first.
 */
export async function getAllReflections(): Promise<GlobalReflection[]> {
  const raw = await getReflectionBuffer();

  const reflections: GlobalReflection[] = [];
  for (const entry of raw) {
    try {
      reflections.push(JSON.parse(entry));
    } catch { /* intentional: skip unparseable entries */ }
  }

  return reflections.reverse();
}

/**
 * Close the Redis connection — kept for backward compatibility with tests.
 * The shared connection is managed by redis-adapter.
 */
export function closeReflectionsRedis() {
  // No-op: connection managed by redis-adapter singleton
}

/**
 * Record a pattern directly (for POST /api/memory/:agent/pattern).
 */
export async function recordPattern(
  agentName: string,
  category: string,
  details: {
    severity?: "prevent" | "reinforce";
    action: string;
    example: string;
    cycleId: string;
  },
) {
  const patterns = await loadPatterns(agentName);
  const today = new Date().toISOString().split("T")[0];

  const existing = patterns.find(p => p.category === category);

  if (existing) {
    existing.hitCount++;
    existing.lastSeen = today;
    existing.lastCycleId = details.cycleId;
    existing.action = details.action;
    existing.examples = [details.example, ...existing.examples].slice(0, MAX_EXAMPLES);

    if (existing.hitCount >= PROMOTION_THRESHOLD && !existing.promoted) {
      await promoteToFeedback(agentName, existing);
      existing.promoted = true;
      console.log(`[Learning] Promoted "${category}" to to-${agentName}.md (${existing.hitCount} hits)`);
    }
  } else {
    patterns.push({
      category,
      severity: details.severity || "prevent",
      hitCount: 1,
      firstSeen: today,
      lastSeen: today,
      lastCycleId: details.cycleId,
      action: details.action,
      examples: [details.example],
      promoted: false,
    });
  }

  await savePatterns(agentName, patterns);
}

/**
 * Create a new OpenViking session for a cycle.
 * Returns a session object with helper methods for logging agent interactions.
 */
export async function createCycleSession(cycleId: string) {
  const result = await ovFetch("/api/v1/sessions", {});
  if (!result?.result?.session_id) {
    console.log(`[Learning] Failed to create OV session for ${cycleId} — proceeding without`);
    return createNoOpSession(cycleId);
  }

  const sessionId = result.result.session_id;
  console.log(`[Learning] Created OV session ${sessionId} for ${cycleId}`);

  return {
    sessionId,
    cycleId,
    active: true,

    async logPlanner(anchor: any, task: any) {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "user",
        content: `[Cycle ${cycleId}] Planning task for anchor: [${anchor.type}] ${anchor.reference}\nReason: ${anchor.whyNow || ""}`,
      });
      if (task) {
        await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
          role: "assistant",
          content: `[Planner] Proposed: "${task.title}"\nScope: ${JSON.stringify(task.scopeBoundary?.in || [])}\nCriteria: ${(task.acceptanceCriteria || []).join("; ")}`,
        });
      }
    },

    async logSkeptic(verdict: string, reason?: string) {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Skeptic] Verdict: ${verdict}${reason ? ` — ${reason}` : ""}`,
      });
    },

    async logExecutor(execResult: any) {
      const summary = execResult?.summary || execResult?.output?.slice?.(0, 500) || "no output";
      const files = execResult?.filesChanged || [];
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Executor] ${summary}\nFiles changed: ${files.join(", ") || "none"}`,
      });
    },

    async logVerification(verification: any, passed: boolean) {
      const steps = (verification?.steps || [])
        .map((s: any) => `${s.label}: ${s.passed ? "PASS" : "FAIL"}`)
        .join(", ");
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Verification] ${passed ? "ALL PASSED" : "FAILED"}: ${steps}`,
      });
    },

    async logOutcome(finalState: string, details = "") {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Outcome] ${finalState}${details ? ` — ${details}` : ""}`,
      });
    },

    async markUsed(uris: string[]) {
      if (uris.length === 0) return;
      await ovFetch(`/api/v1/sessions/${sessionId}/used`, {
        contexts: uris,
      });
    },

    async search(query: string, limit = 5) {
      const result = await ovFetch("/api/v1/search/find", {
        query,
        limit,
        session_id: sessionId,
      });
      return result?.result?.resources || [];
    },

    async getAgentContext(agentName: string, anchor: any, limit = 10) {
      const query = `${agentName} agent context for: ${anchor.reference || ""} ${anchor.whyNow || ""}`.trim();
      const result = await ovFetch("/api/v1/search/find", {
        query,
        limit,
        session_id: sessionId,
      });
      if (!result?.result) return { resources: [], memories: [], formatted: "" };

      const resources = result.result.resources || [];
      const memories = result.result.memories || [];

      const parts: string[] = [];
      if (resources.length > 0) {
        parts.push(`## CONTEXT (from OpenViking — ${resources.length} relevant resources)`);
        for (const r of resources.slice(0, 8)) {
          const title = r.uri || r.title || "untitled";
          const abstract = (r.abstract || "").slice(0, 400);
          if (abstract) parts.push(`\n### ${title}\n${abstract}`);
        }
      }
      if (memories.length > 0) {
        parts.push(`\n## LEARNED PATTERNS (from past cycles)`);
        for (const m of memories.slice(0, 5)) {
          const abstract = (m.abstract || m.content || "").slice(0, 300);
          if (abstract) parts.push(`- ${abstract}`);
        }
      }

      return {
        resources,
        memories,
        formatted: parts.join("\n"),
      };
    },

    async commit() {
      try {
        const res = await fetch(`${OV_URL}/api/v1/sessions/${sessionId}/commit?wait=false`, {
          method: "POST",
          headers: OV_HEADERS,
          body: "{}",
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          console.log(`[Learning] Committed OV session ${sessionId} (async) — memory extraction queued`);
          this.active = false;
          return data;
        }
        console.error(`[Learning] OV commit failed: ${res.status}`);
      } catch (err: any) {
        console.error(`[Learning] OV commit error: ${err.message}`);
      }
      this.active = false;
      return null;
    },
  };
}

// ===========================================================================
// Section: Private — OV HTTP helpers
// ===========================================================================

async function ovFetch(path: string, body: any) {
  try {
    const res = await fetch(`${OV_URL}${path}`, {
      method: "POST",
      headers: OV_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[Learning] OV ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (err: any) {
    console.error(`[Learning] OV ${path} error: ${err.message}`);
    return null;
  }
}

function createNoOpSession(cycleId: string) {
  return {
    sessionId: null,
    cycleId,
    active: false,
    async logPlanner() {},
    async logSkeptic() {},
    async logExecutor() {},
    async logVerification() {},
    async logOutcome() {},
    async markUsed() {},
    async search(query: string, limit = 5) {
      try {
        const res = await fetch(`${OV_URL}/api/v1/search/find`, {
          method: "POST",
          headers: OV_HEADERS,
          body: JSON.stringify({ query, limit }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const data = await res.json() as any;
        return data?.result?.resources || [];
      } catch (err: any) { /* intentional: OV search is best-effort — empty results on failure */
        Sentry.addBreadcrumb({ category: "openviking", message: `OV search failed: ${err?.message}`, level: "warning" });
        return [];
      }
    },
    async getAgentContext() { return { resources: [], memories: [], formatted: "" }; },
    async commit() {},
  };
}

// ===========================================================================
// Section: Private — Pattern storage (agent memory)
// ===========================================================================

async function loadPatterns(agentName: string): Promise<MemoryPattern[]> {
  const raw = await loadPatternsRaw(agentName);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch { /* intentional: corrupt patterns JSON — return empty to allow fresh start */
    return [];
  }
}

async function savePatterns(agentName: string, patterns: MemoryPattern[]) {
  const sorted = patterns
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .slice(0, MAX_PATTERNS);
  await savePatternsRaw(agentName, JSON.stringify(sorted));
}

async function sweepStalePromotions(agentName: string) {
  const patterns = await loadPatterns(agentName);
  let changed = false;

  for (const p of patterns) {
    if (p.hitCount >= PROMOTION_THRESHOLD && !p.promoted) {
      try {
        await promoteToFeedback(agentName, p);
        p.promoted = true;
        changed = true;
        console.log(`[Learning] Retroactive promotion: "${p.category}" to to-${agentName}.md (${p.hitCount} hits)`);
      } catch (err: any) {
        console.error(`[Learning] Retroactive promotion failed for "${p.category}": ${err.message}`);
      }
    }
  }

  if (changed) {
    await savePatterns(agentName, patterns);
  }
}

async function promoteToFeedback(agentName: string, pattern: MemoryPattern) {
  const feedbackPath = join(CONFIG_PATH, "feedback", `to-${agentName}.md`);
  try {
    let content = await readFile(feedbackPath, "utf-8");

    const sectionHeader = "## Auto-Promoted Rules";
    const ruleBlock = [
      ``,
      `### ${pattern.category} (${pattern.hitCount}x since ${pattern.firstSeen})`,
      pattern.action,
      `Last: ${pattern.lastCycleId} (${pattern.examples[0] || "no example"})`,
      `<!-- auto-promoted ${new Date().toISOString().split("T")[0]} -->`,
    ].join("\n");

    if (content.includes(sectionHeader)) {
      content = content.replace(sectionHeader, sectionHeader + "\n" + ruleBlock);
    } else {
      content += "\n\n" + sectionHeader + "\n\n" +
        "Rules below were auto-promoted from agent memory after proving themselves\n" +
        "across multiple cycles. They represent durable patterns, not one-off incidents.\n" +
        ruleBlock;
    }

    await writeFile(feedbackPath, content);
  } catch (err: any) {
    console.error(`[Learning] Failed to promote to ${feedbackPath}: ${err.message}`);
  }
}

// ===========================================================================
// Section: Private — Agent memory loading + formatting
// ===========================================================================

export async function loadAgentMemory(agentName: string): Promise<string> {
  await sweepStalePromotions(agentName);

  const patterns = await loadPatterns(agentName);
  const parts: string[] = [];

  if (patterns.length > 0) {
    parts.push(`# ${agentName} — Learned Patterns\n`);
    for (const p of patterns) {
      parts.push([
        `### [${p.severity}] ${p.category} (${p.hitCount}x)`,
        `ACTION: ${p.action}`,
        `LAST: ${p.lastCycleId} — ${p.examples[0] || ""}`,
        "",
      ].join("\n"));
    }
  }

  // Also load from OpenViking
  try {
    const res = await fetch(`${OV_URL}/api/v1/search/find`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
      body: JSON.stringify({
        query: `${agentName} agent lessons failures prevention`,
        limit: 5,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const memories = data?.result?.memories || [];
      if (memories.length > 0) {
        parts.push(`\n# ${agentName} — Learned Patterns (from OpenViking)\n`);
        for (const mem of memories.slice(0, 5)) {
          const abstract = mem.abstract || mem.content || "";
          if (abstract.trim()) {
            parts.push(`- ${abstract.slice(0, 300)}`);
          }
        }
        parts.push("");
      }
    }
  } catch { /* intentional: OV unavailable */ }

  return parts.join("\n");
}

function formatMemoryForPrompt(memory: string, agentName: string): string {
  if (!memory || memory.trim().length === 0) return "";

  const blocks = memory.split(/^(?=### \[)/m).filter(r => r.trim().startsWith("### ["));
  if (blocks.length === 0) {
    const lines = memory.split("\n").filter(l => l.startsWith("- ") || l.startsWith("ACTION:"));
    if (lines.length === 0) return "";
    return `\n## PAST OUTCOMES (learn from these)\n${lines.slice(-10).join("\n")}\n`;
  }

  const preventBlocks = blocks.filter(b => b.includes("[prevent]"));
  const reinforceBlocks = blocks.filter(b => b.includes("[reinforce]"));

  const parts: string[] = [];

  if (preventBlocks.length > 0) {
    parts.push(`\n## PREVENTION PATTERNS (ranked by frequency — follow these)`);
    const sorted = preventBlocks.sort((a, b) => {
      const countA = parseInt(a.match(/\((\d+)x\)/)?.[1] || "0");
      const countB = parseInt(b.match(/\((\d+)x\)/)?.[1] || "0");
      return countB - countA;
    });
    for (const block of sorted.slice(0, 10)) {
      const lines = block.split("\n").filter(l =>
        l.startsWith("ACTION:") || l.startsWith("LAST:") || l.startsWith("### [")
      );
      if (lines.length > 0) parts.push(lines.join("\n"));
    }
  }

  if (reinforceBlocks.length > 0 && reinforceBlocks.length <= 5) {
    parts.push(`\n## REINFORCED PATTERNS (these approaches have worked)`);
    for (const block of reinforceBlocks.slice(-3)) {
      const lines = block.split("\n").filter(l =>
        l.startsWith("ACTION:") || l.startsWith("LAST:") || l.startsWith("### [")
      );
      if (lines.length > 0) parts.push(lines.join("\n"));
    }
  }

  return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
}

// ===========================================================================
// Section: Private — Per-agent lesson recorders
// ===========================================================================

async function recordPlannerLesson(cycleId: string, task: any, finalState: string, context: any = {}) {
  if (finalState === "merged") {
    if (context.scopeCreep?.length > 0) {
      await recordPattern("planner", "scope-creep", {
        action: `Include adjacent test files and shared modules in scopeBoundary.in. The executor went outside scope: ${context.scopeCreep.slice(0, 3).join(", ")}`,
        example: `${cycleId}: "${task.title}" — ${context.scopeCreep.length} file(s) outside scope`,
        cycleId,
      });
    }
    if (task.scopeBoundary?.in?.length > 4) {
      await recordPattern("planner", "broad-scope-success", {
        severity: "reinforce",
        action: `Broad scope (${task.scopeBoundary.in.length} files) can work when each file is needed`,
        example: `${cycleId}: "${task.title}" — ${task.scopeBoundary.in.length} files`,
        cycleId,
      });
    }
    return;
  }

  if (finalState === "failed") {
    const failedSteps = context.failedSteps || [];
    await recordPattern("planner", "verification-failure", {
      action: `Ensure ${failedSteps.join(" + ") || "verification"} will pass before proposing. ${task.scopeBoundary?.in?.length > 3 ? `Scope was broad (${task.scopeBoundary.in.length} files) — consider narrowing.` : ""}`,
      example: `${cycleId}: "${task.title}" failed — ${context.failReason || "verification failed"}`,
      cycleId,
    });
    return;
  }

  if (finalState === "rolled-back") {
    await recordPattern("planner", "rollback", {
      action: `Changes to ${(task.scopeBoundary?.in || []).slice(0, 3).join(", ") || "these files"} caused test regressions. Verify test stability before proposing changes here.`,
      example: `${cycleId}: "${task.title}" — auto-reverted`,
      cycleId,
    });
    return;
  }

  if (finalState === "abandoned") {
    const reason = context.reason || "rejected or drift";
    if (reason.includes("Drift")) {
      await recordPattern("planner", "drift", {
        action: `Check recent cycle history for duplicates before proposing work similar to "${task.title}"`,
        example: `${cycleId}: abandoned — ${reason}`,
        cycleId,
      });
    } else if (reason.includes("Review rejected:")) {
      await recordPattern("planner", "high-risk-rejection", {
        action: `High-risk review flagged a safety concern: ${reason.replace("Review rejected: ", "").slice(0, 200)}`,
        example: `${cycleId}: "${task.title}" — ${reason}`,
        cycleId,
      });
    }
  }
}

async function recordExecutorLesson(cycleId: string, task: any, finalState: string, context: any = {}) {
  if (finalState === "merged") return;

  if (finalState === "failed") {
    if (context.noDiff) {
      await recordPattern("executor", "no-diff", {
        action: `Actually write code and commit. Previous attempt produced zero changes.`,
        example: `${cycleId}: "${task.title}" — no files modified`,
        cycleId,
      });
    } else if (context.failedSteps?.length > 0) {
      await recordPattern("executor", "verification-failure", {
        action: `Run npm test and npm run typecheck before committing. ${context.failedSteps.join(" + ")} failed.`,
        example: `${cycleId}: ${context.failedSteps.join(", ")} failed${context.verificationStderr ? " — " + context.verificationStderr.slice(0, 100) : ""}`,
        cycleId,
      });
    }
    return;
  }

  if (finalState === "rolled-back") {
    await recordPattern("executor", "rollback", {
      action: `Run the FULL test suite when modifying ${(task.scopeBoundary?.in || []).slice(0, 3).join(", ") || "these files"}. A previous change broke tests elsewhere.`,
      example: `${cycleId}: tests ${context.testsBefore} → ${context.testsAfter} — auto-reverted`,
      cycleId,
    });
  }
}

async function recordSkepticLesson(cycleId: string, task: any, skepticVerdict: string, finalState: string) {
  if (skepticVerdict === "approve" && (finalState === "failed" || finalState === "rolled-back")) {
    await recordPattern("skeptic", "skeptic-miss", {
      action: `You approved a task that ${finalState}. Check scope boundary and verification plan more carefully for similar tasks.`,
      example: `${cycleId}: approved "${task.title}" — it ${finalState}`,
      cycleId,
    });
    return;
  }

  if (skepticVerdict === "reject" && finalState === "abandoned") {
    await recordPattern("skeptic", "correct-rejection", {
      severity: "reinforce",
      action: `Rejection in this area was correct. Keep standards high for ${(task.scopeBoundary?.in || []).slice(0, 2).join(", ") || "similar work"}.`,
      example: `${cycleId}: correctly rejected "${task.title}"`,
      cycleId,
    });
  }
}

// ===========================================================================
// Section: Private — Per-anchor episodic reflections
// ===========================================================================

const REFLECTION_PREFIX = redisKeys.reflectionPrefix();

function reflectionKey(anchorRef: string): string {
  return REFLECTION_PREFIX + (anchorRef || "unknown").replace(/\s+/g, "-").toLowerCase().slice(0, 120);
}

async function recordAnchorReflection(opts: {
  cycleId: string;
  anchorRef: string;
  taskTitle: string;
  outcome: string;
  reason: string;
  filesChanged?: string[];
  verificationErrors?: string[];
}) {
  const key = reflectionKey(opts.anchorRef);

  const reflection: AnchorReflection = {
    cycleId: opts.cycleId,
    anchorRef: opts.anchorRef,
    taskTitle: opts.taskTitle,
    outcome: opts.outcome,
    reason: opts.reason,
    whatWasAttempted: opts.taskTitle || "Unknown task",
    whyItFailed: opts.reason || "Unknown reason",
    whatShouldChange: generateAdvice(opts),
    timestamp: new Date().toISOString(),
  };

  await pushAnchorReflection(key, JSON.stringify(reflection), REFLECTION_TTL, MAX_REFLECTIONS_PER_ANCHOR);
  console.log(`[Learning] Recorded reflection for "${opts.anchorRef.slice(0, 60)}" (${opts.outcome})`);
}

function generateAdvice(opts: { outcome: string; reason: string; filesChanged?: string[]; verificationErrors?: string[] }): string {
  if (opts.outcome === "no-task") {
    return "The planner could not produce a task for this anchor. The anchor may be too vague, already completed, or blocked by an external dependency. Consider: is there a more specific, actionable formulation?";
  }
  if (opts.outcome === "no-diff") {
    return "The executor ran but produced no code changes. The task may have been unclear, already implemented, or blocked by missing context. Consider: provide more specific scope boundary and acceptance criteria.";
  }
  if (opts.verificationErrors?.length) {
    return `Verification failed on: ${opts.verificationErrors.join(", ")}. The next attempt should address these specific failures. Consider: narrower scope, or fix the verification errors before adding new behavior.`;
  }
  if (opts.outcome === "abandoned") {
    return `Task was abandoned: ${opts.reason}. Consider: different approach, narrower scope, or verify prerequisites are met.`;
  }
  return `Previous attempt failed: ${opts.reason}. The next attempt should take a different approach.`;
}

async function loadAnchorReflections(anchorRef: string): Promise<string> {
  const key = reflectionKey(anchorRef);
  const raw = await getAnchorReflections(key);
  if (raw.length === 0) return "";

  const reflections: AnchorReflection[] = raw.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  if (reflections.length === 0) return "";

  const lines = [
    `## PRIOR ATTEMPTS (${reflections.length} previous failures for this anchor)`,
    ``,
    `IMPORTANT: This anchor has been tried before and FAILED. Do NOT repeat the same approach.`,
    ``,
  ];

  for (const ref of reflections) {
    lines.push(`### Attempt: ${ref.cycleId}`);
    lines.push(`- **Task**: ${ref.taskTitle}`);
    lines.push(`- **Outcome**: ${ref.outcome}`);
    lines.push(`- **Why it failed**: ${ref.whyItFailed}`);
    lines.push(`- **Advice**: ${ref.whatShouldChange}`);
    lines.push(``);
  }

  return lines.join("\n");
}

// ===========================================================================
// Section: Private — Global reflection buffer
// ===========================================================================

async function recordGlobalReflection(opts: {
  cycleId: string;
  anchorType: string;
  anchorReference: string;
  failureMode: string;
  whatFailed: string;
  whyItFailed: string;
  whatToTryDifferently: string;
}): Promise<void> {
  const reflection: GlobalReflection = {
    cycleId: opts.cycleId,
    anchorType: opts.anchorType,
    anchorReference: opts.anchorReference,
    failureMode: opts.failureMode,
    whatFailed: opts.whatFailed,
    whyItFailed: opts.whyItFailed,
    whatToTryDifferently: opts.whatToTryDifferently,
    timestamp: new Date().toISOString(),
  };

  await pushReflection(JSON.stringify(reflection), MAX_BUFFER_SIZE);
  console.log(`[Learning] Recorded global reflection for cycle ${opts.cycleId}: ${opts.failureMode}`);
}

export async function loadRelevantReflections(
  anchor: { type: string; reference: string },
  limit = 3,
): Promise<GlobalReflection[]> {
  const raw = await getReflectionBuffer();
  if (raw.length === 0) return [];

  const all: GlobalReflection[] = [];
  for (const entry of raw) {
    try {
      all.push(JSON.parse(entry));
    } catch { /* intentional: skip unparseable entries */ }
  }

  const refLower = (anchor.reference || "").toLowerCase();
  const relevant = all.filter((r) => {
    const rRefLower = (r.anchorReference || "").toLowerCase();
    if (rRefLower === refLower) return true;
    if (refLower && rRefLower && (rRefLower.includes(refLower) || refLower.includes(rRefLower))) return true;
    if (r.anchorType === anchor.type) return true;
    return false;
  });

  return relevant.reverse().slice(0, limit);
}

export function formatReflectionsForPrompt(reflections: GlobalReflection[]): string {
  if (reflections.length === 0) return "";

  const lines = [
    `## Recent Failures`,
    ``,
    `IMPORTANT: These recent failures are relevant to the current anchor. Do NOT repeat the same approaches.`,
    ``,
  ];

  for (const ref of reflections) {
    lines.push(`### ${ref.cycleId} (${ref.failureMode})`);
    lines.push(`- **What failed**: ${ref.whatFailed}`);
    lines.push(`- **Why**: ${ref.whyItFailed}`);
    lines.push(`- **Try differently**: ${ref.whatToTryDifferently}`);
    lines.push(``);
  }

  return lines.join("\n");
}

export async function clearReflectionsForAnchor(anchorReference: string): Promise<number> {
  const raw = await getReflectionBuffer();
  if (raw.length === 0) return 0;

  const refLower = (anchorReference || "").toLowerCase();
  let removed = 0;

  const kept: string[] = [];
  for (const entry of raw) {
    try {
      const parsed: GlobalReflection = JSON.parse(entry);
      const entryRefLower = (parsed.anchorReference || "").toLowerCase();
      if (entryRefLower === refLower || (refLower && entryRefLower.includes(refLower))) {
        removed++;
      } else {
        kept.push(entry);
      }
    } catch {
      kept.push(entry);
    }
  }

  if (removed > 0) {
    await replaceReflectionBuffer(kept);
    console.log(`[Learning] Cleared ${removed} reflection(s) for anchor "${anchorReference.slice(0, 60)}"`);
  }

  return removed;
}

// ===========================================================================
// Section: Private — Rules migration
// ===========================================================================

function categorizeRule(rule: any): string {
  const text = `${rule.when || ""} ${rule.check || ""} ${rule.because || ""}`.toLowerCase();
  if (text.includes("scope") && (text.includes("creep") || text.includes("outside") || text.includes("boundary"))) return "scope-creep";
  if (text.includes("verification") || text.includes("npm test") || text.includes("typecheck")) return "verification-failure";
  if (text.includes("no code") || text.includes("zero changes") || text.includes("no diff")) return "no-diff";
  if (text.includes("rollback") || text.includes("reverted") || text.includes("regress")) return "rollback";
  if (text.includes("drift") || text.includes("duplicate")) return "drift";
  if (text.includes("rejected") || text.includes("skeptic")) return "skeptic-rejection";
  return "other";
}

async function migrateRulesToPatterns() {
  for (const agent of ["planner", "executor", "skeptic"]) {
    const oldExists = await getOldRulesCount(agent);
    const newExists = await patternsExist(agent);

    if (oldExists > 0 && !newExists) {
      console.log(`[Learning] Migrating ${agent}: ${oldExists} rules → patterns`);
      const rawRules = await getOldRules(agent);
      const patterns: MemoryPattern[] = [];

      for (const raw of rawRules) {
        try {
          const rule = JSON.parse(raw);
          const category = categorizeRule(rule);
          const existing = patterns.find(p => p.category === category);

          if (existing) {
            existing.hitCount++;
            existing.lastSeen = rule.date || existing.lastSeen;
            existing.lastCycleId = rule.cycleId || existing.lastCycleId;
            existing.examples = [rule.because?.slice(0, 200) || "", ...existing.examples].slice(0, MAX_EXAMPLES);
          } else {
            patterns.push({
              category,
              severity: rule.severity || "prevent",
              hitCount: 1,
              firstSeen: rule.date || new Date().toISOString().split("T")[0],
              lastSeen: rule.date || new Date().toISOString().split("T")[0],
              lastCycleId: rule.cycleId || "migrated",
              action: rule.check || rule.when || "Review this pattern",
              examples: [rule.because?.slice(0, 200) || ""],
              promoted: false,
            });
          }
        } catch { /* intentional: skip unparseable rules */ }
      }

      await savePatterns(agent, patterns);
      await deleteOldRules(agent);
      console.log(`[Learning] Migrated ${agent}: ${oldExists} rules → ${patterns.length} patterns`);
    }
  }
}

// ===========================================================================
// Section: Private — OV skill registration
// ===========================================================================

const OV_SKILLS = [
  {
    name: "planner",
    description: "Proposes one bounded development task per cycle. Reads priorities, grounding, and knowledge context. Outputs structured JSON with title, scope boundary, acceptance criteria, and verification plan.",
    content: `# planner\n\nPropose one bounded development task per cycle.\n\n## Capabilities\n- Reads project priorities, goals, and operator vision\n- Analyzes codebase grounding (test counts, typecheck status, file tree)\n- Searches OpenViking knowledge base for relevant context\n- Proposes tasks with concrete scope boundaries and verification plans\n- Adapts complexity: quick-fix (1-2 files) or standard (full analysis)\n\n## Input\n- Anchor (what to work on): failing test, queued item, research finding, or priorities doc\n- Grounding: npm test results, typecheck status, git state\n- Priorities: operator-authored direction document\n- Knowledge: OpenViking search results relevant to the anchor\n\n## Output\nJSON with: title, description, scopeBoundary, acceptanceCriteria, verificationPlan\n\n## Constraints\n- One task per cycle (never multiple)\n- Must be anchored to real evidence\n- Scope boundary must list specific files\n- Verification plan must use npm test and npm run typecheck\n`,
  },
  {
    name: "executor",
    description: "Writes code on a feature branch to implement a planned task. Has full codebase access. Runs tests before committing. Never merges to main.",
    content: `# executor\n\nWrite code to implement a planned task.\n\n## Capabilities\n- Full read/write access to the target project codebase\n- Creates feature branches, writes code, runs tests\n- Follows existing test patterns from the project\n- Respects scope boundaries from the planner\n\n## Input\n- Task with title, description, scope boundary, acceptance criteria\n- Grounding summary with current test counts and file structure\n- Agent memory with prevention rules from past failures\n\n## Output\nJSON with: summary, filesChanged, commits, branch, testsRun\n\n## Constraints\n- Must stay within scope boundary\n- Must run npm test before committing\n- Never merges to main — control loop handles merging\n- Creates one feature branch per cycle\n`,
  },
  {
    name: "skeptic",
    description: "Challenges proposed tasks before execution. Has veto power. Checks for duplicates, scope issues, and feasibility. Skipped for quick-fix and research-vetted tasks.",
    content: `# skeptic\n\nChallenge a proposed task before it gets executed.\n\n## Capabilities\n- Reviews task proposals for anchoring, scope, feasibility\n- Checks recent cycle history for duplicate work\n- Reads prevention rules from past failures\n- Can approve or reject with a reason\n\n## Input\n- Proposed task (title, description, scope, criteria)\n- Recent cycle history (last 5 cycles)\n- Agent memory with prevention rules\n\n## Output\nJSON with: verdict (approve/reject), reason\n\n## Constraints\n- Should lean toward approve when uncertain\n- Skip for research-vetted items and quick-fixes\n- Must provide concrete reason for rejection\n`,
  },
  {
    name: "director",
    description: "Synthesizes operator vision, codebase state, and multi-stream research into a prioritized feature roadmap. Writes priorities.md and ranks opportunities.",
    content: `# director\n\nSynthesize vision + codebase state + research into priorities.\n\n## Capabilities\n- Reads operator vision (short intent document)\n- Analyzes structured codebase state (modules, routes, gaps)\n- Processes domain, technical, and market research findings\n- Produces ranked opportunity list with alignment scores\n- Writes complete priorities.md for the planner\n\n## Input\n- Operator vision (5-20 lines)\n- Codebase analysis (modules, API routes, test count, gaps)\n- Three research streams (domain, technical, market)\n\n## Output\nJSON with: priorities (markdown string), opportunities (ranked list), summary, researchHighlights\n\n## Constraints\n- Features over hardening (follow operator vision)\n- Concrete tasks over vague direction\n- Wire existing code before building new things\n- Research-backed recommendations\n`,
  },
];

async function registerSkills() {
  let registered = 0;
  for (const skill of OV_SKILLS) {
    try {
      const res = await fetch(`${OV_URL}/api/v1/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
        body: JSON.stringify({ data: skill }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        registered++;
      } else {
        const text = await res.text().catch(() => "");
        console.error(`[Learning] Failed to register skill ${skill.name}: ${res.status} ${text.slice(0, 150)}`);
      }
    } catch (err: any) {
      console.error(`[Learning] Failed to register skill ${skill.name}: ${err.message}`);
    }
  }
  if (registered > 0) {
    console.log(`[Learning] Registered ${registered}/${OV_SKILLS.length} OV skills`);
  }
}

// ===========================================================================
// Section: Private — Knowledge indexer (background process)
// ===========================================================================

const indexerPending = new Map<string, ReturnType<typeof setTimeout>>();
let lastReportIndex = 0;
let lastRuleCounts: Record<string, number> = {};

function shouldIndex(filePath: string): boolean {
  const rel = relative(CONFIG_PATH, filePath);
  for (const skip of SKIP_DIRS) {
    if (rel.startsWith(skip)) return false;
  }
  return INDEXABLE_EXTS.has(extname(filePath));
}

async function indexFile(filePath: string) {
  const rel = relative(CONFIG_PATH, filePath);
  const containerPath = join(OV_CONFIG_MOUNT, rel);
  try {
    const res = await fetch(`${OV_URL}/api/v1/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
      body: JSON.stringify({ path: containerPath }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      console.log(`[Learning:Indexer] Indexed file: ${rel}`);
    } else {
      const err = await res.text();
      if (err.includes("not exist") || err.includes("ENOENT")) {
        console.log(`[Learning:Indexer] Skipped (removed): ${rel}`);
      } else {
        console.error(`[Learning:Indexer] Failed to index ${rel}: ${err.slice(0, 200)}`);
      }
    }
  } catch (err: any) {
    console.error(`[Learning:Indexer] Failed to index ${rel}: ${err.message}`);
  }
}

async function indexText(title: string, content: string) {
  const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const tmpFile = join(tmpdir(), `hydra-indexer-${safeName}-${Date.now()}.md`);
  try {
    await writeFile(tmpFile, `# ${title}\n\n${content}`, "utf-8");

    const { readFile: rf } = await import("node:fs/promises");
    const fileContent = await rf(tmpFile);
    const formData = new FormData();
    formData.append("file", new Blob([fileContent], { type: "text/markdown" }), `${safeName}.md`);

    const uploadRes = await fetch(`${OV_URL}/api/v1/resources/temp_upload`, {
      method: "POST",
      headers: { "X-Api-Key": OV_KEY },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (uploadRes.ok) {
      const uploadData = await uploadRes.json() as any;
      const tempPath = uploadData.temp_path || uploadData.path;

      if (tempPath) {
        const addRes = await fetch(`${OV_URL}/api/v1/resources`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
          body: JSON.stringify({ temp_path: tempPath, to: `viking://resources/hydra-memory/${safeName}` }),
          signal: AbortSignal.timeout(60000),
        });
        if (addRes.ok) {
          console.log(`[Learning:Indexer] Indexed text: ${title}`);
        } else {
          console.error(`[Learning:Indexer] Failed to add text "${title}": ${(await addRes.text()).slice(0, 200)}`);
        }
      }
    } else {
      console.error(`[Learning:Indexer] Failed to upload text "${title}": ${(await uploadRes.text()).slice(0, 200)}`);
    }
  } catch (err: any) {
    console.error(`[Learning:Indexer] Failed to index text "${title}": ${err.message}`);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

function onFileChange(_eventType: string, filename: string | null) {
  if (!filename) return;
  const fullPath = resolve(CONFIG_PATH, filename);
  if (!shouldIndex(fullPath)) return;

  if (indexerPending.has(fullPath)) clearTimeout(indexerPending.get(fullPath)!);
  indexerPending.set(
    fullPath,
    setTimeout(() => {
      indexerPending.delete(fullPath);
      indexFile(fullPath);
    }, DEBOUNCE_MS)
  );
}

async function pollRedisContent() {
  try {
    const reportIds = await getReportIdsByScore(lastReportIndex);
    for (const id of reportIds) {
      const raw = await getRealityReport(id);
      if (raw) {
        const report = JSON.parse(raw);
        const summary = `Cycle ${report.cycleId}: ${report.task?.title} — ${report.task?.finalState}. Tests: ${report.grounding?.before?.passed}→${report.grounding?.after?.passed}`;
        await indexText(`reality-report:${id}`, summary);
      }
    }
    if (reportIds.length > 0) {
      const latest = await getReportScore(reportIds[reportIds.length - 1]);
      lastReportIndex = parseInt(latest as string) || lastReportIndex;
    }

    for (const agent of ["planner", "executor", "skeptic"]) {
      const raw = await getMemoryPatterns(agent);
      if (!raw) continue;
      try {
        const patterns = JSON.parse(raw);
        const patternCount = patterns.length;
        const prev = lastRuleCounts[agent] || 0;
        if (patternCount > prev) {
          for (const p of patterns.slice(prev)) {
            const text = `${agent} pattern [${p.severity}]: ${p.category} (${p.hitCount}x) — ACTION: ${p.action}. Last: ${p.lastCycleId}`;
            await indexText(`memory:${agent}:${p.category}`, text);
          }
          lastRuleCounts[agent] = patternCount;
        }
      } catch { /* intentional: skip unparseable patterns */ }
    }
  } catch (err: any) {
    console.error(`[Learning:Indexer] Redis poll failed: ${err.message}`);
  }
}

let indexerInterval: ReturnType<typeof setInterval> | null = null;

function startKnowledgeIndexer() {
  console.log(`[Learning:Indexer] Watching configs: ${CONFIG_PATH}`);
  console.log(`[Learning:Indexer] Polling Redis every ${REDIS_POLL_MS / 1000}s`);

  // Watch config files
  try {
    watch(CONFIG_PATH, { recursive: true }, onFileChange);
  } catch (err: any) {
    console.error(`[Learning:Indexer] fs.watch failed: ${err.message}`);
  }

  // Poll Redis for new content
  indexerInterval = setInterval(() => pollRedisContent(), REDIS_POLL_MS);
  pollRedisContent();
}
