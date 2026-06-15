/**
 * Design-Concept Gate — the pure dispatch-gate predicate (extracted from
 * `src/design-concept.ts`, issue #1908).
 *
 * This module is the domain home for the single question "is this design-concept
 * artifact dispatch-ready?". It holds the gate predicate (`gateCheck`), the
 * freshness helper (`isFresh`) it composes, and the freshness-window constant
 * (`DESIGN_CONCEPT_MAX_AGE_MS`).
 *
 * The gate is the deepest concern that used to live in the 650-line persistence
 * module: it is the only part that couples to the tier-classifier boundary
 * (`classifyChange` + `permitsBreakingChange`), a concern entirely orthogonal to
 * Redis persistence. Pulling it out makes that coupling visible at the import
 * header here, lets `anchor-candidates.ts` / `api/design-concepts.ts` import a
 * narrow "I am consulting the gate" surface, and lets the gate be unit-tested
 * with plain object literals — the module has ZERO runtime Redis access (only
 * the type-level `DesignConcept` shape is borrowed from the persistence module).
 *
 * The `DesignConcept` type is imported one-way (type-only) from the persistence
 * module; the persistence module no longer imports the tier-classifier. See
 * ADR-0008 for the gate semantics this predicate implements.
 */

import type { DesignConcept } from "./design-concept.ts";
import { classifyChange } from "./tier-classifier.ts";
import { permitsBreakingChange } from "./tier-policy.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7 days, in milliseconds. */
export const DESIGN_CONCEPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum Q&A trace depth for the gate. From the ADR-0008 schema. */
const MIN_QA_TRACE_LENGTH = 6;

// ---------------------------------------------------------------------------
// Freshness + gate
// ---------------------------------------------------------------------------

/**
 * Return true iff the artifact was created within the freshness window
 * (7 days by default). Pure function — no Redis IO.
 */
export function isFresh(
  d: DesignConcept,
  now: number,
  maxAgeMs: number = DESIGN_CONCEPT_MAX_AGE_MS,
): boolean {
  if (!d || typeof d.createdAt !== "number" || d.createdAt <= 0) return false;
  return now - d.createdAt <= maxAgeMs;
}

/**
 * Gate check — the 7 deterministic failure modes from ADR-0008 §"Gate
 * check". Returns `{ ok: true, reasons: [] }` only when EVERY rule
 * passes. Pure function — no Redis IO. The autopilot consumes this
 * verbatim in Phase B.
 *
 * For Phase A: `glossaryGaps` fails closed (any non-empty list is a
 * reject). The whitelist-via-Redis escape hatch lands later.
 *
 * For Phase A: `interfaceImpact: 'breaking'` cross-checks against the
 * existing tier classifier in `src/tier-classifier.ts` — every breaking
 * module path must classify to tier >= 2. Under the monotonic T1–T4
 * ladder (ADR-0015) a "breaking" declaration on a T1 (prompt-shaped,
 * auto-merge-trivial) path is the only gate failure here: T1 is the
 * shallowest, lowest-blast-radius tier and a breaking change there is a
 * contradiction. T2 (outcome-holdback), T3 (operator-review), and T4
 * (Verifier Core — the deepest tier, carrying the most verification) all
 * clear this check. NOTE (issue #737): under the old non-monotonic
 * numbering a breaking change on a Tier-0 path FAILED this rule
 * (0 < 2); under the monotonic ladder Verifier Core is T4 (deepest) and
 * now PASSES — this corrects a latent inversion (the deepest tier should
 * carry the most verification, not be rejected). Intended behavior delta,
 * not a regression.
 */
export function gateCheck(
  d: DesignConcept,
  now: number,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1. No glossary gaps allowed in Phase A.
  if (Array.isArray(d.glossaryGaps) && d.glossaryGaps.length > 0) {
    reasons.push(
      `glossaryGaps non-empty (${d.glossaryGaps.length}): ${d.glossaryGaps.join(", ")}`,
    );
  }

  // 2. At least one invariant.
  if (!Array.isArray(d.invariants) || d.invariants.length < 1) {
    reasons.push("invariants must list at least 1 entry");
  }

  // 3. At least one modulesTouched.
  if (!Array.isArray(d.modulesTouched) || d.modulesTouched.length < 1) {
    reasons.push("modulesTouched must list at least 1 entry");
  }

  // 4. Breaking impact → tier ≥ 2.
  const breakingPaths = (d.modulesTouched ?? [])
    .filter((m) => m && m.interfaceImpact === "breaking")
    .map((m) => m.path);
  if (breakingPaths.length > 0) {
    const cls = classifyChange(breakingPaths);
    if (!permitsBreakingChange(cls.tier)) {
      reasons.push(
        `interfaceImpact: 'breaking' on tier-${cls.tier} path(s) — breaking change must classify to tier >= 2 ` +
          `(got: ${cls.reason})`,
      );
    }
  }

  // 5. Q&A trace depth.
  if (!Array.isArray(d.qaTrace) || d.qaTrace.length < MIN_QA_TRACE_LENGTH) {
    reasons.push(
      `qaTrace must have at least ${MIN_QA_TRACE_LENGTH} turns (got ${d.qaTrace?.length ?? 0})`,
    );
  }

  // 6. Freshness.
  if (!isFresh(d, now)) {
    reasons.push("artifact is stale (older than 7 days)");
  }

  // 7. Status must be approved.
  if (d.status !== "approved") {
    reasons.push(`status must be 'approved' (got '${d.status}')`);
  }

  return { ok: reasons.length === 0, reasons };
}
