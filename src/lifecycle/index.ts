/**
 * `src/lifecycle/` public surface (ADR-0047, issue #5310). Callers import from
 * here; no other module hand-lists lifecycle state names.
 */
export {
  HUMAN_HOLD_STATES,
  LIFECYCLE_STATES,
  OPEN_STATES,
  OPERATOR_TARGETS,
  OPERATOR_TRANSITIONS,
  TRANSITIONS,
  findOperatorTransition,
  findTransition,
  isHumanHold,
  isLegalTransition,
  stateLabelsOf,
  type LifecycleState,
  type OpenState,
  type OperatorTarget,
  type OperatorTransition,
} from "./transitions.ts";
export {
  ADR5_REASONS,
  isAdr5Reason,
  isAllowedReason,
} from "./reasons.ts";
export {
  DESIGN_CONCEPT_FLAG,
  evaluateGate,
  gateAdr5,
  gateClaimReleased,
  gateUnblocked,
  gateClose,
  isPullRequestUrl,
  prRecordFromView,
  gateDispatch,
  gateJudgment,
  gatePrOpen,
  gateResearchExit,
  parseCommentEvidence,
  parseResearchTrailer,
  recordsNeeded,
  type BlockerRecord,
  type ClaimRecord,
  type CommentRecord,
  type Fetched,
  type GateInput,
  type GateRecords,
  type PrRecord,
} from "./gates.ts";
export {
  HOLD_EXIT_ALERT_WINDOW_DAYS,
  isUnsanctionedHoldExit,
} from "./hold-exit.ts";
export {
  latestResetMs,
  type TimedBody,
} from "./caps.ts";
export {
  classifyQaVerdictTarget,
  gateQaVerdict,
  type QaExitTarget,
  type QaLivePr,
  type QaVerdictTarget,
} from "./gates.ts";
export { lastKnownState, replayStateSnapshots } from "./timeline.ts";
export {
  MAX_STALE_CLAIM_CLOSES,
  STALE_CLAIM_AGE_MS,
  runReconcile,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileReport,
} from "./reconcile.ts";
export { parkForCap, postCapReset, type ParkResult } from "./park.ts";
export { advance, journalEntry, type AdvanceResult } from "./seam.ts";
export {
  defaultSeamDeps,
  loadLifecycleMode,
  resolveLifecycleMode,
  type LifecycleMode,
  type SeamDeps,
} from "./seam-deps.ts";
export {
  CLAIM_OUTCOMES,
  CLAIM_PURPOSES,
  LEGACY_BACKFILL_CLASS,
  dispatch,
  openClaim,
  releaseClaim,
  releaseClaimByDispatch,
  type ClaimOutcome,
  type ClaimPurpose,
  type DispatchInput,
  type DispatchResult,
} from "./claim.ts";
export { operatorAdvance, operatorReopen, type OperatorAdvanceInput } from "./operator.ts";
