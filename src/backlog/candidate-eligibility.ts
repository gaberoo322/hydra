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
export function isInFlightPR(item: any, now: number): boolean {
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
export function isBlockerJustCleared(item: any, now: number): boolean {
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
export function requiresSpawnCapableDispatch(item: any): boolean {
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
