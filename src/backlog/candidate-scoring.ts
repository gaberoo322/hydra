// ---------------------------------------------------------------------------
// Candidate Scoring — the pure scoring policy for the Candidate Feed.
// ---------------------------------------------------------------------------
//
// Extracted from `src/anchor-candidates.ts` (issue #2040), mirroring the
// `src/backlog/merged-refs.ts` (#1880) and `src/backlog/work-queue-hygiene.ts`
// (#1844) extractions that pulled co-located concerns out of the same file.
//
// This module owns the pure ARITHMETIC half of the Candidate Feed: the tier
// base ladder, the freshness / recent-reflection penalties, the
// blocker-just-cleared bonus, and the [0,1] clamp. It has NO Redis dependency
// and no I/O — `scoreCandidate(signals)` is deterministic given an injected
// `now`, and degrades to `{score:0, reasons:["unknown-tier"]}` rather than
// throwing on an unknown tier.
//
// The stateful ELIGIBILITY half (enumeration + the three Redis-backed
// eligibility guards: in-flight-PR suppression, merged-by-cycle suppression,
// blocker-just-cleared detection) stays in `getCandidateFeed`
// (`src/anchor-candidates.ts`). The split moves scoring OUT, not eligibility —
// ADR-0016's Locality invariant ("scoring has exactly ONE home") is preserved:
// the tier base scores, penalty/bonus weights, and the clamp live ONLY here,
// never duplicated back into anchor-candidates.ts. The feed module imports the
// scorer from this one location (and re-exports the symbols for backward
// compatibility so the Candidate Feed public surface is unchanged).

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
 * Reads the most recent reflection timestamp (ISO) for an anchor reference, or
 * null when the anchor has no reflection. This is the I/O half of the
 * reflection-freshness signal — the WHAT (which timestamp to read, how a miss
 * maps to null). It is co-located here, next to the penalty math in
 * `scoreCandidate`, so "how fresh is this anchor's last reflection, and how much
 * does it penalize the score?" is answerable from THIS file alone (issue #3392).
 *
 * Must never reject — a failing read degrades to `null` (score as if no
 * reflection existed), never drops the candidate (ADR-0016 invariant). The
 * production reader (`loadLastReflectionAtImpl` in `src/anchor-candidates.ts`)
 * already catches internally; the fail-open wrap in `scoreCandidateWithReflection`
 * shields the scoring contract against an injected reader that throws.
 */
export type ReflectionReader = (anchorRef: string) => Promise<string | null>;

/**
 * The reflection-aware scoring contract: fetch the anchor's last-reflection
 * timestamp via the injected `readReflectionAt`, fold it into `signals`, and
 * delegate to the pure `scoreCandidate`. This is the single surface a caller
 * uses to score a candidate INCLUDING the reflection-freshness penalty — the
 * fetch is part of the scoring contract, not the coordinator's loop (issue
 * #3392). `scoreCandidate` stays pure; this async wrapper owns the one I/O read.
 *
 * Fail-open: a `readReflectionAt` that throws is caught here (logged, then
 * treated as null) so the reflection penalty is simply not applied — the
 * candidate is never dropped. Any `signals.lastReflectionAt` already present is
 * overridden by the fetched value; pass `signals` WITHOUT `lastReflectionAt`.
 */
export async function scoreCandidateWithReflection(
  anchorRef: string,
  signals: Omit<ScoreSignals, "lastReflectionAt">,
  readReflectionAt: ReflectionReader,
): Promise<ScoreResult> {
  let lastReflectionAt: string | null = null;
  try {
    lastReflectionAt = await readReflectionAt(anchorRef);
  } catch (err: any) {
    console.error(
      `[CandidateFeed] reflection annotation failed for "${anchorRef.slice(0, 60)}": ${err?.message ?? err}`,
    );
  }
  return scoreCandidate({ ...signals, lastReflectionAt });
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
