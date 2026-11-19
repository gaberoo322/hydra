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
} from "./gates.ts";
export {
  HOLD_EXIT_ALERT_WINDOW_DAYS,
  isUnsanctionedHoldExit,
} from "./hold-exit.ts";
export {
  type TimedBody,
} from "./caps.ts";
export {
  classifyQaVerdictTarget,
  gateQaVerdict,
  type QaLivePr,
} from "./gates.ts";
export {
  MAX_STALE_CLAIM_CLOSES,
  STALE_CLAIM_AGE_MS,
  runReconcile,
  type ReconcileDeps,
} from "./reconcile.ts";
export {
  advance,
  defaultSeamDeps,
  journalEntry,
  loadLifecycleMode,
  openClaim,
  operatorAdvance,
  operatorReopen,
  releaseClaim,
  releaseClaimByDispatch,
  dispatch,
  type DispatchInput,
  type DispatchResult,
  CLAIM_OUTCOMES,
  type ClaimOutcome,
  type ClaimPurpose,
  resolveLifecycleMode,
  type AdvanceResult,
  type LifecycleMode,
  type SeamDeps,
} from "./seam.ts";
