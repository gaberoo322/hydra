/**
 * pattern-memory/pattern-store.ts — the shared pattern-store seam
 *
 * Extracted from `agent-memory.ts` (issue #2987). `loadPatterns` and
 * `savePatterns` used to be exported from `agent-memory.ts` "only because the
 * sibling `rule-effectiveness.ts` needs them" (issue #900) — a backwards-import
 * edge where one sibling reached into another for a concern neither fully owned.
 *
 * This leaf module now owns the store surface: the `MemoryPattern` type, the
 * `PatternNamespace` selector, and the `loadPatterns`/`savePatterns` helpers
 * that wrap the raw `redis/agent-memory.ts` accessor with the JSON
 * parse/sort/cap layer. Both `agent-memory.ts` and `rule-effectiveness.ts`
 * import DOWNWARD from here — the same one-directional pattern the rest of
 * `src/pattern-memory/` uses (`constants.ts`, `cue-matcher.ts`, `decision.ts`).
 *
 * Import direction is one-way:
 *
 *   rule-effectiveness.ts  →  pattern-store.ts  →  redis/agent-memory.ts
 *   agent-memory.ts        →  pattern-store.ts  →  redis/agent-memory.ts
 *
 * The store never imports back up into `agent-memory.ts`; the only dependency
 * is the raw Redis accessor beneath it. That makes storage-format changes (key
 * namespace, JSON schema, sort order, cap) live in one place, and makes the
 * store directly stubbable in `rule-effectiveness.ts` tests via the
 * `redis/agent-memory.ts` seam.
 */

import {
  loadPatternsRaw,
  savePatternsRaw,
} from "../redis/agent-memory.ts";
import type { EscalationResult } from "./escalation.ts";

/** Max patterns retained per agent/skill (most-recently-seen wins). */
const MAX_PATTERNS = 15;

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
  /**
   * Issue #843 — the **Escalation Outcome** of the most recent escalation that
   * actually fired for this pattern. Stamped by `recordPattern()` via a
   * best-effort SECOND save AFTER the GitHub-side dispatch, so it is written
   * ONLY when an escalation fired (below-threshold hits leave it untouched).
   *
   * `at` is a full ISO timestamp (not a date) so a column of `error` statuses
   * in the friction-patterns surface can be correlated with a systematic
   * gh/auth outage. Optional + additive: it rides the existing
   * `savePatternsRaw`/`loadPatternsRaw` JSON round-trip (no new key, no
   * migration); records written before #843 simply lack the field.
   */
  lastEscalation?: {
    status: EscalationResult["status"];
    issueNumber?: number;
    error?: string;
    at: string;
  };
  /**
   * Issue #1667 — alternate cue spellings that fuzzy-merged into this
   * pattern (write-side normalization in `recordPattern`). Subagents
   * free-author kebab-case cues, so the same gotcha used to land under
   * several spellings, each stuck at hitCount:1 — starving the
   * hitCount-based promotion/escalation machinery. The canonical spelling
   * stays `category` (the OLDER spelling wins); merged variants are kept
   * here, capped at MAX_ALIASES, purely for observability. Additive field:
   * pre-#1667 records simply lack it.
   */
  aliases?: string[];
};

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

/**
 * Load the parsed pattern array for an agent/skill.
 *
 * Wraps `loadPatternsRaw` with the JSON parse (returning `[]` on a missing key
 * or malformed JSON). Both pattern-memory siblings (`agent-memory.ts` and
 * `rule-effectiveness.ts`) read the SAME `hydra:{namespace}:{agent}:patterns`
 * JSON through this one seam rather than duplicating the parse.
 */
export async function loadPatterns(
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

/**
 * Persist the pattern array for an agent/skill.
 *
 * Applies the store's sort (most-recently-seen first) + cap (`MAX_PATTERNS`)
 * before serializing through `savePatternsRaw`. The one place the storage
 * format (sort key, cap) is decided.
 */
export async function savePatterns(
  agentName: string,
  patterns: MemoryPattern[],
  namespace: PatternNamespace = "memory",
) {
  const sorted = patterns
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
    .slice(0, MAX_PATTERNS);
  await savePatternsRaw(agentName, JSON.stringify(sorted), namespace);
}
