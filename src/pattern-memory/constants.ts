/**
 * pattern-memory/constants.ts — promotion-policy constants
 *
 * Extracted from agent-memory.ts (issue #2117). `PROMOTION_THRESHOLD` is a
 * policy decision — "how many hits until a pattern promotes" — that belongs to
 * the pattern-memory domain's public contract, not to the implementation of the
 * Redis-backed store (`agent-memory.ts`). Display-tier aggregators
 * (`src/aggregators/friction-patterns.ts`, `lessons-overnight.ts`,
 * `lessons-trend.ts`, `lessons-explorer.ts`) read this number to flag
 * near-promotion rows; they should not have to import the 778-line store module
 * (with its Redis writes, promotion side-effects, and legacy migration) just to
 * find one constant.
 *
 * A leaf module: no Redis, no filesystem, no async, and no imports from the rest
 * of `src/pattern-memory/`. Import direction is one-way — the store module and
 * the aggregators import from here, never the reverse. Issue #2342 removed the
 * back-compat re-export from `agent-memory.ts`: every consumer (the store, the
 * aggregators, and the tests) now imports `PROMOTION_THRESHOLD` from here
 * directly, so the import path names the canonical owner.
 */

/**
 * Hit count at which a per-agent friction pattern auto-promotes to a feedback
 * rule. Lowered from 5 to 3 (test/learning-promotion-threshold.test.mts) so
 * patterns promote faster.
 */
export const PROMOTION_THRESHOLD = 3;
