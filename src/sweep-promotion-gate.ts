/**
 * sweep-promotion-gate.ts — Open-PR divert gate for hydra-sweep's
 * ready-for-agent promotion edges (issue #772, ADR-aligned with the
 * approved design-concept artifact for #772).
 *
 * THE BUG IT FIXES
 * ----------------
 * On the 2026-05-30 orch-only autopilot run, `hydra-sweep` re-triaged issue
 * #750 to `ready-for-agent` while PR #754 (`Closes #750`) was already open
 * (parked under `ready-for-human` after going DIRTY). The autopilot then
 * dispatched a duplicate `dev_orch` build → PR #770, wasting a build cycle.
 * Several other issues (#734→#759, #751→#758, #694→#764, #695→#763,
 * #691→#765) hit the same race and were avoided only by manual steering.
 *
 * THE FIX
 * -------
 * Every sweep edge that WRITES `ready-for-agent` (needs-triage auto-triage,
 * blocked-cleared, and in-progress stale-relabel) must first ask this pure
 * predicate whether an OPEN PR already references the issue. If one does, the
 * issue is diverted into an observable, non-dispatching lane instead of being
 * promoted — so the autopilot never dispatches a duplicate build.
 *
 * DESIGN INVARIANTS (from the approved design-concept for #772)
 * -------------------------------------------------------------
 *  1. An issue is NOT promoted to ready-for-agent when an OPEN PR references
 *     it via Closes/Fixes/Resolves #<issue> (or a bare #<issue> in body/title,
 *     matching the established epic-stuck-ness query vocabulary).
 *  2. Detection is gated strictly on OPEN PRs. A closed-unmerged PR means the
 *     prior attempt was abandoned → the issue SHOULD return to ready-for-agent
 *     (exactly the #754→#770 handoff). A merged PR means the work is done.
 *     Callers pass only `--state open` PRs here.
 *  3. A diverted issue lands in an OBSERVABLE lane, never silently dropped:
 *       - PR open + mergeable        → needs-qa      (verify the existing work)
 *       - PR open + DIRTY/parked      → ready-for-human (operator unblocks)
 *       - PR open + neither/unknown   → leave out of ready-for-agent, note it
 *  4. The decision is idempotent and stateless: re-running the sweep on the
 *     same board reaches the same decision (state read live from GitHub).
 *  5. This gate does NOT modify the merge gate or the autopilot candidate
 *     feed — those remain independent defense layers.
 *
 * This module is intentionally PURE (no I/O): the caller (the hydra-sweep
 * playbook) runs the `gh pr list` query and feeds the result in. That keeps
 * the routing decision unit-testable without a markdown harness, satisfying
 * the issue's "regression test covering the issue-has-open-PR branch"
 * acceptance criterion.
 */

/**
 * The mergeability signal GitHub exposes on a PR (`gh pr view --json
 * mergeable`). We only branch on the three values that matter for routing;
 * any other/absent value falls through to the conservative "neither" lane.
 */
type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string | null | undefined;

/**
 * The shape the caller extracts from `gh pr list ... --json
 * number,body,title,mergeable,state`. `state` is included so callers that
 * pass an unfiltered list still get correct behavior (we ignore non-open PRs
 * defensively, per invariant 2).
 */
export type OpenPr = {
  number: number;
  body?: string | null;
  title?: string | null;
  /** GitHub mergeable enum; optional because not all queries fetch it. */
  mergeable?: PrMergeable;
  /** PR state; when present, only "OPEN" PRs are considered. */
  state?: string | null;
};

/** Where a diverted issue is routed, or `ready-for-agent` when promotion is allowed. */
type PromotionLane = "ready-for-agent" | "needs-qa" | "ready-for-human" | "has-open-pr";

export type PromotionDecision = {
  /** True when no open PR references the issue → normal promotion proceeds. */
  promote: boolean;
  /** The lane the caller should route the issue into. */
  targetLane: PromotionLane;
  /** The referencing open PR number that triggered a divert, if any. */
  prRef: number | null;
  /** Human-readable explanation for the sweep report. */
  reason: string;
};

/**
 * Returns true if `text` references issue `#<issueNumber>` as a whole token.
 * Matches both the closing-keyword forms (Closes/Fixes/Resolves #N) and a
 * bare `#N` mention anywhere in body/title — the same liberal vocabulary the
 * epic stuck-ness gate already uses. A trailing digit-boundary check
 * prevents `#75` from matching `#750`.
 */
export function referencesIssue(text: string | null | undefined, issueNumber: number): boolean {
  if (!text || !Number.isInteger(issueNumber) || issueNumber <= 0) return false;
  // `#<n>` not immediately followed by another digit (so #75 ≠ #750).
  const re = new RegExp(`#${issueNumber}(?![0-9])`);
  return re.test(text);
}

/**
 * Find the first OPEN PR (in `openPrs`) that references `issueNumber`.
 * Defensively ignores any PR whose `state` is present and not "OPEN", so a
 * caller that forgot to filter `--state open` still behaves correctly
 * (invariant 2). Returns null when none reference the issue.
 */
export function findReferencingOpenPr(
  issueNumber: number,
  openPrs: readonly OpenPr[] | null | undefined,
): OpenPr | null {
  if (!Array.isArray(openPrs)) return null;
  for (const pr of openPrs) {
    if (!pr || typeof pr.number !== "number") continue;
    // If state is provided, honor it; if absent, trust the caller's --state open.
    if (typeof pr.state === "string" && pr.state.toUpperCase() !== "OPEN") continue;
    const haystack = `${pr.body ?? ""} ${pr.title ?? ""}`;
    if (referencesIssue(haystack, issueNumber)) return pr;
  }
  return null;
}

/**
 * Map a referencing open PR's mergeability to the divert lane (invariant 3).
 *   MERGEABLE   → needs-qa        (the work is ready to verify)
 *   CONFLICTING → ready-for-human (DIRTY/parked; operator must unblock)
 *   else        → has-open-pr     (UNKNOWN/absent; don't dispatch, just note)
 */
function laneForMergeable(mergeable: PrMergeable): Exclude<PromotionLane, "ready-for-agent"> {
  const m = typeof mergeable === "string" ? mergeable.toUpperCase() : "";
  if (m === "MERGEABLE") return "needs-qa";
  if (m === "CONFLICTING") return "ready-for-human";
  return "has-open-pr";
}

/**
 * The shared pre-promotion gate. Call this at EVERY sweep edge that would
 * write `ready-for-agent` (needs-triage auto-triage, blocked-cleared,
 * in-progress stale-relabel), passing the issue number and the live list of
 * OPEN PRs (`gh pr list --repo gaberoo322/hydra --state open --json
 * number,body,title,mergeable`).
 *
 * - No referencing open PR  → `{ promote: true, targetLane: "ready-for-agent" }`.
 * - A referencing open PR    → `{ promote: false, targetLane: <divert lane>, prRef }`.
 *
 * Pure and idempotent: same inputs → same decision.
 */
export function evaluateReadyForAgentPromotion(
  issueNumber: number,
  openPrs: readonly OpenPr[] | null | undefined,
): PromotionDecision {
  const pr = findReferencingOpenPr(issueNumber, openPrs);
  if (!pr) {
    return {
      promote: true,
      targetLane: "ready-for-agent",
      prRef: null,
      reason: "no open PR references this issue — promotion allowed",
    };
  }

  const lane = laneForMergeable(pr.mergeable);
  const mergeableLabel =
    typeof pr.mergeable === "string" && pr.mergeable ? pr.mergeable.toUpperCase() : "unknown";
  const reasonByLane: Record<typeof lane, string> = {
    "needs-qa": `open PR #${pr.number} (mergeable) already references #${issueNumber} — diverting to needs-qa instead of dispatching a duplicate build`,
    "ready-for-human": `open PR #${pr.number} (CONFLICTING/parked) already references #${issueNumber} — routing to operator instead of dispatching a duplicate build`,
    "has-open-pr": `open PR #${pr.number} (mergeable=${mergeableLabel}) already references #${issueNumber} — suppressing ready-for-agent, leaving a has-open-pr note`,
  };

  return {
    promote: false,
    targetLane: lane,
    prRef: pr.number,
    reason: reasonByLane[lane],
  };
}
