/**
 * pattern-memory/friction-pattern.ts — the read-side friction-pattern domain type
 *
 * Extracted from `src/aggregators/lessons-overnight.ts` (issue #2596). This is
 * the domain type for a friction pattern as a *read-side view* — the shape the
 * `friction-source.ts` scan seam returns and the shape the display-tier
 * aggregators (`lessons-overnight.ts`, `lessons-trend.ts`) consume to produce
 * their windowed/sorted/filtered views.
 *
 * Before this move the type lived in `lessons-overnight.ts`, which forced
 * `lessons-trend.ts` to reach laterally into a *sibling aggregator* for a shared
 * domain type it did not author. Homing it here — next to `MemoryPattern` (the
 * write-side counterpart in `agent-memory.ts`) and `PROMOTION_THRESHOLD` (the
 * promotion-policy constant in `constants.ts`) — gives "what is a friction
 * pattern as a domain value?" a single answer in the `pattern-memory` domain.
 *
 * A leaf module (mirroring `constants.ts`): no Redis, no filesystem, no async,
 * and no imports from the rest of `src/pattern-memory/`. Import direction is
 * one-way — the aggregators import from here, never the reverse.
 *
 * This is a pure TypeScript-type relocation with zero runtime-behaviour delta.
 * The distinct `RawFrictionPattern` shape (`friction-patterns.ts`) is a
 * structural superset and is deliberately NOT unified here (see issue #2596).
 */

/**
 * Minimal shape of one entry in a `hydra:friction:{skill}:patterns` JSON
 * array. Mirrors `MemoryPattern` from `pattern-memory/agent-memory.ts` but
 * only the fields the display-tier aggregators read — keeping the type narrow
 * avoids a ts-only coupling on `MemoryPattern`'s growing field list.
 *
 * The field is `category` (matching `MemoryPattern.category` and the raw Redis
 * JSON), NOT `cue` — `cue` is the aggregators' display-projection field name,
 * not the stored field name.
 */
export interface FrictionPattern {
  category: string;
  hitCount: number;
  promoted?: boolean;
  lastSeen: string;
  examples?: string[];
}
