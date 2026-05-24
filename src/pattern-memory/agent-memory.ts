/**
 * learning/agent-memory.ts — Per-agent pattern memory + auto-promotion
 *
 * Extracted from learning.ts (issue #219). Owns the Redis-backed pattern
 * tier, promotion to feedback files, stale-rule detection, and the legacy
 * `hydra:rules:*` migration.
 *
 * Public API used outside this module:
 *   PROMOTION_THRESHOLD            — exported constant
 *   recordPattern                  — POST /api/memory/:agent/pattern
 *   loadAgentMemory                — used by getContext()
 *   formatMemoryForPrompt          — formats raw memory string for prompts
 *   consolidateAgentPatterns       — daily prune driven by consolidate()
 *   detectStalePromotedRules       — pure helper (tests)
 *   processStaleRules              — pure helper (tests)
 *   migrateRulesToPatterns         — one-time startup migration
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  appendRuleAction,
  backfillPromotionMetaDone,
  deleteOldRules,
  getOldRules,
  getOldRulesCount,
  loadPatternsRaw,
  patternsExist,
  readRecentRuleActions,
  savePatternsRaw,
  setBackfillPromotionMetaDone,
} from "../redis/agent-memory.ts";
import {
  escalationThresholdForCue,
  isMetadataCue,
  shouldEscalateAtHitCount,
  type EscalationInput,
} from "./escalation.ts";

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
  /**
   * ISO timestamp (full ISO, not date) when the effectiveness check last
   * evaluated this pattern. Used to throttle alert/demote actions so we don't
   * spam the operator with the same finding every cycle (issue #365).
   */
  lastEffectivenessCheckAt?: string;
  /** Set true when the pattern was previously promoted but later demoted. */
  demoted?: boolean;
  /** ISO date the pattern was auto-demoted. */
  demotedAt?: string;
  /** Short machine-readable reason: "ineffective" | "manual" | "stale". */
  demotedReason?: string;
  /**
   * Issue #392 — discriminator identifying which call path produced this
   * pattern. `codex-cycle` is the historical in-process control-loop writer
   * (retired with ADR-0006) and `subagent` covers Claude-driven autopilot
   * skills (hydra-dev / hydra-qa / hydra-target-build) that POST to
   * /api/memory/subagent-lesson. Metadata only — does not alter the
   * consolidation/promotion math.
   */
  source?: "codex-cycle" | "subagent";
};

/**
 * Return shape of `recordPattern()`. The escalation field carries the
 * caller-decided side-effect: it's non-null when the recorded hit count is one
 * that merits a GitHub-issue dispatch. The caller passes it to
 * `escalateIfNeeded()` (from `escalation.ts`) to fire the dispatch — or omits
 * the dispatch entirely (e.g. in tests) to keep the call pure.
 *
 * This split is the seam the codebase used to elide via an inline
 * `maybeEscalate()` hook inside `recordPattern`: pattern accounting and
 * GitHub-issue accounting are two lifecycles, and joining them under one
 * function name hid the second from callers and tests.
 */
export type RecordPatternResult = {
  pattern: MemoryPattern;
  /** True when this call promoted the pattern to "cardinal" for the first time. */
  crossedThreshold: boolean;
  /**
   * Non-null when this hit count merits a GitHub-side dispatch. Pre-decision
   * (threshold lookup, kind mapping, input shaping) lives in `recordPattern`;
   * the caller just hands this to `escalateIfNeeded()`.
   */
  escalation: EscalationInput | null;
};

/**
 * Issue #289 — Promoted-but-ineffective pattern surfaced via
 * `getIneffectivePromotedPatterns()`. A promoted rule is "ineffective" when the
 * post-promotion firing rate (hits/day) is at least as high as the
 * pre-promotion rate. Promotion is supposed to durably change agent behavior;
 * a flat or rising rate means the rule text isn't actually preventing the
 * failure mode it describes.
 *
 * Issue #365 — `rateRatio: null` (the JSON serialization of `Infinity`) is
 * misleading in the API output. `rateRatioLabel` carries the human-readable
 * form ("infinite" when there's no pre-promotion baseline, otherwise the
 * numeric ratio formatted to two decimals). `reasonCode` distinguishes
 * relative-rate failures from absolute-rate failures so downstream consumers
 * (auto-demote, operator alerts) can act differently.
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
  rateRatioLabel: string; // "infinite" or "N.NN" — usable in JSON output
  reasonCode: "rate-ratio" | "absolute-postrate" | "no-baseline";
  lastSeen: string;
};

// ===========================================================================
// Effectiveness-check tuning knobs (issue #365)
// ===========================================================================

/** A pattern is flagged when postRate >= preRate * this multiplier. */
export const RATE_RATIO_MULTIPLIER = 1.5;
/** Or when postRate exceeds this absolute threshold *and* the rule has had
 *  enough time on the floor (`ABSOLUTE_AGE_DAYS`). */
export const ABSOLUTE_POSTRATE_THRESHOLD = 5; // hits/day
export const ABSOLUTE_AGE_DAYS = 14;
/** Demotion cooldown — re-checks of the same pattern within this window are
 *  no-ops, preventing alert spam if the operator restarts the orchestrator. */
export const EFFECTIVENESS_CHECK_COOLDOWN_HOURS = 24;
/** Cap on the rule-action audit log to keep the Redis list bounded. */
export const RULE_ACTION_LOG_CAP = 200;

// ===========================================================================
// Pattern storage
// ===========================================================================

/**
 * Issue #512 — pattern namespace. The legacy planner/executor/skeptic
 * patterns live under `hydra:memory:{agent}:patterns` (namespace="memory").
 * Friction patterns from subagent friction-reports live under
 * `hydra:friction:{skill}:patterns` (namespace="friction"). The two share
 * schema and promotion math, but only `memory` patterns write to the
 * `config/feedback/to-{agent}.md` files. Both fire the GitHub escalation
 * hook when their hit count crosses PROMOTION_THRESHOLD.
 */
export type PatternNamespace = "memory" | "friction";

async function loadPatterns(
  agentName: string,
  namespace: PatternNamespace = "memory",
): Promise<MemoryPattern[]> {
  const raw = await loadPatternsRaw(agentName, namespace);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function savePatterns(
  agentName: string,
  patterns: MemoryPattern[],
  namespace: PatternNamespace = "memory",
) {
  const sorted = patterns
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .slice(0, MAX_PATTERNS);
  await savePatternsRaw(agentName, JSON.stringify(sorted), namespace);
}

async function sweepStalePromotions(agentName: string) {
  const patterns = await loadPatterns(agentName);
  let changed = false;

  for (const p of patterns) {
    if (p.hitCount >= PROMOTION_THRESHOLD && !p.promoted) {
      try {
        // Issue #524 — metadata cues skip the feedback-file write but still
        // get the `promoted` stamp so we don't re-enter this branch.
        const metadataOnly = isMetadataCue(p.category);
        if (!metadataOnly) {
          await promoteToFeedback(agentName, p);
        }
        p.promoted = true;
        p.promotedAt = new Date().toISOString().split("T")[0];
        p.hitsAtPromotion = p.hitCount;
        changed = true;
        const target = metadataOnly
          ? "(metadata-only — feedback-file write skipped)"
          : `to-${agentName}.md`;
        console.log(`[Learning] Retroactive promotion: "${p.category}" to ${target} (${p.hitCount} hits)`);
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
    // Cross-cluster reach into the Knowledge Base — formatMemoryForPrompt
    // composes Pattern Memory (Redis patterns above) with OpenViking memory
    // search to build the agent's lesson prompt. Kept as a dynamic import so
    // OV outages don't load the module at all; the cluster boundary remains
    // visible in the path.
    const { trackedOvSearch } = await import("../knowledge-base/ov-search.ts");
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
 *
 * The optional `source` discriminator (issue #392) lets callers tag whether
 * the pattern came from the in-process codex cycle or from an autopilot
 * subagent. It is metadata only — the consolidation/promotion pipeline is
 * unchanged so existing 3-hit auto-promotion continues to apply regardless
 * of who recorded the hits.
 *
 * Issue #512 — `namespace` selects the Redis key family. `"memory"` (the
 * default) keeps the legacy behaviour: patterns land under
 * `hydra:memory:{agent}:patterns` and a promotion writes through to
 * `config/feedback/to-{agent}.md`. `"friction"` lands patterns under
 * `hydra:friction:{skill}:patterns` and skips the feedback-file write
 * (there is no `to-{skill}.md` for arbitrary subagent skills). Both
 * namespaces fire the GitHub-issue escalation hook on threshold-cross
 * and every multiple of 10 thereafter.
 */
export async function recordPattern(
  agentName: string,
  category: string,
  details: {
    severity?: "prevent" | "reinforce";
    action: string;
    example: string;
    cycleId: string;
    source?: "codex-cycle" | "subagent";
    namespace?: PatternNamespace;
  },
): Promise<RecordPatternResult> {
  const namespace: PatternNamespace = details.namespace || "memory";
  const patterns = await loadPatterns(agentName, namespace);
  const today = new Date().toISOString().split("T")[0];

  const existing = patterns.find(p => p.category === category);
  let crossedThreshold = false;
  let pattern: MemoryPattern;

  if (existing) {
    existing.hitCount++;
    existing.lastSeen = today;
    existing.lastCycleId = details.cycleId;
    existing.action = details.action;
    existing.examples = [details.example, ...existing.examples].slice(0, MAX_EXAMPLES);
    if (details.source) existing.source = details.source;

    if (existing.hitCount >= PROMOTION_THRESHOLD && !existing.promoted) {
      // Issue #524 — metadata cues (acceptance-criterion-deferred) record
      // hits and stamp `promoted: true` so we don't re-evaluate, but skip
      // the feedback-file write because they aren't defects.
      const metadataOnly = isMetadataCue(category);
      if (namespace === "memory" && !metadataOnly) {
        await promoteToFeedback(agentName, existing);
      }
      existing.promoted = true;
      existing.promotedAt = today;
      existing.hitsAtPromotion = existing.hitCount;
      crossedThreshold = true;
      const target = metadataOnly
        ? `(metadata-only — feedback-file write skipped)`
        : namespace === "memory" ? `to-${agentName}.md` : `friction:${agentName}`;
      console.log(`[Learning] Promoted "${category}" to ${target} (${existing.hitCount} hits)`);
    }
    pattern = existing;
  } else {
    pattern = {
      category,
      severity: details.severity || "prevent",
      hitCount: 1,
      firstSeen: today,
      lastSeen: today,
      lastCycleId: details.cycleId,
      action: details.action,
      examples: [details.example],
      promoted: false,
      source: details.source,
    };
    patterns.push(pattern);
  }

  await savePatterns(agentName, patterns, namespace);

  // Issue #512 — decide whether the caller should dispatch a GitHub-issue
  // escalation. Threshold-cross plus every multiple of 10 thereafter
  // (hitCount = threshold, threshold+10, threshold+20, ...). The decision and
  // input shaping live here so callers stay one-liners; the dispatch itself
  // is the caller's choice via `escalateIfNeeded(result.escalation, ctx)`.
  //
  // Issue #524 — per-cue threshold override. `acceptance-criterion-deferred`
  // uses a much higher threshold (20+) so it doesn't fire on every PR with
  // operator-observable ACs; everything else keeps the legacy 3-hit threshold.
  const threshold = escalationThresholdForCue(category, PROMOTION_THRESHOLD);
  const escalation: EscalationInput | null = shouldEscalateAtHitCount(pattern.hitCount, threshold)
    ? {
        kind: namespace === "friction" ? "friction" : "lesson",
        cue: category,
        hitCount: pattern.hitCount,
        skills: [agentName],
        workarounds: pattern.examples.filter(e => typeof e === "string" && e.trim().length > 0),
        lastReference: pattern.lastCycleId,
      }
    : null;

  return { pattern, crossedThreshold, escalation };
}

/**
 * Issue #512 — list all friction patterns across all known skills.
 * Exported so the `/api/learning/friction-patterns` endpoint can render
 * an observability view without bespoke Redis access.
 */
export async function listFrictionPatterns(
  skill: string,
): Promise<MemoryPattern[]> {
  return loadPatterns(skill, "friction");
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

  // The pattern qualifies as "ineffective" if any of:
  //   1. There is no pre-promotion baseline (preRate === 0, the backfill case)
  //      AND the rule has continued firing post-promotion.
  //   2. The post-promotion rate is at least as high as the pre-promotion rate
  //      (i.e. promotion did nothing or made things worse).
  // Note: the action layer (`processPromotedPatternEffectiveness`) applies a
  // stricter `RATE_RATIO_MULTIPLIER` before auto-demoting, but the diagnostic
  // endpoint surfaces anything that's not strictly improving.
  const ineffective = preRate === 0 ? hitsSincePromotion > 0 : postRate >= preRate;
  if (!ineffective) return null;

  const reasonCode: IneffectivePromotedPattern["reasonCode"] =
    preRate === 0
      ? "no-baseline"
      : postRate >= preRate * RATE_RATIO_MULTIPLIER
        ? "rate-ratio"
        : postRate >= ABSOLUTE_POSTRATE_THRESHOLD && daysSincePromotion >= ABSOLUTE_AGE_DAYS
          ? "absolute-postrate"
          : "rate-ratio";

  const rateRatioLabel = Number.isFinite(rateRatio)
    ? round2(rateRatio).toFixed(2)
    : "infinite";

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
    rateRatioLabel,
    reasonCode,
    lastSeen: p.lastSeen,
  };
}

/**
 * Issue #365 — decide whether the effectiveness check should ACT on a
 * pattern (auto-demote or alert), distinct from "should this surface in the
 * diagnostic endpoint." The action threshold is intentionally stricter than
 * the surface threshold so we never demote a rule that's merely flat.
 *
 * Returns the reason code when the pattern qualifies for action, null
 * otherwise. The reason is propagated to the rule-action log and any
 * auto-created `needs-info` issue.
 */
export function qualifiesForRuleAction(
  ev: IneffectivePromotedPattern,
): "rate-ratio" | "absolute-postrate" | "no-baseline" | null {
  // 1. Strong relative-rate failure: postRate is at least RATE_RATIO_MULTIPLIER
  //    times preRate. Doesn't apply when preRate is 0 (no baseline).
  if (ev.preRate > 0 && ev.postRate >= ev.preRate * RATE_RATIO_MULTIPLIER) {
    return "rate-ratio";
  }
  // 2. Absolute high firing rate after a long enough observation window —
  //    even without a baseline, 5+ hits/day for two weeks is conclusive.
  if (
    ev.postRate >= ABSOLUTE_POSTRATE_THRESHOLD &&
    ev.daysSincePromotion >= ABSOLUTE_AGE_DAYS
  ) {
    return ev.preRate === 0 ? "no-baseline" : "absolute-postrate";
  }
  return null;
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
// Issue #302 — One-time backfill of promotion metadata for legacy patterns
// ===========================================================================

/**
 * Pure helper — mutate-in-place backfill of `promotedAt` / `hitsAtPromotion`
 * for legacy promoted patterns. Exported for unit testing without Redis.
 *
 * Patterns promoted before issue #289 (commit 3fd70b4) have `promoted === true`
 * but lack the new metadata fields, which makes them invisible to
 * `evaluatePromotedPatternEffectiveness()`. These are exactly the patterns
 * worth flagging — they have been firing for weeks since promotion.
 *
 * Rules:
 *   - `promotedAt = firstSeen ?? lastSeen ?? today` (per AC3). Anchoring the
 *     promotion timestamp at pattern birth means `daysSincePromotion` covers
 *     the full lifetime, so the MIN_DAYS_POST_PROMOTION window is trivially
 *     satisfied and the detector can judge the pattern on its next call.
 *   - `hitsAtPromotion = 0` when `promotedAt` was missing. AC1 nominally
 *     says "use current hitCount as hitsAtPromotion", but combined with the
 *     birth-time `promotedAt` clamp (`daysToPromotion` becomes 1), that would
 *     produce an enormous `preRate` that no plausible post-rate could exceed,
 *     leaving the known offenders permanently invisible. Treating all
 *     historical hits as post-promotion is the only assignment consistent with
 *     AC3's "worst case: detector flags them immediately because they kept
 *     firing" and with the issue's stated goal that
 *     `/api/learning/ineffective-rules` should surface the existing 292/456-hit
 *     patterns after deploy.
 *   - When `promotedAt` is already present (partial-metadata case), preserve
 *     it and fall back to AC1's literal `hitsAtPromotion = hitCount` — the
 *     operator-set timestamp means `daysToPromotion` is meaningful and the
 *     standard math works.
 *
 * Returns the count of patterns mutated (0 when there is nothing to do, which
 * is the steady state after the first run).
 */
export function backfillPatternPromotionMetadata(
  patterns: MemoryPattern[],
  today: string = new Date().toISOString().split("T")[0],
): number {
  let mutated = 0;
  for (const p of patterns) {
    if (!p.promoted) continue;
    if (p.promotedAt && typeof p.hitsAtPromotion === "number") continue;

    const promotedAtWasMissing = !p.promotedAt;
    if (promotedAtWasMissing) {
      p.promotedAt = p.firstSeen || p.lastSeen || today;
    }
    if (typeof p.hitsAtPromotion !== "number") {
      // See doc comment above: 0 when we just synthesized promotedAt from
      // firstSeen, otherwise current hitCount per AC1.
      p.hitsAtPromotion = promotedAtWasMissing ? 0 : p.hitCount;
    }
    mutated++;
  }
  return mutated;
}

/**
 * One-time startup migration: scan planner/executor/skeptic patterns and
 * backfill missing promotion metadata. Idempotent — guarded by the
 * `hydra:learning:backfill:promotion-meta:done` Redis flag.
 *
 * Safe to call on every boot. Once the flag is set, this is a single Redis
 * lookup; the underlying Redis writes only happen on the first invocation
 * after the issue #289 instrumentation landed.
 */
export async function backfillPromotionMetadata(): Promise<void> {
  try {
    if (await backfillPromotionMetaDone()) return;
  } catch (err: any) {
    console.error(`[Learning] backfillPromotionMetadata: flag lookup failed: ${err.message}`);
    return;
  }

  let totalMutated = 0;
  for (const agent of ["planner", "executor", "skeptic"]) {
    try {
      const patterns = await loadPatterns(agent);
      if (patterns.length === 0) continue;
      const mutated = backfillPatternPromotionMetadata(patterns);
      if (mutated > 0) {
        await savePatterns(agent, patterns);
        totalMutated += mutated;
        console.log(`[Learning] Backfilled promotion metadata for ${mutated} ${agent} pattern(s)`);
      }
    } catch (err: any) {
      console.error(`[Learning] backfillPromotionMetadata: ${agent} pass failed: ${err.message}`);
    }
  }

  try {
    await setBackfillPromotionMetaDone(new Date().toISOString());
    if (totalMutated > 0) {
      console.log(`[Learning] Promotion-metadata backfill complete (${totalMutated} pattern(s) updated)`);
    }
  } catch (err: any) {
    console.error(`[Learning] backfillPromotionMetadata: flag write failed (will retry next boot): ${err.message}`);
  }
}

// ===========================================================================
// Issue #365 — Auto-demote / alert action on ineffective promoted rules
// ===========================================================================

export type RuleActionLogEntry = {
  /** ISO timestamp of the action. */
  ts: string;
  agent: "planner" | "executor" | "skeptic";
  category: string;
  action: "demoted" | "alerted" | "skipped-cooldown" | "skipped-disabled";
  reasonCode: IneffectivePromotedPattern["reasonCode"];
  /** Snapshot of the metric envelope at the time of action. */
  metrics: {
    hitsSincePromotion: number;
    daysSincePromotion: number;
    preRate: number;
    postRate: number;
    rateRatioLabel: string;
  };
  /** Set when `action === "demoted"` and the feedback-file rewrite succeeded. */
  feedbackFileRewritten?: boolean;
  /** Free-form note (e.g. "auto-demote disabled via HYDRA_RULE_AUTO_DEMOTE"). */
  note?: string;
};

/**
 * Pure helper — remove a promoted-rule block from a feedback file by category
 * heading. Returns `{ newContent, removed }` so the caller can decide whether
 * to write the file. The match is anchored to `### <category> (...)` — exactly
 * the heading format produced by `promoteToFeedback()`.
 *
 * Exported for unit tests (no I/O dependency).
 */
export function removePromotedRuleFromFeedback(
  feedbackContent: string,
  category: string,
): { newContent: string; removed: boolean } {
  const autoPromotedIdx = feedbackContent.indexOf("## Auto-Promoted Rules");
  if (autoPromotedIdx === -1) return { newContent: feedbackContent, removed: false };

  const staleIdx = feedbackContent.indexOf("## Stale Rules (review needed)", autoPromotedIdx);
  const sectionEnd = staleIdx !== -1 ? staleIdx : feedbackContent.length;
  const sectionContent = feedbackContent.slice(autoPromotedIdx, sectionEnd);

  // Find headings inside the Auto-Promoted section. The block goes from this
  // heading up to the next ### (or end of section).
  const headingRegex = /^### .+$/gm;
  const headings: { index: number; match: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(sectionContent)) !== null) {
    headings.push({ index: m.index, match: m[0] });
  }

  // Match heading that starts with `### <category> (` — the format produced
  // by promoteToFeedback().
  const headingPrefix = `### ${category} (`;
  const targetIdx = headings.findIndex(h => h.match.startsWith(headingPrefix));
  if (targetIdx === -1) return { newContent: feedbackContent, removed: false };

  const target = headings[targetIdx];
  const blockStartInSection = target.index;
  const blockEndInSection =
    targetIdx + 1 < headings.length ? headings[targetIdx + 1].index : sectionContent.length;

  const absStart = autoPromotedIdx + blockStartInSection;
  const absEnd = autoPromotedIdx + blockEndInSection;

  let newContent = feedbackContent.slice(0, absStart) + feedbackContent.slice(absEnd);
  // Collapse triple+ newlines produced by the removal.
  newContent = newContent.replace(/\n{3,}/g, "\n\n");
  return { newContent, removed: true };
}

/**
 * Remove a promoted rule block from `config/feedback/to-{agent}.md`.
 * Side-effecting wrapper around `removePromotedRuleFromFeedback()`.
 * Returns true when the file was rewritten.
 */
export async function demotePromotedRuleFromFeedbackFile(
  agentName: string,
  category: string,
): Promise<boolean> {
  const feedbackPath = join(CONFIG_PATH, "feedback", `to-${agentName}.md`);
  try {
    const content = await readFile(feedbackPath, "utf-8");
    const { newContent, removed } = removePromotedRuleFromFeedback(content, category);
    if (!removed || newContent === content) return false;
    await writeFile(feedbackPath, newContent);
    return true;
  } catch (err: any) {
    console.error(
      `[Learning] demotePromotedRuleFromFeedbackFile(${agentName}, ${category}) failed: ${err.message}`,
    );
    return false;
  }
}

/**
 * Append a rule-action audit entry to the bounded Redis list. Tail entries
 * past `RULE_ACTION_LOG_CAP` are trimmed away. Best-effort: log + swallow
 * errors so a Redis blip can't break the daily consolidation pass.
 */
export async function recordRuleAction(entry: RuleActionLogEntry): Promise<void> {
  try {
    await appendRuleAction(JSON.stringify(entry), RULE_ACTION_LOG_CAP);
  } catch (err: any) {
    console.error(`[Learning] recordRuleAction failed: ${err.message}`);
  }
}

/** Fetch the rule-action audit log (newest first), up to `limit` entries. */
export async function getRuleActionLog(limit = 50): Promise<RuleActionLogEntry[]> {
  try {
    const raw = await readRecentRuleActions(limit);
    const out: RuleActionLogEntry[] = [];
    for (const r of raw) {
      try {
        out.push(JSON.parse(r));
      } catch { /* intentional: skip unparseable log entries */ }
    }
    return out;
  } catch (err: any) {
    console.error(`[Learning] getRuleActionLog failed: ${err.message}`);
    return [];
  }
}

/**
 * Pure helper — given a pattern's `lastEffectivenessCheckAt` and a reference
 * time, decide whether the cooldown has expired. Exported for tests.
 */
export function isEffectivenessCooldownExpired(
  lastCheckIso: string | undefined,
  now: Date = new Date(),
  cooldownHours: number = EFFECTIVENESS_CHECK_COOLDOWN_HOURS,
): boolean {
  if (!lastCheckIso) return true;
  const last = Date.parse(lastCheckIso);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= cooldownHours * 60 * 60 * 1000;
}

/** True when `HYDRA_RULE_AUTO_DEMOTE` is not explicitly set to "false". */
export function isAutoDemoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.HYDRA_RULE_AUTO_DEMOTE;
  if (raw == null) return true;
  return raw.trim().toLowerCase() !== "false" && raw.trim() !== "0";
}

/**
 * Pure helper — given a single pattern that has already been classified
 * ineffective + action-worthy, mutate it in place to reflect a demotion.
 * Caller is responsible for the feedback-file rewrite + audit log.
 */
export function applyDemotionToPattern(p: MemoryPattern, todayIso: string): void {
  p.promoted = false;
  // Preserve a breadcrumb of the prior promotion for diagnostics.
  // Note: hitsAtPromotion/promotedAt are cleared so the same pattern won't
  // re-fire the effectiveness check on the very next cycle if hits keep
  // climbing. If hitCount later reaches PROMOTION_THRESHOLD again, the
  // standard sweep will re-promote with fresh metadata.
  p.promotedAt = undefined;
  p.hitsAtPromotion = undefined;
  p.demoted = true;
  p.demotedAt = todayIso.split("T")[0];
  p.demotedReason = "ineffective";
}

/**
 * Run the effectiveness check across all promoted patterns for a single
 * agent. For each pattern that `qualifiesForRuleAction()` flags:
 *   - if auto-demote is enabled, demote the pattern (Redis) + remove from
 *     the feedback file + record `action: "demoted"`.
 *   - if auto-demote is disabled, record `action: "alerted"` only.
 *   - if the same pattern was already checked within the cooldown window,
 *     record `action: "skipped-cooldown"` and move on.
 *
 * The `lastEffectivenessCheckAt` stamp is always updated, even when no
 * action was taken, so cooldown applies uniformly.
 *
 * Returns the list of actions taken (excluding skips) — useful for the
 * scheduler to log a one-line summary.
 */
export async function processPromotedPatternEffectiveness(
  agentName: "planner" | "executor" | "skeptic",
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuleActionLogEntry[]> {
  const patterns = await loadPatterns(agentName);
  if (patterns.length === 0) return [];

  const nowIso = now.toISOString();
  const today = nowIso.split("T")[0];
  const autoDemote = isAutoDemoteEnabled(env);
  const actions: RuleActionLogEntry[] = [];
  let changed = false;

  for (const p of patterns) {
    if (!p.promoted) continue;
    const ev = evaluatePromotedPatternEffectiveness(p, now);
    if (!ev) continue;
    const reasonCode = qualifiesForRuleAction(ev);
    if (!reasonCode) continue;

    // Cooldown — skip if checked recently.
    if (!isEffectivenessCooldownExpired(p.lastEffectivenessCheckAt, now)) {
      const entry: RuleActionLogEntry = {
        ts: nowIso,
        agent: agentName,
        category: p.category,
        action: "skipped-cooldown",
        reasonCode,
        metrics: {
          hitsSincePromotion: ev.hitsSincePromotion,
          daysSincePromotion: ev.daysSincePromotion,
          preRate: ev.preRate,
          postRate: ev.postRate,
          rateRatioLabel: ev.rateRatioLabel,
        },
      };
      await recordRuleAction(entry);
      continue;
    }

    // Stamp the check time regardless of action so we honour cooldown next pass.
    p.lastEffectivenessCheckAt = nowIso;

    if (!autoDemote) {
      const entry: RuleActionLogEntry = {
        ts: nowIso,
        agent: agentName,
        category: p.category,
        action: "skipped-disabled",
        reasonCode,
        metrics: {
          hitsSincePromotion: ev.hitsSincePromotion,
          daysSincePromotion: ev.daysSincePromotion,
          preRate: ev.preRate,
          postRate: ev.postRate,
          rateRatioLabel: ev.rateRatioLabel,
        },
        note: "auto-demote disabled via HYDRA_RULE_AUTO_DEMOTE=false",
      };
      actions.push(entry);
      await recordRuleAction(entry);
      changed = true;
      continue;
    }

    // Auto-demote path.
    applyDemotionToPattern(p, today);
    let feedbackFileRewritten = false;
    try {
      feedbackFileRewritten = await demotePromotedRuleFromFeedbackFile(agentName, p.category);
    } catch (err: any) {
      console.error(`[Learning] demote feedback rewrite failed for ${agentName}/${p.category}: ${err.message}`);
    }
    const entry: RuleActionLogEntry = {
      ts: nowIso,
      agent: agentName,
      category: p.category,
      action: "demoted",
      reasonCode,
      metrics: {
        hitsSincePromotion: ev.hitsSincePromotion,
        daysSincePromotion: ev.daysSincePromotion,
        preRate: ev.preRate,
        postRate: ev.postRate,
        rateRatioLabel: ev.rateRatioLabel,
      },
      feedbackFileRewritten,
    };
    actions.push(entry);
    await recordRuleAction(entry);
    changed = true;
    console.log(
      `[Learning] Auto-demoted ${agentName}/${p.category} — ` +
        `${ev.hitsSincePromotion} hits over ${ev.daysSincePromotion}d ` +
        `(postRate=${ev.postRate}/day, preRate=${ev.preRate}/day, reason=${reasonCode})`,
    );
  }

  if (changed) {
    await savePatterns(agentName, patterns);
  }
  return actions;
}

/**
 * Entry point invoked from `consolidate()` once per day. Runs the
 * effectiveness check across planner/executor/skeptic. Always returns
 * cleanly — Redis or feedback-file errors are logged but never thrown.
 */
export async function consolidatePromotedRuleEffectiveness(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuleActionLogEntry[]> {
  const all: RuleActionLogEntry[] = [];
  for (const agent of ["planner", "executor", "skeptic"] as const) {
    try {
      const taken = await processPromotedPatternEffectiveness(agent, now, env);
      all.push(...taken);
    } catch (err: any) {
      console.error(`[Learning] consolidatePromotedRuleEffectiveness(${agent}) failed: ${err.message}`);
    }
  }
  if (all.length > 0) {
    const demoted = all.filter(a => a.action === "demoted").length;
    const alerted = all.filter(a => a.action === "skipped-disabled").length;
    console.log(
      `[Learning] Rule-effectiveness pass: ${demoted} demoted, ${alerted} alerted (auto-demote disabled)`,
    );
  }
  return all;
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
