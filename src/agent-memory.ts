/**
 * Agent Memory — Two-Tier Pattern-Based Learning
 *
 * Tier 1: Feedback files (durable, never evicted)
 *   Auto-promoted cardinal rules that live in config/feedback/to-{agent}.md.
 *   These represent proven patterns (5+ occurrences) and persist permanently.
 *
 * Tier 2: Redis patterns (ephemeral, 15-slot rolling buffer)
 *   Consolidated patterns with hit counts. Similar incidents merge into one
 *   pattern instead of consuming separate slots. When a pattern reaches the
 *   promotion threshold, it auto-promotes to the feedback file and is marked
 *   as promoted in Redis.
 *
 * Recording flow:
 *   1. recordPlannerLesson / recordExecutorLesson / recordSkepticLesson
 *   2. → recordPattern(agent, category, details)
 *   3. → if pattern exists: increment hitCount, update examples
 *   4. → if hitCount >= threshold: promoteToFeedback()
 *   5. → save patterns to Redis
 */

import Redis from "ioredis";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const OV_URL = process.env.OPENVIKING_URL || "http://localhost:1933";
const OV_KEY = process.env.OPENVIKING_API_KEY || "56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c";
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

const MAX_PATTERNS = 15;
const PROMOTION_THRESHOLD = 5;
const MAX_EXAMPLES = 3;

// Redis key patterns
const patternsKey = (agent) => `hydra:memory:${agent}:patterns`;
const oldRulesKey = (agent) => `hydra:memory:${agent}:rules`;

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

let redis: any = null;
function getRedis() {
  if (!redis) redis = new Redis(REDIS_URL);
  return redis;
}

// ---------------------------------------------------------------------------
// Pattern storage
// ---------------------------------------------------------------------------

async function loadPatterns(agentName): Promise<MemoryPattern[]> {
  const r = getRedis();
  const raw = await r.get(patternsKey(agentName));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function savePatterns(agentName, patterns: MemoryPattern[]) {
  const r = getRedis();
  // Keep only the most recent MAX_PATTERNS, sorted by lastSeen desc
  const sorted = patterns
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .slice(0, MAX_PATTERNS);
  await r.set(patternsKey(agentName), JSON.stringify(sorted));
}

/**
 * Retroactive promotion sweep — catches patterns that reached the threshold
 * before the promotion system was added or before it worked correctly.
 * Called on loadAgentMemory() so stuck patterns get promoted on next use.
 */
async function sweepStalePromotions(agentName: string) {
  const patterns = await loadPatterns(agentName);
  let changed = false;

  for (const p of patterns) {
    if (p.hitCount >= PROMOTION_THRESHOLD && !p.promoted) {
      try {
        await promoteToFeedback(agentName, p);
        p.promoted = true;
        changed = true;
        console.log(`[Memory] Retroactive promotion: "${p.category}" to to-${agentName}.md (${p.hitCount} hits)`);
      } catch (err: any) {
        console.error(`[Memory] Retroactive promotion failed for "${p.category}": ${err.message}`);
      }
    }
  }

  if (changed) {
    await savePatterns(agentName, patterns);
  }
}

// ---------------------------------------------------------------------------
// Core: record a pattern (replaces recordRule)
// ---------------------------------------------------------------------------

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

  // Find existing pattern by category
  const existing = patterns.find(p => p.category === category);

  if (existing) {
    existing.hitCount++;
    existing.lastSeen = today;
    existing.lastCycleId = details.cycleId;
    existing.action = details.action; // update with latest wording
    existing.examples = [details.example, ...existing.examples].slice(0, MAX_EXAMPLES);

    // Check for promotion
    if (existing.hitCount >= PROMOTION_THRESHOLD && !existing.promoted) {
      await promoteToFeedback(agentName, existing);
      existing.promoted = true;
      console.log(`[Memory] Promoted "${category}" to to-${agentName}.md (${existing.hitCount} hits)`);
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

// ---------------------------------------------------------------------------
// Auto-promotion to feedback files
// ---------------------------------------------------------------------------

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
      // Append to existing section
      content = content.replace(
        sectionHeader,
        sectionHeader + "\n" + ruleBlock,
      );
    } else {
      // Create section at end
      content += "\n\n" + sectionHeader + "\n\n" +
        "Rules below were auto-promoted from agent memory after proving themselves\n" +
        "across multiple cycles. They represent durable patterns, not one-off incidents.\n" +
        ruleBlock;
    }

    await writeFile(feedbackPath, content);
  } catch (err: any) {
    console.error(`[Memory] Failed to promote to ${feedbackPath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Load memory for prompt injection
// ---------------------------------------------------------------------------

export async function loadAgentMemory(agentName) {
  // Retroactive sweep — promote any patterns stuck above threshold
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

  // Also load from OpenViking (auto-extracted memories)
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
  } catch { /* OV unavailable */ }

  return parts.join("\n");
}

/**
 * Format patterns for prompt injection — concise, frequency-weighted.
 */
export function formatMemoryForPrompt(memory, agentName) {
  if (!memory || memory.trim().length === 0) return "";

  // Parse pattern blocks from the loaded memory
  const blocks = memory.split(/^(?=### \[)/m).filter(r => r.trim().startsWith("### ["));
  if (blocks.length === 0) {
    // Fallback for any legacy format
    const lines = memory.split("\n").filter(l => l.startsWith("- ") || l.startsWith("ACTION:"));
    if (lines.length === 0) return "";
    return `\n## PAST OUTCOMES (learn from these)\n${lines.slice(-10).join("\n")}\n`;
  }

  const preventBlocks = blocks.filter(b => b.includes("[prevent]"));
  const reinforceBlocks = blocks.filter(b => b.includes("[reinforce]"));

  const parts: string[] = [];

  if (preventBlocks.length > 0) {
    parts.push(`\n## PREVENTION PATTERNS (ranked by frequency — follow these)`);
    // Sort by hit count (extract from "(Nx)" in the header)
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

// ---------------------------------------------------------------------------
// Per-agent lesson recorders (public API — signatures unchanged)
// ---------------------------------------------------------------------------

export async function recordPlannerLesson(cycleId, task, finalState, context: any = {}) {
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
      // Judgment-based rejection from nano-model high-risk review.
      // Record the ACTUAL reason so the planner can learn from it.
      await recordPattern("planner", "high-risk-rejection", {
        action: `High-risk review flagged a safety concern: ${reason.replace("Review rejected: ", "").slice(0, 200)}`,
        example: `${cycleId}: "${task.title}" — ${reason}`,
        cycleId,
      });
    }
    // Preflight rejections and schema failures are handled by code gates,
    // not the learning system. No pattern recorded for those — the fix
    // is in validateTaskSchema() and preflightCheck(), not LLM lessons.
  }
}

export async function recordExecutorLesson(cycleId, task, finalState, context: any = {}) {
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

export async function recordSkepticLesson(cycleId, task, skepticVerdict, finalState) {
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


// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

function categorizeRule(rule): string {
  const text = `${rule.when || ""} ${rule.check || ""} ${rule.because || ""}`.toLowerCase();
  if (text.includes("scope") && (text.includes("creep") || text.includes("outside") || text.includes("boundary"))) return "scope-creep";
  if (text.includes("verification") || text.includes("npm test") || text.includes("typecheck")) return "verification-failure";
  if (text.includes("no code") || text.includes("zero changes") || text.includes("no diff")) return "no-diff";
  if (text.includes("rollback") || text.includes("reverted") || text.includes("regress")) return "rollback";
  if (text.includes("drift") || text.includes("duplicate")) return "drift";
  if (text.includes("rejected") || text.includes("skeptic")) return "skeptic-rejection";
  return "other";
}

// ---------------------------------------------------------------------------
// Migration: convert old rules → patterns (one-time, on startup)
// ---------------------------------------------------------------------------

export async function migrateRulesToPatterns() {
  const r = getRedis();
  for (const agent of ["planner", "executor", "skeptic"]) {
    // Check if old rules exist and new patterns don't
    const oldExists = await r.llen(oldRulesKey(agent));
    const newExists = await r.exists(patternsKey(agent));

    if (oldExists > 0 && !newExists) {
      console.log(`[Memory] Migrating ${agent}: ${oldExists} rules → patterns`);
      const rawRules = await r.lrange(oldRulesKey(agent), 0, -1);
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
        } catch { /* skip unparseable rules */ }
      }

      await savePatterns(agent, patterns);
      await r.del(oldRulesKey(agent));
      console.log(`[Memory] Migrated ${agent}: ${oldExists} rules → ${patterns.length} patterns`);
    }
  }
}

// ---------------------------------------------------------------------------
// Daily consolidation: prune stale patterns
// ---------------------------------------------------------------------------

export async function consolidateMemory() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  for (const agent of ["planner", "executor", "skeptic"]) {
    const patterns = await loadPatterns(agent);
    const before = patterns.length;

    // Remove stale one-offs: older than 14 days with hitCount < 2
    const kept = patterns.filter(p =>
      p.hitCount >= 2 || p.lastSeen >= cutoffStr || p.promoted
    );

    if (kept.length < before) {
      await savePatterns(agent, kept);
      console.log(`[Memory] Consolidated ${agent}: ${before} → ${kept.length} patterns (${before - kept.length} stale pruned)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Episodic failure reflections (Reflexion pattern)
//
// When a cycle fails, store a natural-language reflection about what was
// attempted, why it failed, and what should be different next time. When the
// same anchor is retried, inject these reflections as context so the planner
// can avoid repeating the same mistakes.
//
// Redis key: hydra:reflections:{normalizedRef} — list of JSON reflections
// TTL: 7 days — old reflections auto-expire
// ---------------------------------------------------------------------------

const REFLECTION_PREFIX = "hydra:reflections:";
const REFLECTION_TTL = 7 * 24 * 60 * 60; // 7 days
const MAX_REFLECTIONS_PER_ANCHOR = 5;

function reflectionKey(anchorRef: string): string {
  return REFLECTION_PREFIX + (anchorRef || "unknown").replace(/\s+/g, "-").toLowerCase().slice(0, 120);
}

type Reflection = {
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

/**
 * Record a failure reflection after a cycle fails or produces no task.
 */
export async function recordReflection(opts: {
  cycleId: string;
  anchorRef: string;
  taskTitle: string;
  outcome: string;
  reason: string;
  filesChanged?: string[];
  verificationErrors?: string[];
}) {
  const r = getRedis();
  const key = reflectionKey(opts.anchorRef);

  // Generate a structured reflection
  const reflection: Reflection = {
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

  await r.rpush(key, JSON.stringify(reflection));
  await r.expire(key, REFLECTION_TTL);

  // Trim to keep only the most recent reflections
  const len = await r.llen(key);
  if (len > MAX_REFLECTIONS_PER_ANCHOR) {
    await r.ltrim(key, len - MAX_REFLECTIONS_PER_ANCHOR, -1);
  }

  console.log(`[Memory] Recorded reflection for "${opts.anchorRef.slice(0, 60)}" (${opts.outcome})`);
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

/**
 * Load reflections for an anchor reference and format them for the planner.
 * Returns empty string if no reflections exist.
 */
export async function loadReflections(anchorRef: string): Promise<string> {
  const r = getRedis();
  const key = reflectionKey(anchorRef);
  const raw = await r.lrange(key, 0, -1);
  if (raw.length === 0) return "";

  const reflections: Reflection[] = raw.map(r => {
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

/**
 * Clear reflections for an anchor after a successful merge.
 */
export async function clearReflections(anchorRef: string) {
  const r = getRedis();
  await r.del(reflectionKey(anchorRef));
}

