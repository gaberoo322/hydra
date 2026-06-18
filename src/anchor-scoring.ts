// ---------------------------------------------------------------------------
// Anchor Scoring — the pure scoring arithmetic of the Candidate Feed.
// ---------------------------------------------------------------------------
//
// Extracted from `src/anchor-candidates.ts` (issue #2040) so the pure scoring
// concern lives in one focused, Redis-free module — the same split that gave
// `health-rules.ts` / `health-diagnostics.ts` (issue #1867) and
// `design-concept-gate.ts` / `design-concept.ts` (issue #1908) their testable
// homes.
//
// What lives here: the tier ladder (`PriorityTier`,
// `PRIORITY_TIER_BASE_SCORE`), the penalty/bonus weights + thresholds, the
// research-recommendation threshold, and `scoreCandidate` — a pure function
// that takes a tier plus observable signals and returns a clamped [0,1] score
// with human-readable reasons. ZERO Redis / I/O dependency: scoring can be
// unit-tested with plain object literals, no deps stub.
//
// What stays in `src/anchor-candidates.ts`: enumeration of the live lanes and
// the STATEFUL eligibility guards (in-flight-PR / merged-by-cycle suppression,
// blocker-just-cleared detection, design-concept annotation) that each do Redis
// reads. `anchor-candidates.ts` imports this module and re-exports its public
// symbols, so the Candidate Feed's public interface (`getCandidateFeed` plus the
// scoring exports it has always surfaced) is unchanged.
//
// ADR-0016 owns the scoring policy this module encodes: tier base + freshness
// penalty + recent-reflection penalty + blocker-just-cleared bonus, clamped to
// [0,1]; the abandonment penalty was dropped (dead lane) and the `PriorityTier`
// union shrank to the two live values.

// ---------------------------------------------------------------------------
// Scoring policy — the tier ladder + penalty/bonus weights.
// ---------------------------------------------------------------------------

/**
 * The two live priority tiers. ADR-0016 shrank this union from the 11-tier
 * waterfall to the only lanes that have a live writer: Kanban-queued items and
 * the operator/research work-queue.
 */
export type PriorityTier = "kanban-queued" | "work-queue";

/**
 * Base score for each live tier. Higher = more deserving of attention.
 * Calibrated so a fresh kanban / work-queue item scores well above the
 * research threshold (0.5) while still leaving room for penalties, and so an
 * empty board flips `research_recommended` to true.
 */
export const PRIORITY_TIER_BASE_SCORE: Record<PriorityTier, number> = {
  "kanban-queued": 0.85,
  "work-queue":    0.70,
};

/** Top score below this → recommend research (consumed by the feed). */
export const RESEARCH_THRESHOLD = 0.5;
const FRESHNESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const RECENT_REFLECTION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const FRESHNESS_PENALTY = 0.15;
const REFLECTION_PENALTY = 0.20;
const BLOCKER_CLEARED_BONUS = 0.15;

export interface ScoreSignals {
  /** Tier the candidate belongs to. */
  priorityTier: PriorityTier;
  /** ISO timestamp of the candidate's most recent update (movedAt, queuedAt, …). */
  lastUpdated?: string | null;
  /**
   * Most recent reflection timestamp (ISO) for this anchor's reference, if any.
   * A recent (<24h) reflection means the anchor was tried and failed lately —
   * downscore so the brain doesn't immediately re-pick a just-failed anchor.
   */
  lastReflectionAt?: string | null;
  /**
   * True when the anchor was recently unblocked: a `blockedReason` is present
   * in meta but the lane is no longer "blocked" AND movedAt is within 24h.
   * Upscore — a dependency just cleared.
   */
  blockerJustCleared?: boolean;
  /** Override of "now" for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
}

/**
 * Score a candidate anchor on a 0-1 scale. Pure — pass the tier and observable
 * signals; returns the score plus human-readable reasons.
 *
 * Degrades gracefully (returns 0, never throws) on an unknown tier so the feed
 * keeps serving.
 */
export function scoreCandidate(signals: ScoreSignals): ScoreResult {
  const reasons: string[] = [];
  const base = PRIORITY_TIER_BASE_SCORE[signals.priorityTier];

  if (base === undefined) {
    console.error(`[CandidateFeed] Unknown priority tier: ${signals.priorityTier}`);
    return { score: 0, reasons: ["unknown-tier"] };
  }

  let score = base;
  reasons.push(`tier:${signals.priorityTier}(+${base.toFixed(2)})`);

  const now = signals.now ?? Date.now();

  // Freshness penalty
  if (signals.lastUpdated) {
    const ageMs = now - new Date(signals.lastUpdated).getTime();
    if (Number.isFinite(ageMs) && ageMs > FRESHNESS_THRESHOLD_MS) {
      score -= FRESHNESS_PENALTY;
      const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
      reasons.push(`stale:${ageDays}d(-${FRESHNESS_PENALTY.toFixed(2)})`);
    } else {
      reasons.push("fresh");
    }
  }

  // Recent reflection penalty
  if (signals.lastReflectionAt) {
    const age = now - new Date(signals.lastReflectionAt).getTime();
    if (Number.isFinite(age) && age < RECENT_REFLECTION_THRESHOLD_MS) {
      score -= REFLECTION_PENALTY;
      reasons.push(`recent-failure(-${REFLECTION_PENALTY.toFixed(2)})`);
    }
  }

  // Blocker-just-cleared bonus
  if (signals.blockerJustCleared) {
    score += BLOCKER_CLEARED_BONUS;
    reasons.push(`blocker-cleared(+${BLOCKER_CLEARED_BONUS.toFixed(2)})`);
  }

  // Clamp to [0, 1]
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return { score, reasons };
}
