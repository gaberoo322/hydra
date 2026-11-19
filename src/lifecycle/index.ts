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
  isOperatorTarget,
  isHumanHold,
  isLegalTransition,
  isLifecycleState,
  stateLabelsOf,
  type FiredBy,
  type GateId,
  type HumanHoldState,
  type LifecycleState,
  type OpenState,
  type OperatorTarget,
  type OperatorTransition,
} from "./transitions.ts";
export {
  ADR5_REASONS,
  isAdr5Reason,
  isAllowedReason,
  type Adr5Reason,
} from "./reasons.ts";
export {
  DESIGN_CONCEPT_FLAG,
  RESEARCH_TRAILER_PREFIX,
  bodyClosesIssue,
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
  type DesignConceptRecord,
  type Fetched,
  type GateInput,
  type GateRecords,
  type GateResult,
  type PrRecord,
} from "./gates.ts";
export {
  HOLD_EXIT_ALERT_WINDOW_DAYS,
  isUnsanctionedHoldExit,
} from "./hold-exit.ts";
export {
  CAP_ARMS,
  CAP_DEFAULTS,
  CAP_RESET_PREFIX,
  CAP_TABLE,
  capEnvName,
  classRole,
  countReviewedFailRoundsAfterReset,
  countReviewedFailRoundsSinceReset,
  evaluateCaps,
  latestResetMs,
  type CapArm,
  type CapCount,
  type CapEvaluation,
  type CapSource,
  type CapUnit,
  type TimedBody,
} from "./caps.ts";
export {
  classifyQaPassedExit,
  classifyQaVerdictTarget,
  gateQaExit,
  gateQaVerdict,
  type QaExitTarget,
  type QaLivePr,
  type QaVerdictTarget,
} from "./gates.ts";
export { externalMoves, lastKnownState, replayStateSnapshots } from "./timeline.ts";
export {
  MAX_STALE_CLAIM_CLOSES,
  STALE_CLAIM_AGE_MS,
  isZeroStateExempt,
  runReconcile,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileReport,
} from "./reconcile.ts";
export { parkForCap, postCapReset, type CapResetResult, type ParkResult } from "./park.ts";
export { advance, journalEntry, type AdvanceInput, type AdvanceResult } from "./seam.ts";
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
  type ClaimInput,
  type ClaimOutcome,
  type ClaimPurpose,
  type ClaimResult,
  type DispatchInput,
  type DispatchResult,
} from "./claim.ts";
export { operatorAdvance, operatorReopen, type OperatorAdvanceInput } from "./operator.ts";
