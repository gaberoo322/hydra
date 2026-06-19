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
 * async, no `gh`. It composes the existing pure helpers from the sibling
 * modules (`isMetadataCue`, `escalationThresholdForCue`,
 * `shouldEscalateAtHitCount` from `escalation.ts`) into a single answer, so the
 * "when to call the seams" decision has exactly one home. The seams themselves
 * are unchanged — `recordPattern` still calls them — but it now calls them
 * *because* this predicate said to, rather than re-deriving the condition inline.
 *
 * Import direction is one-way: this module imports the escalation pure helpers;
 * `agent-memory.ts` imports this. `escalation.ts` does NOT import this back.
 */

import {
  escalationThresholdForCue,
  isMetadataCue,
  shouldEscalateAtHitCount,
} from "./escalation.ts";
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
 */
export type RecordPatternDecision = {
  /**
   * True when this hit crosses the promotion threshold for the first time
   * (`hitCount >= PROMOTION_THRESHOLD && !promoted`). When true, the orchestrator
   * stamps `promoted/promotedAt/hitsAtPromotion` and sets `crossedThreshold`.
   */
  promote: boolean;
  /**
   * True when the promotion should ALSO write through to the `to-{agent}.md`
   * feedback file. Only meaningful when `promote` is true. The feedback-file
   * write is skipped for metadata cues (issue #524 — `isMetadataCue`) and for
   * the `friction` namespace (there is no `to-{skill}.md` for arbitrary skills).
   */
  writeFeedbackFile: boolean;
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
 * The three sub-decisions and how they compose:
 *  - `promote`            — `hitCount >= promotionThreshold && !promoted`
 *  - `writeFeedbackFile`  — `promote && namespace === "memory" && !isMetadataCue(category)`
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

  // The feedback-file write is gated on the SAME metadata/namespace conditions
  // the orchestration used to inline. Judged on the canonical category so a
  // fuzzy-merged variant can't dodge or trigger the metadata classification
  // (issue #1667).
  const writeFeedbackFile =
    promote && namespace === "memory" && !isMetadataCue(state.category);

  const escalationThreshold = escalationThresholdForCue(
    state.category,
    promotionThreshold,
  );
  const escalate = shouldEscalateAtHitCount(state.hitCount, escalationThreshold);

  return { promote, writeFeedbackFile, escalate };
}
