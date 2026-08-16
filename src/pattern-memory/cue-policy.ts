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

// ===========================================================================
// Issue #3850 — rate-vs-baseline escalation gate for steady-rate cues
// ===========================================================================
//
// The count-based `shouldEscalateAtHitCount` above (threshold-cross plus every
// multiple of 10) compares a cue's MONOTONIC lifetime hit count against a fixed
// threshold. For a cue that fires at a steady background rate, that comparison
// can never go quiet again: it crosses the threshold once, then re-bumps its
// escalation issue every 10 hits forever — because the count only ever rises
// while the underlying rate is roughly constant. Raising the threshold (the
// 150/20 bars already on the two cues below) buys time, not silence.
//
// The signal an operator actually wants from a steady-rate cue is "this cue is
// firing MORE than it used to", not "this cue has fired a lot in total". The
// rate gate below delivers exactly that, and ONLY for the two cues that were
// given raised finite thresholds for the same "fires on nearly every PR"
// reason — the `acceptance-criterion-unmet` (150) and `-deferred` (20) pair.
//
// IMPORTANT — the gate lives DOWNSTREAM of decideRecordActions, inside
// escalation.ts's OPEN-issue comment-bump branch (see the design-concept for
// issue-3850) AND, since issue #4073, its CLOSED-issue reopen branch too.
// decideRecordActions / recordPattern keep deciding escalate=true at the
// existing count cadence for EVERY cue; the gate only decides whether an
// already-fired OPEN-issue comment-bump or CLOSED-issue reopen actually
// PROCEEDS. Issue CREATION (findExistingIssue → null) is NEVER gated — a
// first occurrence is always informative. Every non-rate-gated cue's
// behaviour is byte-identical (including its CLOSED→reopen path, which still
// reopens unconditionally) because the gate is never reached for them.
//
// Why the CLOSED path needed the same gate (#4073): "any post-close
// recurrence is always informative" is correct for a bursty cue but exactly
// inverted for a steady-rate cue — a post-close recurrence is near-guaranteed
// within days, so closing the issue was precisely what routed the next hit
// around this gate (issue #2528: 4 reopens in 15 days, every one via the
// then-ungated reopen path).

/**
 * The cues whose OPEN-issue comment-bumps are rate-gated. Seeded with exactly
 * the two cues that carry raised finite thresholds for the "fires on nearly
 * every PR" reason — both have the steady-rate-nags-forever defect. Every
 * other cue (the PROMOTION_THRESHOLD=3 default path AND the
 * Number.POSITIVE_INFINITY never-escalate sentinel) is unaffected.
 */
const RATE_GATED_CUES: ReadonlySet<string> = new Set([
  ACCEPTANCE_CRITERION_UNMET_CUE,
  ACCEPTANCE_CRITERION_DEFERRED_CUE,
]);

/**
 * True when a cue's OPEN-issue comment-bumps are rate-gated (issue #3850).
 * Exported for escalation.ts's gate branch and for tests.
 */
export function isRateGatedCue(cue: string): boolean {
  return typeof cue === "string" && RATE_GATED_CUES.has(cue);
}

// RATE_ESCALATION_WINDOW_DAYS / RATE_ESCALATION_MULTIPLIER — fitted against the
// ACTUAL recorded bump history of acceptance-criterion-unmet on issue #2528
// (pulled via `gh issue view 2528 --json createdAt,body,comments`), not
// asserted. The issue body and the bump comments carry machine-parseable hit
// counts in escalation.ts's own output format:
//
//   created @  83 hits   2026-06-28T11:33Z   (body: "after 83 hits on cue …")
//   bump    @ 150 hits   2026-07-24T23:16Z   ("Pattern still firing — now 150 hits …")
//   bump    @ 160 hits   2026-07-30T04:45Z
//   bump    @ 170 hits   2026-07-31T01:32Z
//   bump    @ 180 hits   2026-08-01T12:36Z
//   bump    @ 190 hits   2026-08-06T10:48Z
//   bump    @ 200 hits   2026-08-08T11:41Z
//
// Across that span the cue ran at a noisy-but-roughly-steady ~2-3 hits/day
// (day-to-day swings of ~1.7 to ~11 hits/day from burstiness), yet the
// cumulative-count gate re-bumped on every +10 hits (6 bumps over six weeks).
// A self-relative rate check (recent rate vs the cue's OWN creation-anchored
// baseline rate) needs only a minimum WINDOW so a single bursty day cannot
// trip it, and a MULTIPLIER so a steady rate (recent ≈ baseline) never
// re-trips. Replaying the 83→200 series through `shouldRateEscalate` with
// WINDOW=7, MULTIPLIER=1.5 posts TWO bumps over the eight-day 150→200 span
// (150 — the first post-creation windowed bump; and 180 — a genuine burst,
// 160→170→180 in ~2.5 days ≈ 4/day vs the ~2.5/day baseline), suppressing the
// steady background, while a sustained doubling of the rate still reaches the
// operator once the higher rate dominates the window average. (The old count
// gate bumped on all six: 150→160→170→180→190→200.)
// The 1.5x multiplier mirrors the existing `RATE_RATIO_MULTIPLIER` precedent
// in rule-effectiveness.ts for an analogous rate-vs-rate comparison. One
// shared pair serves BOTH cues because the check is a self-relative ratio —
// scale-invariant by construction, unlike the old absolute hit-count bars.
export const RATE_ESCALATION_WINDOW_DAYS = 7;
export const RATE_ESCALATION_MULTIPLIER = 1.5;

/**
 * One parsed point in a cue's historical escalation-bump series: the hit
 * count an escalation reported, and the ISO 8601 timestamp it was posted.
 * Produced by `parseEscalationBumpSeries` from the GitHub issue's own body +
 * comment trail (escalation.ts owns the fetch; this module owns the parse).
 */
export type BumpPoint = { readonly hitCount: number; readonly at: string };

/**
 * Parse a cue's historical (hitCount, timestamp) bump series from the GitHub
 * issue body + comment trail that escalation.ts fetches. Pure: text in,
 * structured series out (issue #3850).
 *
 * The escalation adapter writes two machine-parseable hit-count phrases:
 *  - the issue body at creation (buildBody): "Auto-escalated … after N hits
 *    on cue …" — this is the CREATION point (baseline origin).
 *  - each comment-bump (buildCommentBody): "Pattern still firing — now N
 *    hits on …" — these are the BUMP points.
 *
 * Non-escalation comments (operator reviews, sweep reconciliations, QA
 * verdicts, label-validation bots) match neither phrase, so they are ignored
 * — only the cue's own escalation history is reconstructed. Returns the
 * creation point FIRST (when the body parses), then each bump in
 * chronological order; an empty array means nothing parsed (the caller fails
 * open). The `createdAt` timestamps come straight from GitHub.
 */
export function parseEscalationBumpSeries(
  body: string,
  createdAt: string,
  comments: ReadonlyArray<{ body: string; createdAt: string }>,
): BumpPoint[] {
  const points: BumpPoint[] = [];
  const bodyHits =
    firstHitMatch(body, /after (\d+) hits on cue/) ??
    firstHitMatch(body, /\*\*Hit count:\*\*\s*(\d+)/);
  if (bodyHits !== undefined && typeof createdAt === "string" && createdAt.length > 0) {
    points.push({ hitCount: bodyHits, at: createdAt });
  }
  for (const c of comments) {
    if (!c || typeof c.body !== "string" || typeof c.createdAt !== "string") continue;
    const h = firstHitMatch(c.body, /Pattern still firing — now (\d+) hits/);
    if (h !== undefined) points.push({ hitCount: h, at: c.createdAt });
  }
  // Sort chronologically by timestamp. GitHub returns comments in order, but
  // sort defensively so the anchor is genuinely the latest bump and the
  // creation point (issue createdAt <= every comment createdAt) stays first.
  points.sort((a, b) => {
    const d = Date.parse(a.at) - Date.parse(b.at);
    return Number.isNaN(d) ? 0 : d;
  });
  return points;
}

/** Pull the first integer capture group out of `text`, or undefined. */
function firstHitMatch(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

const MS_PER_DAY = 86_400_000;

/**
 * Fractional days from ISO timestamp `a` to `b` (b − a). Returns +Infinity
 * when either timestamp is unparseable, so a bad timestamp degrades to
 * "long ago" and the caller fails OPEN (posts) rather than silently
 * suppressing — consistent with the gate's fail-open contract.
 */
function elapsedDays(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return (tb - ta) / MS_PER_DAY;
}

/**
 * Issue #3850 — pure rate-vs-baseline gate for the OPEN-issue comment-bump
 * path. Given a cue's parsed historical bump series (creation point first,
 * then each past successful bump chronologically), the current hit count, and
 * the wall-clock `now` (ISO 8601), decide whether a fresh comment-bump should
 * POST (true) or be SUPPRESSED (false).
 *
 *  - Fewer than RATE_ESCALATION_WINDOW_DAYS since the anchor (the most recent
 *    successful bump, or creation when none has posted) → SUPPRESS: a single
 *    bursty day must not trip the gate.
 *  - No baseline yet (only the creation point exists — this would be the
 *    first post-creation bump) → POST once the window clears. There is no
 *    historical rate to compare against, so the first windowed bump is always
 *    informative and becomes the baseline anchor for later calls.
 *  - Otherwise POST iff the recent rate (hits since the anchor ÷ days since
 *    the anchor) is at least RATE_ESCALATION_MULTIPLIER × the baseline rate
 *    (hits from creation to the anchor ÷ days from creation to the anchor).
 *
 * Self-relative by construction: a cue whose recent rate matches its own
 * history never re-trips (steady-rate silence), while a cue whose rate has
 * genuinely risen above its own past does. Pure: no I/O, no clock — `now` is
 * a parameter so tests are deterministic.
 */
export function shouldRateEscalate(
  series: ReadonlyArray<BumpPoint>,
  currentHitCount: number,
  now: string,
): boolean {
  if (series.length === 0) return true; // nothing parsed → fail-open (post)
  const creation = series[0];
  const anchor = series[series.length - 1];
  const daysSinceAnchor = elapsedDays(anchor.at, now);
  if (daysSinceAnchor < RATE_ESCALATION_WINDOW_DAYS) return false;
  if (series.length < 2) return true; // only creation → first post-creation bump
  const baselineSpan = elapsedDays(creation.at, anchor.at);
  if (baselineSpan <= 0) return true; // degenerate timestamps → fail-open
  const baselineRate = (anchor.hitCount - creation.hitCount) / baselineSpan;
  const recentRate = (currentHitCount - anchor.hitCount) / daysSinceAnchor;
  return recentRate >= baselineRate * RATE_ESCALATION_MULTIPLIER;
}
