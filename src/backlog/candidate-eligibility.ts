// ---------------------------------------------------------------------------
// Candidate Eligibility — the pure private-predicate half of the Candidate Feed.
// ---------------------------------------------------------------------------
//
// Extracted from `src/anchor-candidates.ts` (issue #2066), mirroring the
// `src/backlog/candidate-scoring.ts` (#2040), `src/backlog/merged-refs.ts`
// (#1880), and `src/backlog/work-queue-hygiene.ts` (#1844) extractions that
// pulled co-located concerns out of the same file.
//
// This module owns the two genuinely-PRIVATE eligibility predicates that lived
// inside `getCandidateFeed`:
//
//   - `isInFlightPR(item, now)`        — the 30-min in-flight-PR freshness window
//                                        (issue #640): hide a kanban anchor whose
//                                        `pr-<n>` claim is still fresh so decide.py
//                                        doesn't re-dispatch onto an awaiting-CI PR.
//   - `isBlockerJustCleared(item, now)` — the 24h recent-unblock detection: a
//                                        dependency that just cleared deserves an
//                                        upscore.
//   - `requiresSpawnCapableDispatch(item)` — the inline-buildability gate (issue
//                                        #2075): an anchor flagged
//                                        `dispatch-spawn-capable` exceeds the
//                                        inline-mode >5-file complexity cap and is
//                                        only completable by a spawn-capable
//                                        dispatch, so the feed must hide it from
//                                        inline (non-spawn) sessions.
//   - `requiresNonPrDispatch(item)`    — the PR-deliverability gate (issue
//                                        #2282): an anchor whose artifact lives
//                                        in host-local systemd config, behind an
//                                        operator-gated secret/approval, or
//                                        requires live-data / prod-DB verification
//                                        is NOT deliverable by ANY code-writing
//                                        PR — every pickup is a guaranteed wasted
//                                        cycle (ground → analyse → release). The
//                                        feed (and the atomic-claim path) must
//                                        skip it for every caller, routing it to
//                                        the operator/deploy path instead.
//
// Both are PURE and deterministic given an injected `now` — no Redis, no I/O.
// They read fields off the candidate item and compare against `now`, exactly as
// `scoreCandidate(signals)` consumes `signals.now`. That keeps a pinned-clock
// test surface that needs no Redis fixture.
//
// ADR-0016 Locality: the eligibility POLICY — the IN_FLIGHT_PR_FRESHNESS_MS and
// RECENT_UNBLOCK_THRESHOLD_MS windows plus the predicate logic — gets exactly
// ONE home here and is never duplicated back into anchor-candidates.ts. The feed
// module imports these (and re-exports them so the Candidate Feed public surface
// is unchanged).
//
// NOT re-homed here (they already have canonical homes; the feed CONSUMES them):
//   - `isMergedWork`     — `src/backlog/merged-refs.ts` (#1880)
//   - `isTerminalMarker` — `src/redis/work-queue.ts`
// The issue's "merged-work suppression call-site" and "terminal-marker reap
// path" name the INVOCATION sites inside getCandidateFeed, not the predicates —
// those invocations (and their degrade-on-failure reap side-effects) stay in the
// feed as part of the enumeration loop it owns.

import type { BacklogItemLike } from "./types.ts";
// Shipped-subject suppression (issue #3208, extracted here by #3211). REUSES the
// asymmetric `subjectCoveredBy` matcher from its single home (`merged-refs.ts`
// re-exports it from `token-algebra.ts`) — never a bespoke matcher (ADR-0016
// Locality). The `MergedRef` blob feed type comes from `target-pr-feed.ts`.
import { subjectCoveredBy } from "./merged-refs.ts";
import type { MergedRef } from "./target-pr-feed.ts";

// ---------------------------------------------------------------------------
// Eligibility policy — the freshness windows.
// ---------------------------------------------------------------------------

/**
 * Recent-unblock window. A `blockerJustCleared` candidate is one whose lane is
 * no longer "blocked" but whose most recent lane transition (movedAt) is within
 * this window — a dependency that just cleared deserves attention.
 */
export const RECENT_UNBLOCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * In-flight PR freshness window (issue #640). When an inProgress backlog item
 * carries a `claimedBy = "pr-<number>"` marker claimed within this window, the
 * candidate is hidden from the feed by default so decide.py doesn't re-dispatch
 * onto an anchor whose PR is still awaiting CI + merge. 30 min covers the
 * typical CI + operator-merge window while still surfacing genuinely stuck
 * items (a PR left open overnight resurfaces the next day, ready to retry).
 */
export const IN_FLIGHT_PR_FRESHNESS_MS = 30 * 60 * 1000; // 30 min

// ---------------------------------------------------------------------------
// Eligibility predicates — pure, given an injected `now`.
// ---------------------------------------------------------------------------

/**
 * Detect an in-flight PR claim on a backlog item (issue #640). The convention:
 * when a code-writing skill opens a PR for a kanban anchor it marks the item
 * `claimedBy = "pr-<number>"` so the next decide.py tick doesn't re-dispatch.
 * "Fresh" is bounded by IN_FLIGHT_PR_FRESHNESS_MS so a long-open PR eventually
 * resurfaces.
 */
export function isInFlightPR(item: BacklogItemLike, now: number): boolean {
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
export function isBlockerJustCleared(item: BacklogItemLike, now: number): boolean {
  if (!item?.meta?.blockedReason) return false;
  if (item.lane === "blocked") return false;
  if (!item.movedAt) return false;
  const movedAt = new Date(item.movedAt).getTime();
  if (!Number.isFinite(movedAt)) return false;
  return (now - movedAt) < RECENT_UNBLOCK_THRESHOLD_MS;
}

/**
 * Detect that an anchor requires a **spawn-capable** dispatch and therefore is
 * NOT inline-buildable (issue #2075). An inline-mode session (no agent-spawn
 * tool, per the #1782 contract) is structurally capped at ~5 changed files; an
 * anchor that is a large atomic contract migration (e.g. the 13-file
 * `openAiCredentialReadiness` rename) cannot be completed inline — the inline
 * session grounds, attempts, reverts, and re-queues, burning the dispatch and
 * leaving the anchor to trip the next inline session identically. Flagging such
 * an anchor `dispatch-spawn-capable` lets the Candidate Feed hide it from
 * inline-mode callers so the work-queue stops re-serving it.
 *
 * Pure and side-effect-free: reads a boolean signal off the candidate item.
 * The flag is accepted in any of three carrier shapes so producers across the
 * two live lanes (free-form work-queue JSON, kanban-item meta) can stamp it
 * without a schema change:
 *   - a top-level `dispatchSpawnCapable: true` (work-queue JSON entries)
 *   - a `meta.dispatchSpawnCapable: true` (kanban backlog items carry `meta`)
 *   - a `dispatch-spawn-capable` entry in a `labels` array (the GitHub-issue
 *     label form the friction note records, mirrored onto the candidate)
 * Any non-true / absent value degrades to `false` (inline-buildable) so an
 * un-flagged anchor is never hidden — this gate only ever SUBTRACTS the
 * known-too-complex anchors, never the default population.
 */
export function requiresSpawnCapableDispatch(item: BacklogItemLike): boolean {
  if (!item || typeof item !== "object") return false;
  if (item.dispatchSpawnCapable === true) return true;
  if (item.meta && typeof item.meta === "object" && item.meta.dispatchSpawnCapable === true) {
    return true;
  }
  const labels = item.labels;
  if (Array.isArray(labels) && labels.some((l: any) => l === "dispatch-spawn-capable")) {
    return true;
  }
  return false;
}

/**
 * The canonical label set marking an anchor as **not deliverable by any PR**
 * (issue #2282). Each names a class of artifact a code-writing worktree
 * structurally cannot produce:
 *   - `non-pr-deliverable`   — the generic catch-all class.
 *   - `host-systemd`         — the artifact is a host-local systemd unit edit
 *                              (`~/.config/systemd/user/*.service`) not tracked
 *                              in the repo (item-559, item-509).
 *   - `operator-gated`       — gated on an operator-supplied secret / money-
 *                              critical approval no PR can satisfy (item-555:
 *                              `BALLDONTLIE_API_KEY` + host `systemctl`).
 *   - `live-data`            — completion requires live fixtures / prod-DB
 *                              assertions no worktree can run (item-523).
 * A producer (retro, planner) stamps ANY of these to route the anchor away from
 * the code-writing feed. Membership is exact-string; an unknown label never
 * trips the gate (it only ever subtracts the known-undeliverable population).
 */
export const NON_PR_DELIVERABLE_LABELS: readonly string[] = [
  "non-pr-deliverable",
  "host-systemd",
  "operator-gated",
  "live-data",
];

/**
 * Detect that an anchor is **not deliverable by any code-writing PR** (issue
 * #2282) and therefore must be skipped by the Target candidate feed AND the
 * atomic-claim path — not merely re-routed to a different dispatch class.
 *
 * This is the Target-side sibling of `requiresSpawnCapableDispatch` (#2075), but
 * with a stronger consequence: a spawn-capable anchor IS buildable (by a
 * spawn-capable dispatch), so #2075 only hides it from INLINE callers; a
 * non-PR-deliverable anchor is buildable by NO dispatch at all — its artifact
 * lives in host-local systemd config, behind an operator-gated secret/approval,
 * or requires live-data / prod-DB verification. Serving it to a code-writing
 * dispatch burns a guaranteed grounding+analysis+release cycle every time, so
 * the gate suppresses it for EVERY caller (the sessions already perform this
 * release-and-rescan by hand — this makes it declarative). The operator/deploy
 * path remains the correct home for the work; this only keeps it off the
 * code-writing feed.
 *
 * Pure and side-effect-free. The flag is accepted in the same three carrier
 * shapes as `requiresSpawnCapableDispatch` so producers across both live lanes
 * (free-form work-queue JSON, kanban-item meta, GitHub-issue labels) can stamp
 * it without a schema change:
 *   - a top-level `nonPrDeliverable: true` (work-queue JSON entries)
 *   - a `meta.nonPrDeliverable: true` (kanban backlog items carry `meta`)
 *   - any `NON_PR_DELIVERABLE_LABELS` entry in a `labels` array (the GitHub-issue
 *     label form, mirrored onto the candidate)
 * Any non-true / absent value degrades to `false` (deliverable) so an un-flagged
 * anchor is never hidden — this gate only ever SUBTRACTS the known-undeliverable
 * anchors, never the default population.
 */
export function requiresNonPrDispatch(item: BacklogItemLike): boolean {
  if (!item || typeof item !== "object") return false;
  if (item.nonPrDeliverable === true) return true;
  if (item.meta && typeof item.meta === "object" && item.meta.nonPrDeliverable === true) {
    return true;
  }
  const labels = item.labels;
  if (
    Array.isArray(labels) &&
    labels.some((l: any) => typeof l === "string" && NON_PR_DELIVERABLE_LABELS.includes(l))
  ) {
    return true;
  }
  return false;
}

/**
 * Positive-evidence-only shipped-subject test (issue #3208; extracted from the
 * inline `getCandidateFeed` closure by #3211). A candidate is suppressed only
 * when a CONCRETE merged PR/commit blob COVERS its title at >=0.70 asymmetric
 * containment with >=4 significant words (the SUBJECT_MATCH_MIN_WORDS guard
 * inside `subjectCoveredBy`, so short/generic titles can never spuriously evict
 * live work). An empty `mergedBlobs` feed short-circuits to `false` — suppress
 * nothing (the #2110 92%-false-positive polarity: absence of a covering blob is
 * NEVER proof a candidate shipped). Never throws.
 *
 * Pure: `mergedBlobs` is passed as a PARAMETER (not closed over) so the
 * predicate is unit-testable without a full `getCandidateFeed` fixture, matching
 * the injectable-deps shape of its four sibling predicates. `subjectCoveredBy`
 * keeps exactly one home (`token-algebra.ts`, re-exported via `merged-refs.ts`);
 * this predicate imports it, never re-implements it (ADR-0016 Locality).
 */
export function isShippedSubject(title: string, mergedBlobs: MergedRef[]): boolean {
  if (mergedBlobs.length === 0) return false;
  const t = typeof title === "string" ? title : "";
  if (!t) return false;
  return mergedBlobs.some((r) => subjectCoveredBy(t, r.blob));
}
