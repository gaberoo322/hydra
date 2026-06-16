// ---------------------------------------------------------------------------
// Candidate Feed — the single deep module that owns "pick the next anchor".
// ---------------------------------------------------------------------------
//
// ADR-0016. This replaces the retired `selectAnchor()` priority waterfall.
// The live concept is a *Candidate Feed*: ranked, scored data the decision
// brain (`decide.py`) reads at `GET /api/anchor/candidates`. It is DATA, not
// a decision — retry / escalation / abandonment policy belongs to decide.py
// per ADR-0012, not to this module.
//
// One interface — `getCandidateFeed(opts, deps?)` — owns all three concerns
// that used to be scattered across the 20-file anchor-selection family and a
// parallel re-implementation in `api/anchor.ts`:
//
//   1. Enumeration — the only two lanes with live writers:
//        - backlog kanban (`loadBacklog`)  — inProgress ∪ queued ∪ backlog
//        - work-queue     (`getWorkQueueItems`)
//      The retired reframe / prior-failure / abandonment lanes are gone
//      (ADR-0016: they were never written in production).
//
//   2. Scoring — tier base + freshness penalty + recent-reflection penalty +
//      blocker-just-cleared bonus, clamped to [0,1]. The abandonment penalty
//      is DROPPED (dead lane). The `PriorityTier` union is the two live
//      values only: `kanban-queued`, `work-queue`.
//
//   3. Eligibility — in-flight-PR 30-min suppression, merged-by-cycle
//      suppression (issue #882), blocker-just-cleared detection,
//      design-concept annotation, and the research_recommended threshold.
//
// The route over this module (`src/api/anchor.ts`) is thin: parse query →
// `getCandidateFeed` → add `generated_at` → `res.json`.
//
// `deps` is injectable so the feed is the test surface: stub `loadBacklog`,
// `getWorkQueueItems`, reflection lookups, the design-concept reader, and the
// clock to exercise enumeration + scoring + eligibility end-to-end without a
// Redis fixture.

import { getWorkQueueItems, removeWorkQueueItem, isTerminalMarker } from "./redis/work-queue.ts";
import { loadBacklog } from "./backlog/reads.ts";
import { loadAnchorReflectionsRaw } from "./reflections/per-anchor.ts";
import {
  getDesignConcept,
  type DesignConcept,
} from "./design-concept.ts";
// Gate predicate + freshness helper now live in their domain home (issue #1908);
// the persistence module above no longer owns them.
import {
  gateCheck,
  isFresh as isDesignConceptFresh,
} from "./design-concept-gate.ts";
// MergedAnchorRefs — shared merged-by-cycle suppression Seam (issue #1880,
// extracted from this module). The Candidate Feed below imports the suppression
// predicate (`isMergedWork`) + production loader (`loadMergedAnchorRefsImpl`);
// the canonical definitions live in `src/backlog/merged-refs.ts`, this module
// is one consumer.
import {
  isMergedWork,
  loadMergedAnchorRefsImpl,
} from "./backlog/merged-refs.ts";

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

const RESEARCH_THRESHOLD = 0.5; // top score below this → recommend research
const FRESHNESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const RECENT_REFLECTION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const FRESHNESS_PENALTY = 0.15;
const REFLECTION_PENALTY = 0.20;
const BLOCKER_CLEARED_BONUS = 0.15;
const RECENT_UNBLOCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// In-flight PR freshness window (issue #640). When an inProgress backlog item
// carries a `claimedBy = "pr-<number>"` marker claimed within this window, the
// candidate is hidden from the feed by default so decide.py doesn't re-dispatch
// onto an anchor whose PR is still awaiting CI + merge. 30 min covers the
// typical CI + operator-merge window while still surfacing genuinely stuck
// items (a PR left open overnight resurfaces the next day, ready to retry).
const IN_FLIGHT_PR_FRESHNESS_MS = 30 * 60 * 1000; // 30 min

// Merged-by-cycle suppression (issue #882) is the Candidate Feed's second
// eligibility filter: a claude dev-cycle that merges its work leaves NO
// lingering open PR, so the in-flight window above can't hide it. The merged-PR
// scan, its TTL cache, and the identity-token algebra (`isMergedWork`,
// `loadMergedAnchorRefsImpl`) now live in the shared `src/backlog/merged-refs.ts`
// Seam (issue #1880) — imported above. This module is one consumer; the
// Work-Queue Hygiene reconciler (`src/backlog/work-queue-hygiene.ts`, issue
// #1844) is the other.

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

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

// ---------------------------------------------------------------------------
// Per-candidate design-concept annotation (issue #628).
// ---------------------------------------------------------------------------

/**
 * Design-concept annotation surfaced per candidate. decide.py's
 * `design_concept_orch` selector consumes this block:
 *   - present  — artifact exists in `hydra:design-concept:{anchorRef}`
 *   - isFresh  — within DESIGN_CONCEPT_MAX_AGE_MS of createdAt
 *   - status   — `draft` | `approved` | `stale` | null (when absent)
 *   - gateOk   — `gateCheck(d, now).ok`
 */
export interface CandidateDesignConcept {
  present: boolean;
  isFresh: boolean;
  status: "draft" | "approved" | "stale" | null;
  gateOk: boolean;
}

// ---------------------------------------------------------------------------
// Public result shapes.
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  issue: string | number;
  title: string;
  score: number;
  priority_tier: PriorityTier;
  reasons: string[];
  last_updated: string | null;
  /** Anchor reference used for Redis lookups — surfaced so decide.py can
   *  stamp the dispatch with the canonical key. */
  anchorRef: string;
  designConcept: CandidateDesignConcept;
}

export interface CandidateFeed {
  candidates: ScoredCandidate[];
  research_recommended: boolean;
  total_evaluated: number;
  in_flight_suppressed: number;
  /**
   * Count of candidates suppressed because their work already MERGED with no
   * lingering open PR (issue #882). Parallel to `in_flight_suppressed`, which
   * only covers anchors with a fresh open-PR claim.
   */
  merged_suppressed: number;
}

export interface GetCandidateFeedOpts {
  /** Max candidates returned (1..MAX_LIMIT). Defaults to DEFAULT_LIMIT. */
  limit?: number;
  /** Suppress inProgress items with a fresh `pr-<n>` claim. Defaults to true. */
  excludeInFlight?: boolean;
  /**
   * Suppress candidates whose work already MERGED with no open PR (issue #882).
   * Defaults to true. Callers that need the raw view pass excludeMerged=false.
   */
  excludeMerged?: boolean;
  /** Override of "now" for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Injectable dependencies — the test surface. Stub any subset; the rest fall
 * back to the production adapters. A failing reflection / design-concept read
 * degrades that one field; it never drops a candidate (ADR-0016 invariant).
 */
export interface CandidateFeedDeps {
  loadBacklog: () => Promise<Record<string, any[]>>;
  getWorkQueueItems: () => Promise<string[]>;
  loadLastReflectionAt: (anchorRef: string) => Promise<string | null>;
  loadDesignConcept: (anchorRef: string, now: number) => Promise<CandidateDesignConcept>;
  /**
   * Return the set of normalized identifiers for work that already MERGED
   * within the lookback window, with no lingering open PR (issue #882). Each
   * entry is a normalized token a candidate identity can match against:
   * issue numbers (`"882"`), item references (`"item-322"`), and normalized
   * PR titles. Must never throw — an unreachable VCS/`gh` degrades to an empty
   * set (suppress nothing) so the feed keeps serving.
   */
  loadMergedAnchorRefs: () => Promise<Set<string>>;
  /**
   * Remove a work-queue entry by its exact raw value (issue #1690). Called by
   * the feed when a work-queue candidate is suppressed as merged work, so a
   * stale entry is REMOVED rather than merely hidden — pre-#1690 the entry
   * lingered in `hydra:anchors:work-queue` and burned dev_target dispatches on
   * no-op verify+LREM. A failing remove degrades to the old suppress-only
   * behaviour (logged, never dropped from the suppression count).
   */
  removeWorkQueueItem: (raw: string) => Promise<number>;
}

// ---------------------------------------------------------------------------
// Internal enumeration shape.
// ---------------------------------------------------------------------------

interface CandidateBase {
  issue: string | number;
  title: string;
  priority_tier: PriorityTier;
  last_updated: string | null;
  anchorRef: string;
  extras?: Record<string, any>;
  blockerJustCleared?: boolean;
}

const ABSENT_DESIGN_CONCEPT: CandidateDesignConcept = {
  present: false,
  isFresh: false,
  status: null,
  gateOk: false,
};

/**
 * Production reflection reader. Returns the most recent reflection timestamp
 * for an anchor reference, or null. Never throws.
 */
async function loadLastReflectionAtImpl(anchorRef: string): Promise<string | null> {
  try {
    const reflections = await loadAnchorReflectionsRaw(anchorRef);
    if (reflections.length === 0) return null;
    // Reflections are stored oldest-first; the last entry is most recent.
    const latest = reflections[reflections.length - 1];
    return latest.timestamp || null;
  } catch (err: any) {
    console.error(`[CandidateFeed] reflection load failed for "${anchorRef.slice(0, 60)}": ${err.message}`);
    return null;
  }
}

/**
 * Production design-concept reader + projection. Always returns a fully
 * populated block (even when no artifact exists). On any Redis failure returns
 * the "no artifact" projection rather than throwing — a failing annotation
 * must NEVER drop a candidate from the feed.
 */
async function loadDesignConceptImpl(
  anchorRef: string,
  now: number,
): Promise<CandidateDesignConcept> {
  if (!anchorRef) return ABSENT_DESIGN_CONCEPT;
  try {
    const dc: DesignConcept | null = await getDesignConcept(anchorRef);
    if (!dc) return ABSENT_DESIGN_CONCEPT;
    const fresh = isDesignConceptFresh(dc, now);
    const gate = gateCheck(dc, now);
    return {
      present: true,
      isFresh: fresh,
      // `stale` is a derived label: artifact exists but aged out of freshness.
      status: fresh ? dc.status : "stale",
      gateOk: gate.ok,
    };
  } catch (err: any) {
    console.error(
      `[CandidateFeed] design-concept load failed for "${anchorRef.slice(0, 60)}": ${err.message}`,
    );
    return ABSENT_DESIGN_CONCEPT;
  }
}

function resolveDeps(deps?: Partial<CandidateFeedDeps>): CandidateFeedDeps {
  return {
    loadBacklog: deps?.loadBacklog ?? loadBacklog,
    getWorkQueueItems: deps?.getWorkQueueItems ?? getWorkQueueItems,
    loadLastReflectionAt: deps?.loadLastReflectionAt ?? loadLastReflectionAtImpl,
    loadDesignConcept: deps?.loadDesignConcept ?? loadDesignConceptImpl,
    loadMergedAnchorRefs: deps?.loadMergedAnchorRefs ?? (() => loadMergedAnchorRefsImpl()),
    removeWorkQueueItem: deps?.removeWorkQueueItem ?? removeWorkQueueItem,
  };
}

// ---------------------------------------------------------------------------
// Eligibility helpers.
// ---------------------------------------------------------------------------

/**
 * Detect an in-flight PR claim on a backlog item (issue #640). The convention:
 * when a code-writing skill opens a PR for a kanban anchor it marks the item
 * `claimedBy = "pr-<number>"` so the next decide.py tick doesn't re-dispatch.
 * "Fresh" is bounded by IN_FLIGHT_PR_FRESHNESS_MS so a long-open PR eventually
 * resurfaces.
 */
function isInFlightPR(item: any, now: number): boolean {
  if (!item?.claimedBy) return false;
  if (typeof item.claimedBy !== "string") return false;
  if (!item.claimedBy.startsWith("pr-")) return false;
  if (!item.claimedAt) return false;
  const claimedAt = new Date(item.claimedAt).getTime();
  if (!Number.isFinite(claimedAt)) return false;
  return (now - claimedAt) < IN_FLIGHT_PR_FRESHNESS_MS;
}

/**
 * Detect a recently-cleared blocker: meta still carries a `blockedReason`
 * (it WAS blocked) but the current lane is no longer "blocked", AND the most
 * recent lane transition (movedAt) is within the last 24h.
 */
function isBlockerJustCleared(item: any, now: number): boolean {
  if (!item?.meta?.blockedReason) return false;
  if (item.lane === "blocked") return false;
  if (!item.movedAt) return false;
  const movedAt = new Date(item.movedAt).getTime();
  if (!Number.isFinite(movedAt)) return false;
  return (now - movedAt) < RECENT_UNBLOCK_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// The feed.
// ---------------------------------------------------------------------------

/**
 * Build the Candidate Feed: enumerate the two live lanes, score each candidate,
 * annotate with the design-concept block, sort by score desc (tiebreak by
 * freshness), slice to `limit`, and compute `research_recommended`.
 *
 * Never throws — enumeration failures on a single lane are logged and that lane
 * contributes nothing, the rest of the feed still builds.
 */
export async function getCandidateFeed(
  opts: GetCandidateFeedOpts = {},
  deps?: Partial<CandidateFeedDeps>,
): Promise<CandidateFeed> {
  const d = resolveDeps(deps);
  const now = opts.now ?? Date.now();
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0
    ? Math.min(opts.limit as number, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const excludeInFlight = opts.excludeInFlight !== false; // defaults to true
  const excludeMerged = opts.excludeMerged !== false; // defaults to true

  // Load the merged-work token set once up front (issue #882). A failing /
  // unreachable reader degrades to an empty set — suppress nothing, exactly the
  // pre-#882 behaviour — and never aborts the feed.
  let mergedRefs: Set<string> = new Set();
  if (excludeMerged) {
    try {
      mergedRefs = await d.loadMergedAnchorRefs();
    } catch (err: any) {
      console.error(`[CandidateFeed] merged-refs load failed: ${err.message}`);
      mergedRefs = new Set();
    }
  }

  const candidates: CandidateBase[] = [];
  let inFlightSuppressed = 0;
  let mergedSuppressed = 0;

  // -------------------------------------------------------------------------
  // Lane 1: Kanban backlog/queued/inProgress lanes.
  // -------------------------------------------------------------------------
  try {
    const lanes = await d.loadBacklog();
    const kanbanLanes: Array<[string, PriorityTier]> = [
      // inProgress items first — most recently claimed, still valid if released.
      ["inProgress", "kanban-queued"],
      ["queued", "kanban-queued"],
      ["backlog", "kanban-queued"],
    ];
    for (const [lane, tier] of kanbanLanes) {
      const items = (lanes as any)[lane] || [];
      for (const item of items) {
        if (excludeInFlight && isInFlightPR(item, now)) {
          inFlightSuppressed++;
          continue;
        }
        if (
          excludeMerged &&
          isMergedWork(
            { issue: item.id, title: item.title ?? "", anchorRef: item.title ?? "" },
            mergedRefs,
          )
        ) {
          mergedSuppressed++;
          continue;
        }
        candidates.push({
          issue: item.id,
          title: item.title,
          priority_tier: tier,
          last_updated: item.movedAt || item.meta?.addedAt || null,
          anchorRef: item.title,
          blockerJustCleared: isBlockerJustCleared(item, now),
          extras: { lane, priority: item.priority ?? 0 },
        });
      }
    }
  } catch (err: any) {
    console.error(`[CandidateFeed] Kanban enumeration failed: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Lane 2: Work queue (POST /queue or research auto-queue).
  // -------------------------------------------------------------------------
  try {
    const raw = await d.getWorkQueueItems();
    for (const r of raw) {
      let item: any;
      try { item = JSON.parse(r); } catch { /* intentional: skip corrupt work-queue entry */ continue; }
      const ref = item.reference || item.description;
      if (!ref) continue;
      // Terminal-state markers (COMPLETED:/CLOSED:) are completion notes, not
      // work (issue #1853). The write-side `pushToWorkQueue` now refuses them,
      // but an entry written before that fix (or via another path) still
      // lingers — skip it as a candidate AND reap it so it stops resurfacing.
      // Independent of `excludeMerged`: a terminal marker is never actionable.
      if (isTerminalMarker(ref)) {
        try {
          await d.removeWorkQueueItem(r);
          console.log(`[CandidateFeed] Reaped terminal-marker work-queue entry: "${ref.slice(0, 80)}"`);
        } catch (err: any) {
          console.error(`[CandidateFeed] terminal-marker reap failed for "${ref.slice(0, 60)}": ${err.message}`);
        }
        continue;
      }
      if (
        excludeMerged &&
        isMergedWork({ issue: ref, title: ref, anchorRef: ref }, mergedRefs)
      ) {
        mergedSuppressed++;
        // Self-heal (issue #1690): a merged-suppressed work-queue entry is
        // permanently stale — REMOVE it so it stops resurfacing (and burning
        // dev_target dispatches) instead of being re-suppressed every poll.
        // A failing remove degrades to the pre-#1690 suppress-only behaviour.
        try {
          await d.removeWorkQueueItem(r);
          console.log(`[CandidateFeed] Reaped merged work-queue entry: "${ref.slice(0, 80)}"`);
        } catch (err: any) {
          console.error(`[CandidateFeed] work-queue reap failed for "${ref.slice(0, 60)}": ${err.message}`);
        }
        continue;
      }
      candidates.push({
        issue: ref,
        title: ref,
        priority_tier: "work-queue",
        last_updated: item.queuedAt || null,
        anchorRef: ref,
        extras: { source: item.source || "operator", reason: item.reason },
      });
    }
  } catch (err: any) {
    console.error(`[CandidateFeed] Work queue enumeration failed: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Score + annotate each candidate.
  // -------------------------------------------------------------------------
  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    // A failing annotation degrades that one field — it must NEVER drop a
    // candidate (ADR-0016 invariant). The production readers already catch
    // internally; wrapping here also shields against an injected dep that
    // throws, so the feed seam keeps the invariant regardless of the dep.
    let lastReflectionAt: string | null = null;
    try {
      lastReflectionAt = await d.loadLastReflectionAt(c.anchorRef);
    } catch (err: any) {
      console.error(`[CandidateFeed] reflection annotation failed for "${c.anchorRef.slice(0, 60)}": ${err.message}`);
    }
    let designConcept: CandidateDesignConcept = ABSENT_DESIGN_CONCEPT;
    try {
      designConcept = await d.loadDesignConcept(c.anchorRef, now);
    } catch (err: any) {
      console.error(`[CandidateFeed] design-concept annotation failed for "${c.anchorRef.slice(0, 60)}": ${err.message}`);
    }

    const { score, reasons } = scoreCandidate({
      priorityTier: c.priority_tier,
      lastUpdated: c.last_updated,
      lastReflectionAt,
      blockerJustCleared: c.blockerJustCleared,
      now,
    });

    // Surface extras alongside structured reasons for operator visibility.
    if (c.extras) {
      for (const [k, v] of Object.entries(c.extras)) {
        if (v !== undefined && v !== null && v !== "") {
          reasons.push(`${k}:${String(v).slice(0, 40)}`);
        }
      }
    }

    scored.push({
      issue: c.issue,
      title: c.title,
      score: Math.round(score * 1000) / 1000,
      priority_tier: c.priority_tier,
      reasons,
      last_updated: c.last_updated,
      anchorRef: c.anchorRef,
      designConcept,
    });
  }

  // Sort by score desc, tiebreak by last_updated desc (fresher first).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.last_updated ? new Date(a.last_updated).getTime() : 0;
    const bt = b.last_updated ? new Date(b.last_updated).getTime() : 0;
    return bt - at;
  });

  const top = scored.slice(0, limit);
  const research_recommended = top.length === 0 || top[0].score < RESEARCH_THRESHOLD;

  return {
    candidates: top,
    research_recommended,
    total_evaluated: scored.length,
    in_flight_suppressed: inFlightSuppressed,
    merged_suppressed: mergedSuppressed,
  };
}
