/**
 * pattern-memory/cue-policy.ts — pure cue-promotion policy leaf
 *
 * Extracted from escalation.ts (issue #2569). This module owns the *policy*
 * half of the auto-escalation feature — the cue alias table, the per-cue
 * escalation thresholds, and the pure predicates that decide whether/when a
 * cue should escalate — separated from the GitHub-IO escalation *adapter*
 * (`escalateIfNeeded`, `escalatePatternToIssue`, and the `ghExec`/`ghJson`
 * calls), which stays in escalation.ts.
 *
 * Why the split: a caller that only needs the policy constants
 * (`decision.ts`'s `decideRecordActions`, the friction-dedup tests, the
 * dashboard aggregators) no longer pulls in `ghExec`/`ghJson` — and the
 * `src/github/*` import chain behind them — at module-load time. This mirrors
 * the capacity-floor / capacity-floor-classifier.ts precedent (issue #2211)
 * and the constants.ts leaf (issue #2117): pure logic in a zero-IO leaf,
 * Redis-or-IO work in the caller.
 *
 * A leaf module: no Redis, no filesystem, no async, and — crucially — NO
 * import of `../github/*`. Import direction is one-way — `decision.ts`,
 * `agent-memory.ts`, and `escalation.ts` import from here; this module imports
 * from no pattern-memory sibling (it mirrors constants.ts and
 * capacity-floor-classifier.ts).
 */

// ---------------------------------------------------------------------------
// Cue taxonomy (issue #524)
// ---------------------------------------------------------------------------
//
// The lesson-capture pipeline emits kebab-case `cue` strings that become the
// pattern category. Two cues are special-cased because QA reports them on
// nearly every PR with non-trivial acceptance criteria; conflating them caused
// the auto-escalation to fire on every operator-observable AC (issue #516):
//
//   acceptance-criterion-unmet     — the implementation didn't satisfy the
//                                    criterion. This is a true planner-quality
//                                    signal, but QA reports it on nearly every
//                                    PR with non-trivial ACs, so the legacy
//                                    default of 3 flooded the operator with an
//                                    every-10-hits nag. Surface only at a much
//                                    higher (but still FINITE) bar — 150 hits
//                                    across distinct skills (issue #2537). It is
//                                    NOT muted to Infinity: it remains a genuine
//                                    signal, it just escalates at a higher bar.
//
//   acceptance-criterion-deferred  — the criterion requires post-deploy /
//                                    runtime / manual observation that
//                                    pre-merge QA *cannot* verify. This is
//                                    metadata about the AC's shape, not a
//                                    defect. The actionable signal is "the
//                                    pattern of deferred ACs has changed at
//                                    scale", not "this PR had a deferred AC."
//                                    Surface only at much higher thresholds.
//
// Any other cue uses the default threshold (`PROMOTION_THRESHOLD` = 3).
const ACCEPTANCE_CRITERION_DEFERRED_CUE = "acceptance-criterion-deferred";

// acceptance-criterion-unmet fires on nearly every PR with operator-observable
// ACs, so the legacy default of 3 produced a chronic every-10-hits operator
// nag. Raise the bar to a high-but-FINITE 150 (issue #2537): the cue still
// escalates — it is a genuine planner-quality QA signal — just at a much higher
// volume. It is deliberately NOT Number.POSITIVE_INFINITY (that sentinel is
// reserved for the no-agent-spawn-tool-run-inline inline-mode contract, which
// is not a defect at all). 150 mirrors the high-volume treatment already given
// to acceptance-criterion-deferred (20), scaled to unmet's higher hit rate.
const ACCEPTANCE_CRITERION_UNMET_CUE = "acceptance-criterion-unmet";
const ACCEPTANCE_CRITERION_UNMET_THRESHOLD = 150;

// ---------------------------------------------------------------------------
// Cue alias table (issue #2527)
// ---------------------------------------------------------------------------
//
// The fuzzy cue-deduplication algorithm in cue-matcher.ts (overlap coefficient
// >= 0.6) handles SIMILAR spellings of the same gotcha automatically. But some
// high-recurrence friction clusters fragment across cues that are lexically
// TOO DIFFERENT to merge by token overlap — the five worktree write-fence
// fragments are the canonical example (~135 total hits spread across five cues,
// none individually crossing the auto-escalation threshold):
//
//   worktree-write-fence-blocks-entered-worktree      (51 hits)
//   edit-tool-ghost-writes-to-main-checkout-not-worktree  (50 hits)
//   edit-resolved-to-main-checkout-needs-worktree-path    (17 hits)
//   enterworktree-pinned-agent-write-fence-mismatch   (16 hits)
//   enterworktree-anchor-desync-blocks-write-tool      (1 hit)
//
// The alias table maps every known variant to ONE canonical cue so that
// `canonicalizeCue()` can normalise the incoming cue BEFORE the fuzzy-merge
// step in `recordPattern`. The canonical cue is the one used for escalation,
// pattern storage, and the feedback-file key — variants are demoted to aliases.
//
// When to add a new entry: when a /hydra-retro surfaces a cue cluster whose
// members score < 0.6 against each other (or against the desired canonical)
// and the aggregate hit count is already worth an escalation. Mirror the #2521
// approach for the cleanup cluster: pick the most descriptive spelling as
// canonical, map all siblings to it.
//
// The alias table is FRICTION-NAMESPACE ONLY (design invariant 1 from #1667):
// memory-namespace cues are deliberate identifiers with per-cue escalation
// thresholds; a forced alias there would corrupt those thresholds. The
// `canonicalizeCue()` caller in `agent-memory.ts` applies the mapping only
// when `namespace === "friction"`.
const CUE_ALIAS_TABLE: Readonly<Record<string, string>> = {
  // Worktree write-fence desync cluster (issue #2527).
  // All five cues describe the same root failure: the harness write-fence /
  // anchor not aligned with the worktree the agent is actually in.
  "worktree-write-fence-blocks-entered-worktree": "worktree-write-fence-desync",
  "edit-tool-ghost-writes-to-main-checkout-not-worktree": "worktree-write-fence-desync",
  "edit-resolved-to-main-checkout-needs-worktree-path": "worktree-write-fence-desync",
  "enterworktree-pinned-agent-write-fence-mismatch": "worktree-write-fence-desync",
  "enterworktree-anchor-desync-blocks-write-tool": "worktree-write-fence-desync",
};

/**
 * Map a raw friction cue to its canonical form using the explicit alias table.
 * Returns the canonical cue when a mapping exists, otherwise the original cue
 * unchanged. Applies to FRICTION NAMESPACE ONLY — callers in the memory
 * namespace must not call this (per design invariant 1, #1667).
 *
 * This is the complement to the fuzzy overlap-coefficient merge in
 * `findPatternForCue` (cue-matcher.ts): the fuzzy layer handles SIMILAR
 * spellings automatically; this layer handles lexically DISTANT variants of
 * the same gotcha that score below the 0.6 merge threshold.
 *
 * Exported for tests and for `agent-memory.ts`'s `recordPattern`.
 */
export function canonicalizeCue(cue: string): string {
  if (typeof cue !== "string") return cue;
  return CUE_ALIAS_TABLE[cue] ?? cue;
}

// Expected-telemetry cue (issue #1789). The hydra-target-build Step-2
// inline-mode contract (#1782) mandates a friction-log POST with this exact
// cue on EVERY autopilot-dispatched inline build — by design — because the
// dispatch session never grows an Agent/Task spawn tool. The hit count is
// useful inline-mode frequency telemetry (kept visible on
// /learning/friction-patterns), but it is NOT chronic friction to escalate:
// any finite threshold just defers noise, then the escalator reopens the
// closed #1789 forever. Mapped to POSITIVE_INFINITY so the cue never produces
// an EscalationInput — the inline-mode decision record is the #1782 contract
// itself, not a recurring GitHub issue.
const NO_AGENT_SPAWN_TOOL_RUN_INLINE_CUE = "no-agent-spawn-tool-run-inline";

/**
 * Per-cue escalation thresholds. Cues not listed fall back to the caller's
 * `defaultThreshold` (currently `PROMOTION_THRESHOLD = 3` for both the
 * memory and friction namespaces).
 *
 * `acceptance-criterion-deferred` raises the bar to 20+ hits across distinct
 * skills before opening a GitHub issue, because the cue is expected to fire on
 * nearly every PR with operator-observable ACs.
 *
 * `acceptance-criterion-unmet` raises the bar to 150 hits (issue #2537) for the
 * same reason at a higher volume — it is a genuine planner-quality defect
 * signal, so the threshold stays FINITE (never Infinity); it just escalates at
 * a much higher bar than the legacy default of 3.
 *
 * `no-agent-spawn-tool-run-inline` uses `Number.POSITIVE_INFINITY` — the
 * never-escalate sentinel. `escalationThresholdForCue` accepts any override
 * `> 0` (Infinity qualifies) and `shouldEscalateAtHitCount(n, Infinity)` is
 * false for every finite hit count, so the cue never escalates while its hit
 * count keeps accumulating as telemetry (issue #1789).
 */
const CUE_ESCALATION_THRESHOLDS: Record<string, number> = {
  [ACCEPTANCE_CRITERION_DEFERRED_CUE]: 20,
  [ACCEPTANCE_CRITERION_UNMET_CUE]: ACCEPTANCE_CRITERION_UNMET_THRESHOLD,
  [NO_AGENT_SPAWN_TOOL_RUN_INLINE_CUE]: Number.POSITIVE_INFINITY,
};

/**
 * Resolve the escalation threshold for a given cue. Returns the cue's
 * override when one is registered, otherwise the supplied default. Exported
 * for tests and for `agent-memory.ts`'s `maybeEscalate()`.
 */
export function escalationThresholdForCue(
  cue: string,
  defaultThreshold: number,
): number {
  if (typeof cue !== "string") return defaultThreshold;
  const override = CUE_ESCALATION_THRESHOLDS[cue];
  return typeof override === "number" && override > 0 ? override : defaultThreshold;
}

/**
 * True when a cue is metadata about the AC's shape rather than a defect
 * signal. Used by `agent-memory.ts` to skip the `to-{agent}.md` feedback-file
 * promotion — deferred ACs aren't actionable rules for the planner, so
 * surfacing them as cardinal rules would just create noise (issue #524).
 *
 * Pattern recording still happens, so the dashboard / friction-patterns
 * endpoint can show deferred-cue hit counts; only the file write is skipped.
 */
export function isMetadataCue(cue: string): boolean {
  return cue === ACCEPTANCE_CRITERION_DEFERRED_CUE;
}

/**
 * Pure helper — decide whether the current hit count is one that should fire
 * an escalation. Threshold-cross plus every multiple of 10 thereafter.
 * Exported for tests.
 */
export function shouldEscalateAtHitCount(
  hitCount: number,
  promotionThreshold: number,
): boolean {
  if (hitCount === promotionThreshold) return true;
  if (hitCount > promotionThreshold && (hitCount - promotionThreshold) % 10 === 0) return true;
  return false;
}
