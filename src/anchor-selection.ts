// ---------------------------------------------------------------------------
// Anchor selection — facade re-exporting domain-grouped sub-modules.
// ---------------------------------------------------------------------------
//
// The original 1,176-line file was split into `src/anchor-selection/*` modules
// in issue #288, following the ADR-0001 pattern used for redis-adapter (#269)
// and the merge gate (#249). This shim preserves the existing import surface
// — every caller continues `import { fn } from "./anchor-selection.ts"`.
//
// Sub-modules:
//   - anchor-selection/constants.ts        — Redis keys, thresholds, key helpers
//   - anchor-selection/drift-filter.ts     — pre-planner near-duplicate rejection
//   - anchor-selection/reframe.ts          — reframe queue: maintenance, selection, starvation
//   - anchor-selection/prior-failures.ts   — prior-failure escalation + persist
//   - anchor-selection/abandonment.ts      — circuit breaker + processing cleanup
//   - anchor-selection/low-confidence.ts   — perm-skip for dead-on-arrival anchors
//   - anchor-selection/outcome.ts          — unified reportOutcome dispatcher
//   - anchor-selection/select.ts           — selectAnchor priority chain
//
// All exports below are pure re-exports. No logic lives in this file.

import {
  MAX_PRIOR_FAILURE_RETRIES,
  MAX_CONSECUTIVE_ABANDONMENTS,
  REFRAME_QUEUE,
  WORK_QUEUE,
  PROCESSING_QUEUE,
  PRIOR_FAILURES_KEY,
  ABANDONMENT_COUNTER_PREFIX,
  ABANDONMENT_COUNTER_TTL,
  PRIOR_FAILURE_AGE_LIMIT_MS,
  PRIOR_FAILURE_CAP,
  REFRAME_QUEUE_CAP,
  REFRAME_QUEUE_MAX_AGE_MS,
  REFRAME_INTERLEAVE_INTERVAL,
  HEALTH_CONFIDENCE_THRESHOLD,
  DRIFT_PREFILTER_LOOKBACK,
  DRIFT_PREFILTER_THRESHOLD,
  DRIFT_PREFILTER_TYPES,
  anchorKey,
} from "./anchor-selection/constants.ts";
import {
  isAnchorDriftDuplicate,
  consumeDriftPreFilteredCount,
} from "./anchor-selection/drift-filter.ts";
import {
  pruneReframeQueue,
  getReframeQueueLen,
  recordReframePassedReason,
  recordReframeServed,
  getCyclesSinceReframeServed,
  getReframeStarvationStats,
  getReframeFloorN,
  shouldForceReframePriority,
  DEFAULT_REFRAME_FLOOR_N,
  _resetReframeStarvationForTests,
  type ReframePassedReason,
  type ReframeStarvationStats,
} from "./anchor-selection/reframe.ts";
import {
  escalateStalePriorFailures,
  storePriorFailure,
} from "./anchor-selection/prior-failures.ts";
import {
  trackAbandonment,
  clearAbandonmentCounter,
  clearProcessingItem,
} from "./anchor-selection/abandonment.ts";
import { markLowConfidenceSkip } from "./anchor-selection/low-confidence.ts";
import { reportOutcome, type OutcomeResult } from "./anchor-selection/outcome.ts";
import { selectAnchor } from "./anchor-selection/select.ts";
import {
  scoreCandidate,
  PRIORITY_TIER_BASE_SCORE,
  type ScoreSignals,
  type ScoreResult,
  type PriorityTier,
} from "./anchor-selection/scorer.ts";

// ---------------------------------------------------------------------------
// Public exports — every name previously exported from this file
// ---------------------------------------------------------------------------

export { HEALTH_CONFIDENCE_THRESHOLD };
export { consumeDriftPreFilteredCount };
export { selectAnchor };
export { markLowConfidenceSkip };
export { reportOutcome, type OutcomeResult };
export {
  scoreCandidate,
  PRIORITY_TIER_BASE_SCORE,
  type ScoreSignals,
  type ScoreResult,
  type PriorityTier,
};
// Reframe-starvation surface (issue #377) — operator-facing stats + tunables.
export {
  recordReframePassedReason,
  recordReframeServed,
  getCyclesSinceReframeServed,
  getReframeStarvationStats,
  getReframeFloorN,
  shouldForceReframePriority,
  DEFAULT_REFRAME_FLOOR_N,
  type ReframePassedReason,
  type ReframeStarvationStats,
};

// ---------------------------------------------------------------------------
// _testing — escape hatch for tests that need access to internals
// ---------------------------------------------------------------------------

export const _testing = {
  MAX_PRIOR_FAILURE_RETRIES,
  MAX_CONSECUTIVE_ABANDONMENTS,
  REFRAME_QUEUE,
  WORK_QUEUE,
  PROCESSING_QUEUE,
  PRIOR_FAILURES_KEY,
  ABANDONMENT_COUNTER_PREFIX,
  ABANDONMENT_COUNTER_TTL,
  PRIOR_FAILURE_AGE_LIMIT_MS,
  PRIOR_FAILURE_CAP,
  REFRAME_QUEUE_CAP,
  REFRAME_QUEUE_MAX_AGE_MS,
  REFRAME_INTERLEAVE_INTERVAL,
  HEALTH_CONFIDENCE_THRESHOLD,
  DRIFT_PREFILTER_LOOKBACK,
  DRIFT_PREFILTER_THRESHOLD,
  DRIFT_PREFILTER_TYPES,
  trackAbandonment,
  clearAbandonmentCounter,
  storePriorFailure,
  clearProcessingItem,
  anchorKey,
  escalateStalePriorFailures,
  pruneReframeQueue,
  getReframeQueueLen,
  isAnchorDriftDuplicate,
  _resetReframeStarvationForTests,
};
