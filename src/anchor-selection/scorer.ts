// ---------------------------------------------------------------------------
// scoreCandidate — pure scoring helper for the decision-brain endpoint
// ---------------------------------------------------------------------------
//
// Issue #424. Maps the existing priority waterfall in selectAnchor() to a
// 0-1 confidence score so the upcoming decide.py decision brain can rank
// candidates without re-implementing the priority chain.
//
// **Critical:** This is purely ADDITIVE. The priority-waterfall logic in
// `select.ts` and the per-tier modules is preserved verbatim. The scorer
// only reads signals; it does not change which anchor selectAnchor() picks.
//
// Score derivation (all clamped to [0, 1]):
//   base score by priority tier (see PRIORITY_TIER_BASE_SCORE)
//   - freshness penalty: lastUpdated > 14 days → -0.15
//   - abandonment penalty: count >= 2 → -0.25; count >= 3 → -0.45
//   - reflection penalty: recent failure (<24h) → -0.20
//   - blocker-just-cleared bonus: meta.blockedReason present but lane is
//     not "blocked" AND movedAt within 24h → +0.15
//
// Pure function — no Redis, no side effects. Caller is responsible for
// loading the signals (so the helper can be unit-tested without a Redis
// fixture and so the endpoint controls batching).

export type PriorityTier =
  | "explicit-operator"   // 1 — opts.anchor (operator passes it in)
  | "capacity-floor"      // 1.2 — reframe-queue pre-emption (post-ADR-0010)
  | "failing-test"        // 2.7 / 2.8 — failing tests or typecheck errors
  | "kanban-queued"       // 2 — claimed from Kanban queued lane
  | "work-queue"          // 3 — POST /queue or research auto-queue
  | "reframe-queue"       // 4.5 — failed-repeatedly items getting a fresh prompt
  | "prior-failure"       // 5 — Redis prior-failures (capped at 2 retries)
  | "todo-marker"         // 5 — TODO/FIXME from grounding
  | "regression-hunt"     // 5.5 — every-10-merges adversarial check
  | "codebase-health"     // 6 — reductive improvements
  | "priorities-doc";     // 7 — operator direction fallback

/**
 * Base score for each tier in the priority waterfall. Higher = more
 * deserving of attention. The exact values are calibrated so that:
 *   - operator-floor / failing-test signals always score >= 0.5 even
 *     with every penalty applied (urgent work never gets gated by
 *     research_recommended)
 *   - priorities-doc fallback scores below 0.5 by default so an empty
 *     board (only priorities-doc candidates) flips research_recommended
 *     to true
 */
export const PRIORITY_TIER_BASE_SCORE: Record<PriorityTier, number> = {
  "explicit-operator": 1.00,
  "capacity-floor":    0.95,
  "failing-test":      0.95,
  "kanban-queued":     0.85,
  "work-queue":        0.70,
  "reframe-queue":     0.55,
  "prior-failure":     0.45,
  "todo-marker":       0.40,
  "regression-hunt":   0.35,
  "codebase-health":   0.30,
  "priorities-doc":    0.25,
};

export interface ScoreSignals {
  /** Tier the candidate belongs to in the priority waterfall. */
  priorityTier: PriorityTier;
  /** ISO timestamp of the candidate's most recent update (movedAt, added, etc). */
  lastUpdated?: string | null;
  /** Number of consecutive abandonments for this anchor (Redis counter). */
  abandonments?: number;
  /**
   * Most recent reflection timestamp (ISO) for this anchor's reference, if any.
   * Indicates the anchor has been tried and failed recently — downscore.
   */
  lastReflectionAt?: string | null;
  /**
   * True when the anchor was recently unblocked: blockedReason is present in
   * meta but lane is no longer "blocked" AND movedAt within the last 24h.
   * Upscore signal — a dependency just cleared.
   */
  blockerJustCleared?: boolean;
  /**
   * Optional override of "now" for deterministic tests. Falls back to
   * Date.now() when omitted.
   */
  now?: number;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
}

const FRESHNESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const RECENT_REFLECTION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const FRESHNESS_PENALTY = 0.15;
const ABANDONMENT_PENALTY_LOW = 0.25;  // >= 2 abandonments
const ABANDONMENT_PENALTY_HIGH = 0.45; // >= 3 abandonments (already circuit-broken)
const REFLECTION_PENALTY = 0.20;
const BLOCKER_CLEARED_BONUS = 0.15;

/**
 * Score a candidate anchor on a 0-1 scale.
 *
 * Pure function — pass the priority tier and observable signals; the function
 * returns the score plus a list of human-readable reasons for the score.
 *
 * The `anchor` parameter is reserved for future signals derived directly from
 * the anchor object (e.g. scope size). Today only `signals` is consulted, but
 * keeping the parameter in the signature avoids a breaking change when we
 * add anchor-derived signals later.
 */
export function scoreCandidate(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _anchor: unknown,
  signals: ScoreSignals,
): ScoreResult {
  const reasons: string[] = [];
  const base = PRIORITY_TIER_BASE_SCORE[signals.priorityTier];

  if (base === undefined) {
    // Unknown tier — fail loud per CLAUDE.md conventions but degrade
    // gracefully (return 0 rather than throw, the endpoint must keep
    // serving requests).
    console.error(`[AnchorScorer] Unknown priority tier: ${signals.priorityTier}`);
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

  // Abandonment penalty — graduated. >= 3 is already in circuit-breaker
  // territory; the kanban tier blocks the item, so it should not appear as
  // a candidate normally. Still penalise heavily if it does.
  const abandonments = signals.abandonments ?? 0;
  if (abandonments >= 3) {
    score -= ABANDONMENT_PENALTY_HIGH;
    reasons.push(`abandoned:${abandonments}x(-${ABANDONMENT_PENALTY_HIGH.toFixed(2)})`);
  } else if (abandonments >= 2) {
    score -= ABANDONMENT_PENALTY_LOW;
    reasons.push(`abandoned:${abandonments}x(-${ABANDONMENT_PENALTY_LOW.toFixed(2)})`);
  } else if (abandonments === 0) {
    reasons.push("first-attempt");
  } else {
    reasons.push(`abandoned:${abandonments}x`);
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
