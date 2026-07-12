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
//      values only: `kanban-queued`, `work-queue`. The pure scoring ARITHMETIC
//      (tier ladder, penalty/bonus weights, clamp) lives in its own sibling
//      Module `src/backlog/candidate-scoring.ts` (issue #2040); this module
//      imports `scoreCandidate` from there. The split keeps
//      pure arithmetic out of the stateful guards below while preserving
//      ADR-0016 Locality (scoring has exactly one home).
//
//   3. Eligibility — in-flight-PR 30-min suppression, merged-by-cycle
//      suppression (issue #882), shipped-subject suppression (issue #3208),
//      blocker-just-cleared detection, design-concept annotation, and the
//      research_recommended threshold.
//
// This is a PURE read-and-score path: it performs ZERO Redis writes (issue
// #2187). Stale work-queue entries (merged-work + terminal-markers) are
// SUPPRESSED here on every poll, but their Redis GC is owned by the hourly
// Work-Queue Hygiene reconciler (`src/backlog/work-queue-hygiene.ts`), never by
// this feed — so a read-heavy caller never inherits a write side-effect.
//
// The route over this module (`src/api/anchor.ts`) is thin: parse query →
// `getCandidateFeed` → add `generated_at` → `res.json`.
//
// `deps` is injectable so the feed is the test surface: stub `loadBacklog`,
// `getWorkQueueItems`, reflection lookups, the design-concept reader, and the
// clock to exercise enumeration + scoring + eligibility end-to-end without a
// Redis fixture.

import { getWorkQueueItems, isTerminalMarker } from "./redis/work-queue.ts";
import { loadBacklog } from "./backlog/reads.ts";
import type { BacklogItem, BacklogItemLike } from "./backlog/types.ts";

/**
 * A parsed work-queue JSON entry (POST /queue or research auto-queue). Distinct
 * from a Kanban BacklogItem — it carries `reference`/`queuedAt`/`reason` — but it
 * extends BacklogItemLike so the shared eligibility predicates
 * (requiresSpawnCapableDispatch / requiresNonPrDispatch) accept it directly.
 */
interface WorkQueueEntry extends BacklogItemLike {
  reference?: string;
  description?: string;
  queuedAt?: string;
  source?: string;
  reason?: string;
}
import { time } from "./metrics/instrumentation.ts";
import { loadAnchorReflectionsRaw } from "./reflections/per-anchor.ts";
// Design-concept annotation policy — the `CandidateDesignConcept` type, its
// ABSENT_DESIGN_CONCEPT projection, and the production assembler
// (`loadDesignConceptImpl`) now live in their own sibling Module
// (`src/backlog/candidate-design-concept.ts`, issue #2499), mirroring the #2040
// (candidate-scoring), #2066 (candidate-eligibility), #1880 (merged-refs), and
// #1844 (work-queue-hygiene) extractions from this same file. `getCandidateFeed`
// imports the assembler + type; consumers import the type directly from the
// canonical home (the back-compat re-exports were retired in issue #2077).
import {
  type CandidateDesignConcept,
  ABSENT_DESIGN_CONCEPT,
  loadDesignConceptImpl,
} from "./backlog/candidate-design-concept.ts";
// MergedAnchorRefs — shared merged-by-cycle suppression Seam (issue #1880,
// extracted from this module). The Candidate Feed below imports the suppression
// predicate (`isMergedWork`) + production loader (`loadMergedAnchorRefsImpl`);
// the canonical definitions live in `src/backlog/merged-refs.ts`, this module
// is one consumer.
import {
  isMergedWork,
  loadMergedAnchorRefsImpl,
} from "./backlog/merged-refs.ts";
// Shipped-subject suppression (issue #3208). The exact-token `isMergedWork`
// gate above misses a phantom whose code shipped under a DIFFERENTLY-TITLED PR
// that never cites the kanban item id (item-764/767 shipped by #435/#433) — no
// identity token intersects. The proven fix (#2110/#2482) is the ASYMMETRIC
// `subjectCoveredBy` matcher (>=0.70 containment, >=4 significant words) run
// against the merged PR/commit BLOB feed (`MergedRef.blob`), already load-bearing
// in `work-queue-hygiene.ts` (reconcileWorkQueue) and `stale-escalation.ts`. This
// module REUSES those seams — `subjectCoveredBy` from `merged-refs.ts` and the
// `MergedRef` blob feeds from `target-pr-feed.ts` — never a bespoke matcher
// (ADR-0016 Locality: do not duplicate the matching policy).
import {
  type MergedRef,
  fetchMergedRefsImpl,
} from "./backlog/target-pr-feed.ts";
// Scoring policy — the pure tier-ladder + penalty/bonus arithmetic — now lives
// in its own sibling Module (`src/backlog/candidate-scoring.ts`, issue #2040),
// mirroring the #1880 (merged-refs) and #1844 (work-queue-hygiene) extractions
// from this same file. `getCandidateFeed` (enumeration + the three stateful
// eligibility guards) stays here and imports the scorer; consumers import the
// scoring symbols directly from the canonical home (the back-compat re-exports
// were retired in issue #2077).
import {
  scoreCandidate,
  type PriorityTier,
} from "./backlog/candidate-scoring.ts";
// Eligibility predicates — the two genuinely-private predicates (`isInFlightPR`,
// `isBlockerJustCleared`) and their freshness-window policy now live in their own
// sibling Module (`src/backlog/candidate-eligibility.ts`, issue #2066), mirroring
// the #2040 (candidate-scoring), #1880 (merged-refs), and #1844 (work-queue-hygiene)
// extractions from this same file. `getCandidateFeed` (enumeration + eligibility
// composition) stays here and imports the predicates; consumers import the
// eligibility symbols directly from the canonical home (the back-compat
// re-exports were retired in issue #2077).
import {
  isInFlightPR,
  isBlockerJustCleared,
  requiresSpawnCapableDispatch,
  requiresNonPrDispatch,
  isShippedSubject,
} from "./backlog/candidate-eligibility.ts";

// ---------------------------------------------------------------------------
// Eligibility / feed thresholds — the stateful half that stays here.
// ---------------------------------------------------------------------------

const RESEARCH_THRESHOLD = 0.5; // top score below this → recommend research

// The eligibility predicates (`isInFlightPR`, `isBlockerJustCleared`) and their
// freshness-window policy (RECENT_UNBLOCK_THRESHOLD_MS, IN_FLIGHT_PR_FRESHNESS_MS)
// now live in `src/backlog/candidate-eligibility.ts` (issue #2066) — imported
// above. This module composes them inside the enumeration loop below.

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

// The per-candidate design-concept annotation (the `CandidateDesignConcept`
// type, ABSENT_DESIGN_CONCEPT projection, and `loadDesignConceptImpl` reader,
// issue #628) now lives in `src/backlog/candidate-design-concept.ts` (issue
// #2499) — imported above. This module composes the annotation into each
// candidate inside the feed loop below.

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
  /**
   * Count of candidates suppressed because a recently-merged PR/commit SUBJECT
   * covers the candidate's title (issue #3208), even though no exact identity
   * token intersected (so `merged_suppressed` above missed it). Catches a
   * kanban/work-queue item whose code shipped under a differently-titled,
   * non-claiming PR. Positive-evidence-only: an empty/unreachable merged-blob
   * feed makes this a strict no-op (never evicts live work).
   */
  shipped_subject_suppressed: number;
  /**
   * Count of candidates suppressed because the caller is in inline mode and the
   * anchor is flagged `dispatch-spawn-capable` (not inline-buildable, issue
   * #2075). Always 0 when `inlineMode` is false (the default) — a spawn-capable
   * dispatch sees every candidate.
   */
  spawn_suppressed: number;
  /**
   * Count of candidates suppressed because the anchor is not deliverable by ANY
   * code-writing PR — host-systemd-only, operator-gated, or live-data/prod-DB
   * verification (issue #2282). Unlike `spawn_suppressed` this fires for EVERY
   * caller by default (the work is buildable by no dispatch at all); pass
   * `excludeNonPrDeliverable=false` for the raw operator view.
   */
  non_pr_deliverable_suppressed: number;
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
  /**
   * Caller runs in INLINE mode — a session with no agent-spawn tool (the #1782
   * inline contract) that is structurally capped at the >5-file complexity cap.
   * When true, the feed suppresses anchors flagged `dispatch-spawn-capable`
   * (not inline-buildable, issue #2075) so the work-queue stops re-serving a
   * large atomic contract migration to a session that can only revert + requeue
   * it. Defaults to FALSE — a spawn-capable dispatch (and the raw operator view)
   * sees every candidate, so this gate only ever subtracts for inline callers.
   */
  inlineMode?: boolean;
  /**
   * Suppress anchors that are not deliverable by ANY code-writing PR —
   * host-systemd-only, operator-gated, or live-data/prod-DB verification (issue
   * #2282). Defaults to TRUE: such an anchor burns a guaranteed grounding +
   * analysis + release cycle every time it is served to a code-writing
   * dispatch, so it is hidden from the candidate feed for every caller (NOT just
   * inline ones — unlike #2075's `inlineMode` gate, this work is buildable by no
   * dispatch at all). Callers that need the raw view pass
   * `excludeNonPrDeliverable=false`. The operator/deploy path remains the
   * correct home for the work; this only keeps it off the code-writing feed.
   */
  excludeNonPrDeliverable?: boolean;
  /** Override of "now" for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Injectable dependencies — the test surface. Stub any subset; the rest fall
 * back to the production adapters. A failing reflection / design-concept read
 * degrades that one field; it never drops a candidate (ADR-0016 invariant).
 */
export interface CandidateFeedDeps {
  // The production adapter returns full BacklogItems, but this is a test-injection
  // seam: stubs supply only the fields the feed reads, so it accepts
  // Partial<BacklogItem>. The feed loop defensively narrows every field it uses.
  loadBacklog: () => Promise<Record<string, Partial<BacklogItem>[]>>;
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
   * Merged PR/commit BLOB feed for the shipped-subject gate (issue #3208).
   * Each `MergedRef.blob` is a merged PR/commit title+body against which the
   * asymmetric `subjectCoveredBy` matcher runs. Defaults to `fetchMergedRefsImpl`
   * (the union of `fetchMergedTargetPrRefs` + `fetchTargetMergeCommitRefs` — the
   * same swap-seam target repo the `loadMergedAnchorRefs` token scan covers).
   * Fetched ONCE per feed build, before the enumeration loop, so subject matching
   * is pure in-memory. Must never throw — an unreachable feed degrades to `[]`
   * (suppress nothing), preserving the positive-evidence-only invariant.
   */
  fetchMergedRefs: () => Promise<MergedRef[]>;
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

// The production merged-blob feed reader (`fetchMergedRefsImpl`) is the shared
// seam in `src/backlog/target-pr-feed.ts` (issue #3208) — the SAME body the
// Work-Queue Hygiene reconciler uses (#2482), so the union-of-feeds matching
// policy has exactly one home (ADR-0016 Locality). Imported above and wired as
// the `fetchMergedRefs` default in `resolveDeps` below.

function resolveDeps(deps?: Partial<CandidateFeedDeps>): CandidateFeedDeps {
  return {
    loadBacklog: deps?.loadBacklog ?? loadBacklog,
    getWorkQueueItems: deps?.getWorkQueueItems ?? getWorkQueueItems,
    loadLastReflectionAt: deps?.loadLastReflectionAt ?? loadLastReflectionAtImpl,
    loadDesignConcept: deps?.loadDesignConcept ?? loadDesignConceptImpl,
    loadMergedAnchorRefs: deps?.loadMergedAnchorRefs ?? (() => loadMergedAnchorRefsImpl()),
    fetchMergedRefs: deps?.fetchMergedRefs ?? fetchMergedRefsImpl,
  };
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
  // Issue #2353: time the candidate-feed selection hot path. `time()` is a
  // transparent no-op unless HYDRA_PERF_INSTRUMENT is set, so the feed's
  // result and never-throws contract are unchanged.
  return time("anchor.getCandidateFeed", () => getCandidateFeedImpl(opts, deps));
}

async function getCandidateFeedImpl(
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
  const inlineMode = opts.inlineMode === true; // defaults to false (spawn-capable view)
  const excludeNonPrDeliverable = opts.excludeNonPrDeliverable !== false; // defaults to true

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

  // Load the merged-blob feed once up front for the shipped-subject gate (issue
  // #3208), gated on the same `excludeMerged` flag as the token set above (the
  // raw operator view opts out of BOTH). Fail-open: an unreachable/empty feed
  // yields zero shipped-subject suppressions (positive-evidence-only invariant —
  // absence of a covering blob is NEVER proof a candidate shipped, the #2110
  // 92%-false-positive polarity). `subjectCoveredBy` already no-ops on an empty
  // blob set; the empty-feed short-circuit below makes the no-op explicit.
  let mergedBlobs: MergedRef[] = [];
  if (excludeMerged) {
    try {
      mergedBlobs = await d.fetchMergedRefs();
    } catch (err: any) {
      console.error(`[CandidateFeed] merged-blob feed failed: ${err.message}`);
      mergedBlobs = [];
    }
  }

  // Positive-evidence-only shipped-subject test now lives in its canonical home,
  // `isShippedSubject(title, mergedBlobs)` in `candidate-eligibility.ts` (issue
  // #3211): a candidate is suppressed only when a CONCRETE merged PR/commit blob
  // COVERS its title at >=0.70 asymmetric containment with >=4 significant words,
  // and an empty `mergedBlobs` short-circuits to false (suppress nothing). The
  // two lane call-sites below invoke it with the resolved `mergedBlobs` array.

  const candidates: CandidateBase[] = [];
  let inFlightSuppressed = 0;
  let mergedSuppressed = 0;
  let shippedSubjectSuppressed = 0;
  let spawnSuppressed = 0;
  let nonPrDeliverableSuppressed = 0;

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
      const items: Partial<BacklogItem>[] = lanes[lane] || [];
      for (const item of items) {
        if (excludeInFlight && isInFlightPR(item, now)) {
          inFlightSuppressed++;
          continue;
        }
        // Inline-buildability gate (issue #2075): an inline-mode caller cannot
        // complete a `dispatch-spawn-capable` anchor (exceeds the >5-file cap),
        // so hide it rather than re-serve it to a session that will only revert
        // + requeue. No-op for spawn-capable callers (inlineMode false default).
        if (inlineMode && requiresSpawnCapableDispatch(item)) {
          spawnSuppressed++;
          continue;
        }
        // PR-deliverability gate (issue #2282): an anchor whose artifact is
        // host-systemd-only / operator-gated / live-data is deliverable by NO
        // code-writing dispatch, so hide it for EVERY caller (not just inline)
        // rather than burn a guaranteed ground+analyse+release cycle. It belongs
        // on the operator/deploy path; the raw operator view opts out with
        // excludeNonPrDeliverable=false.
        if (excludeNonPrDeliverable && requiresNonPrDispatch(item)) {
          nonPrDeliverableSuppressed++;
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
        // Shipped-subject gate (issue #3208): a kanban item whose code shipped
        // under a differently-titled, non-claiming PR carries NO identity token,
        // so `isMergedWork` above misses it — but a recently-merged PR/commit
        // blob still COVERS its title. Suppress on-read (the hourly reconciler
        // owns the Redis GC of the stale row; #2187 zero-writes invariant). The
        // >=4-word + >=0.70 guards keep this positive-evidence-only.
        if (excludeMerged && isShippedSubject(item.title ?? "", mergedBlobs)) {
          shippedSubjectSuppressed++;
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
      // A work-queue entry is a DIFFERENT shape from a Kanban BacklogItem: it is
      // free-form JSON carrying `reference`/`description`/`queuedAt`/`source`/
      // `reason` plus the same eligibility carrier flags. Typed as WorkQueueEntry
      // (which structurally satisfies BacklogItemLike) so the eligibility
      // predicates accept it without an `any` (issue #2588).
      let item: WorkQueueEntry;
      try { item = JSON.parse(r) as WorkQueueEntry; } catch { /* intentional: skip corrupt work-queue entry */ continue; }
      const ref = item.reference || item.description;
      if (!ref) continue;
      // Terminal-state markers (COMPLETED:/CLOSED:) are completion notes, not
      // work (issue #1853). The write-side `pushToWorkQueue` now refuses them,
      // but an entry written before that fix (or via another path) still
      // lingers — skip it as a candidate so it never surfaces. Independent of
      // `excludeMerged`: a terminal marker is never actionable. The stale Redis
      // entry is REAPED out-of-band by the hourly Work-Queue Hygiene reconciler
      // (issue #2187 moved the reap there so this read path performs zero writes).
      if (isTerminalMarker(ref)) {
        continue;
      }
      // Inline-buildability gate (issue #2075): a `dispatch-spawn-capable`
      // work-queue entry is not inline-buildable. For an inline-mode caller,
      // hide it so the work-queue stops re-serving the 13-file atomic migration
      // to a session that can only revert + requeue (the friction this fixes).
      // The entry is NOT reaped — it remains valid work for a spawn-capable
      // dispatch; it is only filtered from THIS inline caller's view.
      if (inlineMode && requiresSpawnCapableDispatch(item)) {
        spawnSuppressed++;
        continue;
      }
      // PR-deliverability gate (issue #2282): a host-systemd-only / operator-
      // gated / live-data work-queue entry is deliverable by no code-writing
      // dispatch — hide it for every caller so the work-queue stops re-serving
      // it (the friction this fixes: item-559 host-systemd, item-555 operator-
      // gated secret, item-523 live-data). It is NOT reaped here (this read path
      // performs zero writes, issue #2187); it stays visible to the raw operator
      // view (excludeNonPrDeliverable=false) and to the operator/deploy path.
      if (excludeNonPrDeliverable && requiresNonPrDispatch(item)) {
        nonPrDeliverableSuppressed++;
        continue;
      }
      if (
        excludeMerged &&
        isMergedWork({ issue: ref, title: ref, anchorRef: ref }, mergedRefs)
      ) {
        mergedSuppressed++;
        // The stale Redis entry is REAPED out-of-band by the hourly Work-Queue
        // Hygiene reconciler (`reconcileWorkQueue`, cause: "merged-work"), which
        // already scans the whole queue on its tick (issue #2187 moved the reap
        // there so this read path performs zero writes). Suppression keeps the
        // entry off every served poll regardless of when that GC catches up.
        continue;
      }
      // Shipped-subject gate (issue #3208): symmetric with the kanban lane. A
      // work-queue entry whose code shipped under a differently-titled PR that
      // never cites the entry's `reference` carries no matching token; suppress
      // it when a merged blob covers its subject. The reconciler's
      // `shipped-subject` cause (#2482) GCs the stale Redis entry out-of-band —
      // this read path stays write-free (#2187).
      if (excludeMerged && isShippedSubject(ref, mergedBlobs)) {
        shippedSubjectSuppressed++;
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
  // Operator-set priority, held off the public shape and used only as an
  // intra-lane sort tiebreak (below). Kanban items carry `extras.priority`
  // (`item.priority ?? 0`); work-queue entries carry none and read 0, so the
  // tiebreak only reorders operator-prioritized items within the same score
  // band — it can never invert the tier hierarchy (kanban 0.85 > work-queue
  // 0.70). A non-numeric priority degrades to 0 rather than poisoning the sort.
  const priorityOf = new WeakMap<ScoredCandidate, number>();
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

    const candidate: ScoredCandidate = {
      issue: c.issue,
      title: c.title,
      score: Math.round(score * 1000) / 1000,
      priority_tier: c.priority_tier,
      reasons,
      last_updated: c.last_updated,
      anchorRef: c.anchorRef,
      designConcept,
    };
    scored.push(candidate);
    const p = Number(c.extras?.priority);
    priorityOf.set(candidate, Number.isFinite(p) ? p : 0);
  }

  // Sort by score desc, then operator priority desc (intra-lane tiebreak —
  // surfaces operator-prioritized items within a score band without letting
  // priority cross the tier gap), then last_updated desc (fresher first).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = priorityOf.get(a) ?? 0;
    const bp = priorityOf.get(b) ?? 0;
    if (bp !== ap) return bp - ap;
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
    shipped_subject_suppressed: shippedSubjectSuppressed,
    spawn_suppressed: spawnSuppressed,
    non_pr_deliverable_suppressed: nonPrDeliverableSuppressed,
  };
}
