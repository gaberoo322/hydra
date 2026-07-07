/**
 * pattern-memory/decision.ts — the promotion/escalation decision spine
 *
 * Extracted from `agent-memory.ts::recordPattern` (issue #2178). `recordPattern`
 * orchestrates four seams in sequence — cue-dedup, Redis storage, feedback-file
 * promotion, and GitHub escalation — but the *decision* that drives the last two
 * ("has this hit crossed the promotion threshold, and should it also escalate?")
 * used to be inlined in the orchestration's if-branches. This module lifts that
 * decision into one named, pure predicate so it can be reasoned about and tested
 * independently of the side-effecting seams it gates.
 *
 * Purely arithmetic over a pattern's current state: no Redis, no filesystem, no
 * async, no `gh`. It composes the existing pure helpers from the cue-policy
 * leaf (`isMetadataCue`, `escalationThresholdForCue`,
 * `shouldEscalateAtHitCount` from `cue-policy.ts`) into a single answer, so the
 * "when to call the seams" decision has exactly one home. The seams themselves
 * are unchanged — `recordPattern` still calls them — but it now calls them
 * *because* this predicate said to, rather than re-deriving the condition inline.
 *
 * Import direction is one-way: this module imports the cue-policy pure helpers;
 * `agent-memory.ts` imports this. Neither `cue-policy.ts` nor `escalation.ts`
 * import this back. (Issue #2569 moved the policy helpers out of escalation.ts
 * into the zero-IO `cue-policy.ts` leaf, so this module no longer pulls in the
 * `ghExec`/`ghJson` GitHub-IO chain at module load.)
 */

import {
  escalationThresholdForCue,
  shouldEscalateAtHitCount,
} from "./cue-policy.ts";
// Type-only import: erased at runtime, so this introduces NO circular runtime
// dependency even though `agent-memory.ts` imports `decideRecordActions` from
// here. `PatternNamespace` has its canonical definition there.
import type { PatternNamespace } from "./agent-memory.ts";

/**
 * The minimal slice of a pattern's state the decision reads. Deliberately a
 * structural subset of `MemoryPattern` (not the full store type) so the
 * predicate stays decoupled from the storage schema and a caller — or a test,
 * or an API diagnostic — can ask "would a pattern in *this* state promote?"
 * without constructing a full `MemoryPattern`.
 */
export type PatternDecisionState = {
  /** The pattern's CANONICAL category/cue (post fuzzy-merge — issue #1667). */
  category: string;
  /** Hit count AFTER recording the current hit. */
  hitCount: number;
  /** Whether the pattern has already been promoted (so promotion is one-shot). */
  promoted: boolean;
};

/**
 * The set of side-effecting actions a single `recordPattern` hit should fire.
 * Every field is a plain boolean the orchestrator dispatches on — the predicate
 * makes the choice, the orchestrator performs the I/O.
 *
 * Issue #2962 — the `writeFeedbackFile` action was retired. The
 * promote→observe→demote lifecycle over `config/feedback/to-*.md` was write-only
 * (no path injected those files into any dispatch prompt after the Codex planner/
 * executor/skeptic consumers were deleted — ADR-0006 / #710), so the file-write
 * seam it gated is gone. Promotion still stamps `promoted/promotedAt` in the
 * Redis pattern store (which drives escalation and the effectiveness API); it
 * simply no longer mirrors a rule block into a dead markdown file.
 */
export type RecordPatternDecision = {
  /**
   * True when this hit crosses the promotion threshold for the first time
   * (`hitCount >= PROMOTION_THRESHOLD && !promoted`). When true, the orchestrator
   * stamps `promoted/promotedAt/hitsAtPromotion` and sets `crossedThreshold`.
   */
  promote: boolean;
  /**
   * True when this hit count merits a GitHub-issue escalation: the per-cue
   * escalation threshold-cross plus every multiple of 10 thereafter
   * (`shouldEscalateAtHitCount`). Independent of `promote` — escalation re-fires
   * at 13/23/33… while promotion is one-shot.
   */
  escalate: boolean;
};

/**
 * Decide which side effects a `recordPattern` hit should fire, given the
 * pattern's post-hit state, the namespace, and the promotion threshold.
 *
 * Pure: no I/O, no mutation of the input. The orchestrator (`recordPattern`)
 * calls this once after computing the post-hit `hitCount`, reads the returned
 * flags, and dispatches to the feedback-file / escalation seams accordingly.
 *
 * The two sub-decisions and how they compose:
 *  - `promote`            — `hitCount >= promotionThreshold && !promoted`
 *  - `escalate`           — `shouldEscalateAtHitCount(hitCount, escalationThresholdForCue(category, promotionThreshold))`
 *
 * `escalate` keys on the per-cue threshold override (issue #524 raises
 * `acceptance-criterion-deferred` to 20; issue #1789 maps
 * `no-agent-spawn-tool-run-inline` to never-escalate), so it can diverge from
 * `promote` — a metadata cue can promote (and stamp `promoted`) at 3 hits while
 * not escalating until 20.
 */
export function decideRecordActions(
  state: PatternDecisionState,
  namespace: PatternNamespace,
  promotionThreshold: number,
): RecordPatternDecision {
  const promote = state.hitCount >= promotionThreshold && !state.promoted;

  const escalationThreshold = escalationThresholdForCue(
    state.category,
    promotionThreshold,
  );
  const escalate = shouldEscalateAtHitCount(state.hitCount, escalationThreshold);

  return { promote, escalate };
}
