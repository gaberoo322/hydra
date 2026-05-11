/**
 * learning/agent-memory.ts — Per-agent pattern memory + auto-promotion
 *
 * Extracted from learning.ts (issue #219). Owns the Redis-backed pattern
 * tier (planner/executor/skeptic), promotion to feedback files, stale-rule
 * detection, the legacy `hydra:rules:*` migration, and per-agent lesson
 * recording (`recordPlannerLesson` / `recordExecutorLesson` /
 * `recordSkepticLesson`).
 *
 * Public API used outside this module:
 *   PROMOTION_THRESHOLD            — exported constant
 *   recordPattern                  — POST /api/memory/:agent/pattern
 *   loadAgentMemory                — used by getContext()
 *   formatMemoryForPrompt          — formats raw memory string for prompts
 *   recordPlannerLesson / recordExecutorLesson / recordSkepticLesson
 *   consolidateAgentPatterns       — daily prune driven by consolidate()
 *   detectStalePromotedRules       — pure helper (tests)
 *   processStaleRules              — pure helper (tests)
 *   migrateRulesToPatterns         — one-time startup migration
 *
 * Behavior preserved 1:1 from the previous learning.ts implementation.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadPatternsRaw,
  savePatternsRaw,
  getOldRulesCount,
  patternsExist,
  getOldRules,
  deleteOldRules,
} from "../redis-adapter.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");

// ===========================================================================
// Constants / types
// ===========================================================================

const MAX_PATTERNS = 15;
export const PROMOTION_THRESHOLD = 3;
const MAX_EXAMPLES = 3;

export type MemoryPattern = {
  category: string;
  severity: "prevent" | "reinforce";
  hitCount: number;
  firstSeen: string;
  lastSeen: string;
  lastCycleId: string;
  action: string;
  examples: string[];
  promoted: boolean;
  /** ISO date (YYYY-MM-DD) the pattern was promoted to the feedback file. */
  promotedAt?: string;
  /** Hit count at the moment of promotion — baseline for post-promotion effectiveness. */
  hitsAtPromotion?: number;
};

/**
 * Issue #289 — Promoted-but-ineffective pattern surfaced via
 * `getIneffectivePromotedPatterns()`. A promoted rule is "ineffective" when the
 * post-promotion firing rate (hits/day) is at least as high as the
 * pre-promotion rate. Promotion is supposed to durably change agent behavior;
 * a flat or rising rate means the rule text isn't actually preventing the
 * failure mode it describes.
 */
export type IneffectivePromotedPattern = {
  category: string;
  promotedAt: string;
  hitsAtPromotion: number;
  hitsSincePromotion: number;
  daysToPromotion: number;
  daysSincePromotion: number;
  preRate: number; // hits/day before promotion
  postRate: number; // hits/day after promotion
  rateRatio: number; // postRate / preRate (Infinity when preRate === 0)
  lastSeen: string;
};

// ===========================================================================
// Pattern storage
// ===========================================================================

async function loadPatterns(agentName: string): Promise<MemoryPattern[]> {
  const raw = await loadPatternsRaw(agentName);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
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
        p.promotedAt = new Date().toISOString().split("T")[0];
        p.hitsAtPromotion = p.hitCount;
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
      `<!-- auto-promoted ${new Date().toISOString().split("T")[0]}, last hit ${pattern.lastSeen} -->`,
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
// Stale-rule detection
// ===========================================================================

export type StaleRule = {
  heading: string;
  promotedDate: string;
  lastHitDate: string;
  daysSinceLastHit: number;
  fullBlock: string;
};

/**
 * Parse auto-promoted rules from feedback file content and identify stale ones.
 * Pure function for testability — no I/O.
 *
 * @param feedbackContent - raw markdown content of a feedback file
 * @param agentName - agent name for logging
 * @param now - reference date (default: today)
 * @returns { active, stale30, stale60 } — rules bucketed by staleness
 */
export function detectStalePromotedRules(
  feedbackContent: string,
  agentName: string,
  now: Date = new Date(),
): { active: StaleRule[]; stale30: StaleRule[]; stale60: StaleRule[] } {
  const active: StaleRule[] = [];
  const stale30: StaleRule[] = [];
  const stale60: StaleRule[] = [];

  // Match rule blocks: ### heading ... <!-- auto-promoted ... -->
  // A rule block starts with ### and ends at the next ### or ## or end of content
  const autoPromotedSection = feedbackContent.indexOf("## Auto-Promoted Rules");
  if (autoPromotedSection === -1) return { active, stale30, stale60 };

  const staleSection = feedbackContent.indexOf("## Stale Rules (review needed)");
  const sectionEnd = staleSection !== -1 ? staleSection : feedbackContent.length;
  const sectionContent = feedbackContent.slice(autoPromotedSection, sectionEnd);

  // Split into rule blocks by ### headings
  const ruleBlockRegex = /^### .+$/gm;
  const headings: { index: number; match: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = ruleBlockRegex.exec(sectionContent)) !== null) {
    headings.push({ index: m.index, match: m[0] });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : sectionContent.length;
    const block = sectionContent.slice(start, end).trimEnd();
    const heading = headings[i].match;

    // Parse the auto-promoted comment
    const commentMatch = block.match(
      /<!--\s*auto-promoted\s+(\d{4}-\d{2}-\d{2})(?:,?\s*last\s+hit\s+(\d{4}-\d{2}-\d{2}))?\s*-->/
    );
    if (!commentMatch) continue;

    const promotedDate = commentMatch[1];
    const lastHitDate = commentMatch[2] || promotedDate;

    const lastHit = new Date(lastHitDate + "T00:00:00Z");
    const diffMs = now.getTime() - lastHit.getTime();
    const daysSinceLastHit = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    const rule: StaleRule = {
      heading,
      promotedDate,
      lastHitDate,
      daysSinceLastHit,
      fullBlock: block,
    };

    if (daysSinceLastHit > 60) {
      stale60.push(rule);
      console.log(`[Learning] Stale rule (>60d): ${heading} in to-${agentName}.md — last hit ${lastHitDate} (${daysSinceLastHit}d ago)`);
    } else if (daysSinceLastHit > 30) {
      stale30.push(rule);
      console.log(`[Learning] Stale rule (>30d): ${heading} in to-${agentName}.md — last hit ${lastHitDate} (${daysSinceLastHit}d ago)`);
    } else {
      active.push(rule);
    }
  }

  return { active, stale30, stale60 };
}

/**
 * Process feedback file content: move 30-day stale rules to a review section,
 * remove 60-day stale rules entirely (returned for archival logging).
 * Pure function — returns the new file content.
 *
 * @param feedbackContent - raw markdown content
 * @param agentName - agent name for logging
 * @param now - reference date (default: today)
 * @returns { newContent, archived } — updated content and removed rules
 */
export function processStaleRules(
  feedbackContent: string,
  agentName: string,
  now: Date = new Date(),
): { newContent: string; archived: StaleRule[] } {
  const { stale30, stale60 } = detectStalePromotedRules(feedbackContent, agentName, now);

  if (stale30.length === 0 && stale60.length === 0) {
    return { newContent: feedbackContent, archived: [] };
  }

  let content = feedbackContent;

  // Remove stale60 rules entirely (auto-archived)
  for (const rule of stale60) {
    content = content.replace(rule.fullBlock, "");
  }

  // Move stale30 rules from their current position to the stale section
  for (const rule of stale30) {
    content = content.replace(rule.fullBlock, "");
  }

  // Clean up multiple blank lines that result from removals
  content = content.replace(/\n{3,}/g, "\n\n");

  // Build the stale section for 30-day rules (review needed)
  if (stale30.length > 0) {
    const staleHeader = "## Stale Rules (review needed)";
    const existingStaleIdx = content.indexOf(staleHeader);

    const staleBlocks = stale30.map(r => r.fullBlock).join("\n\n");

    if (existingStaleIdx !== -1) {
      // Append to existing stale section
      const insertPoint = existingStaleIdx + staleHeader.length;
      content = content.slice(0, insertPoint) + "\n\n" + staleBlocks + content.slice(insertPoint);
    } else {
      // Add new stale section at the end
      content = content.trimEnd() + "\n\n" + staleHeader + "\n\n" +
        "Rules below have not fired in >30 days. Review and remove if no longer relevant.\n\n" +
        staleBlocks + "\n";
    }
  }

  return { newContent: content, archived: stale60 };
}

/**
 * Run staleness detection on all feedback files.
 * Called during consolidation.
 */
export async function consolidateStalePromotedRules(): Promise<void> {
  for (const agent of ["planner", "executor", "skeptic"]) {
    const feedbackPath = join(CONFIG_PATH, "feedback", `to-${agent}.md`);
    try {
      const content = await readFile(feedbackPath, "utf-8");
      const { newContent, archived } = processStaleRules(content, agent);

      if (newContent !== content) {
        await writeFile(feedbackPath, newContent);

        if (archived.length > 0) {
          for (const rule of archived) {
            console.log(`[Learning] Archived stale rule from to-${agent}.md: ${rule.heading} (last hit ${rule.lastHitDate}, ${rule.daysSinceLastHit}d ago)`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[Learning] Failed to process stale rules for to-${agent}.md: ${err.message}`);
    }
  }
}

// ===========================================================================
// Agent memory loading + formatting
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

  // Also load from OpenViking (with tracked metrics + fallback)
  try {
    const { trackedOvSearch } = await import("./ov-search.ts");
    const { memories } = await trackedOvSearch(
      `${agentName} agent lessons failures prevention`,
      5,
    );
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
  } catch { /* intentional: OV unavailable */ }

  return parts.join("\n");
}

export function formatMemoryForPrompt(memory: string, agentName: string): string {
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
// recordPattern (with auto-promotion)
// ===========================================================================

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
      existing.promotedAt = today;
      existing.hitsAtPromotion = existing.hitCount;
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

// ===========================================================================
// Per-agent lesson recorders
// ===========================================================================

export async function recordPlannerLesson(cycleId: string, task: any, finalState: string, context: any = {}) {
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

export async function recordExecutorLesson(cycleId: string, task: any, finalState: string, context: any = {}) {
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

export async function recordSkepticLesson(cycleId: string, task: any, skepticVerdict: string, finalState: string) {
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
// Issue #289 — Ineffective promoted-pattern detection
// ===========================================================================

/**
 * Pure helper — given a single pattern, decide whether it qualifies as
 * "promoted-but-ineffective". Exported for unit tests so we don't have to
 * round-trip through Redis.
 *
 * A pattern is ineffective when ALL of the following hold:
 *   1. `promoted === true` and `promotedAt` + `hitsAtPromotion` are present
 *      (legacy patterns promoted before this instrumentation are skipped).
 *   2. `daysSincePromotion >= MIN_DAYS_POST_PROMOTION` — we need a comparable
 *      window before judging.
 *   3. `postRate >= preRate` (or `preRate === 0`, in which case any
 *      post-promotion hits flag it).
 *
 * Returns the metric envelope when ineffective, otherwise null.
 */
export const MIN_DAYS_POST_PROMOTION = 3;

export function evaluatePromotedPatternEffectiveness(
  p: MemoryPattern,
  now: Date = new Date(),
): IneffectivePromotedPattern | null {
  if (!p.promoted || !p.promotedAt || typeof p.hitsAtPromotion !== "number") return null;

  const firstSeen = new Date(p.firstSeen + "T00:00:00Z");
  const promotedAt = new Date(p.promotedAt + "T00:00:00Z");
  const nowUtc = new Date(now.toISOString().split("T")[0] + "T00:00:00Z");

  const dayMs = 1000 * 60 * 60 * 24;
  const daysToPromotion = Math.max(1, Math.round((promotedAt.getTime() - firstSeen.getTime()) / dayMs));
  const daysSincePromotion = Math.max(0, Math.round((nowUtc.getTime() - promotedAt.getTime()) / dayMs));

  if (daysSincePromotion < MIN_DAYS_POST_PROMOTION) return null;

  const hitsSincePromotion = Math.max(0, p.hitCount - p.hitsAtPromotion);
  const preRate = p.hitsAtPromotion / daysToPromotion;
  const postRate = hitsSincePromotion / Math.max(1, daysSincePromotion);
  const rateRatio = preRate === 0 ? (hitsSincePromotion > 0 ? Infinity : 0) : postRate / preRate;

  const ineffective = preRate === 0 ? hitsSincePromotion > 0 : postRate >= preRate;
  if (!ineffective) return null;

  return {
    category: p.category,
    promotedAt: p.promotedAt,
    hitsAtPromotion: p.hitsAtPromotion,
    hitsSincePromotion,
    daysToPromotion,
    daysSincePromotion,
    preRate: round2(preRate),
    postRate: round2(postRate),
    rateRatio: Number.isFinite(rateRatio) ? round2(rateRatio) : rateRatio,
    lastSeen: p.lastSeen,
  };
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

/**
 * Return all patterns for `agentName` whose post-promotion firing rate is
 * at least as high as their pre-promotion rate. Used by the
 * `/api/learning/ineffective-rules` endpoint and surfaced in cycle reports.
 */
export async function getIneffectivePromotedPatterns(
  agentName: string,
  now: Date = new Date(),
): Promise<IneffectivePromotedPattern[]> {
  const patterns = await loadPatterns(agentName);
  const flagged: IneffectivePromotedPattern[] = [];
  for (const p of patterns) {
    const ev = evaluatePromotedPatternEffectiveness(p, now);
    if (ev) flagged.push(ev);
  }
  // Worst offenders first (highest post-promotion rate, then highest absolute hits-since)
  flagged.sort((a, b) => b.postRate - a.postRate || b.hitsSincePromotion - a.hitsSincePromotion);
  return flagged;
}

// ===========================================================================
// Daily consolidation
// ===========================================================================

/**
 * Prune stale patterns across all agents (called by consolidate()).
 * Keeps patterns that have hit count >=2, are recent, or have been promoted.
 */
export async function consolidateAgentPatterns(): Promise<void> {
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
// One-time legacy migration (hydra:rules:* → patterns)
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

export async function migrateRulesToPatterns() {
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
