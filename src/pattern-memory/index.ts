/**
 * Pattern Memory domain — public barrel.
 *
 * The Redis-backed per-agent / per-skill pattern store (`hydra:memory:{agent}:patterns`,
 * `hydra:friction:{skill}:patterns`) that captures recurring lessons and friction from
 * cycle outcomes, promotes them (stamping `promoted`/`promotedAt` on the Redis pattern
 * record) at the 3-hit threshold, and escalates recurring friction to GitHub issues. The
 * old promote→`config/feedback/to-{agent}.md` write path was retired once its Codex
 * consumers were deleted (issue #2962; ADR-0006 / #710). See **Pattern Memory**
 * in `CONTEXT.md`. The domain is a nine-file cluster; before this barrel, six of the
 * nine sub-files were imported directly by external callers, forcing every consumer to
 * navigate the internal split to find which leaf owns a given export.
 *
 * This barrel re-exports the surface external consumers need so that callers
 * (`src/api/pattern-memory.ts`, `src/learning/composition.ts`,
 * `src/autopilot/retro-bundle.ts`, `src/learning-lifecycle.ts`, and the
 * `src/aggregators/*` lessons/friction views) — plus the per-module test files — import
 * from `../pattern-memory` rather than reaching into each sub-file. Adding or
 * reorganizing an internal sub-file then requires updating only this barrel, not a
 * multi-file caller sweep (the same treatment the Health domain received in issue #2123).
 *
 * Internal cross-imports between sibling modules stay relative (`./pattern-store.ts`,
 * `./constants.ts`) — the module boundaries and internal dependency graph are unchanged;
 * only the external interface is concentrated here. `cue-matcher.ts`, `cue-policy.ts`,
 * `decision.ts`, and `escalation.ts` are pure-algorithm / ingestion leaves with no
 * external production callers, so they are intentionally NOT surfaced here; direct
 * test-only imports of those leaves stay relative (issue #3188).
 */

// --- Recording (write path) -------------------------------------------------
// The core record→promote lifecycle: capture a lesson/friction pattern, promote it
// (stamping the Redis pattern record) at threshold, and the daily consolidation prune.
export {
  recordPattern,
  loadAgentMemory,
  listFrictionPatterns,
  backfillPatternPromotionMetadata,
  consolidateAgentPatterns,
} from "./agent-memory.ts";

// --- Formatting (read path) -------------------------------------------------
// Renders the loaded memory into the prompt-composition surface (`learning/composition.ts`).
export { formatMemoryForPrompt } from "./prompt-format.ts";

// --- Subagent capture -------------------------------------------------------
// The subagent lesson/friction capture surface behind POST /api/memory/subagent/*.
export {
  captureSubagentLesson,
  captureSubagentFriction,
  isValidSkill,
  isValidOutcome,
} from "./subagent-capture.ts";

// --- Rule effectiveness (auto-demotion lifecycle) ---------------------------
// The promoted-rule effectiveness math, thresholds, cooldown, and rule-action audit log.
export {
  evaluatePromotedPatternEffectiveness,
  qualifiesForRuleAction,
  getIneffectivePromotedPatterns,
  getRuleActionLog,
  isEffectivenessCooldownExpired,
  isAutoDemoteEnabled,
  applyDemotionToPattern,
  consolidatePromotedRuleEffectiveness,
  RATE_RATIO_MULTIPLIER,
  ABSOLUTE_POSTRATE_THRESHOLD,
  ABSOLUTE_AGE_DAYS,
  EFFECTIVENESS_CHECK_COOLDOWN_HOURS,
  MIN_DAYS_POST_PROMOTION,
  type IneffectivePromotedPattern,
} from "./rule-effectiveness.ts";

// --- Constants --------------------------------------------------------------
// The 3-hit promotion threshold, imported by the aggregator lessons/friction views.
export { PROMOTION_THRESHOLD } from "./constants.ts";

// --- Types ------------------------------------------------------------------
// The stored-pattern record and the friction-pattern shape the aggregators read.
export type { MemoryPattern } from "./pattern-store.ts";
export type { FrictionPattern } from "./friction-pattern.ts";
