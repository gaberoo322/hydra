/**
 * scripts/ci/qa-verdict.ts — Pure helpers for the hydra-qa skill's
 * one-pass verdict classifier (issue #405).
 *
 * Background: before #405, the hydra-qa subagent looped waiting on pending
 * required CI checks (e.g. `mutation-test`) before emitting a verdict. This
 * meant a single QA run could span hours, sometimes long enough that the PR
 * auto-merged in the background. The new behaviour: run the code-review pass
 * once, then return one of four verdicts based on (review verdict + CI
 * state):
 *
 *   PASS              — review passed AND all required checks have concluded successfully
 *   FAIL              — review failed (regardless of CI), OR a required check failed/errored
 *   PASS-pending-CI   — review passed BUT some required checks are still queued/running
 *   FAIL-pending-CI   — reserved tier: review passed but a NON-required pending check would
 *                       likely block merge if it later fails. (Currently behaves like
 *                       PASS-pending-CI for the classifier; documented for the operator playbook
 *                       so autopilot can route accordingly.)
 *
 * The autopilot loop polls CI separately and re-dispatches QA (or merges) once
 * the pending state resolves. The subagent itself never blocks waiting on CI.
 *
 * Since issue #5079 (qa-verdict-engine slice 2/4, ADR-0038) the helpers live
 * under src/qa/ — one module per QA phase (change-shape, admission, fanout,
 * fold, prior-round, round-action, verdict-trailer). This file is only the
 * workflow-facing facade: explicit named re-exports (never `export *`) of the
 * names the hydra-qa.md shims, scripts/autopilot/qa-verdict-event.sh, the
 * checks-fetch fragment and .github/workflows/deep-qa-gate.yml (via
 * hasFreshDeepQaPass) import from this path. Shrinks to hasFreshDeepQaPass
 * once #5081 rewires the playbook shims.
 */

export {
  isPromptOnlyChange,
} from "../../src/qa/change-shape.ts";
export {
  buildCheckStates,
  classifyVerdict,
  decideReviewAdmission,
  redRequiredChecks,
  renderCiSummary,
} from "../../src/qa/admission.ts";
export type { RawRollupEntry } from "../../src/qa/admission.ts";
export { decideReviewerFanout } from "../../src/qa/fanout.ts";
export {
  foldReviewFindings,
  renderReviewReport,
  trailerBlockerCounts,
} from "../../src/qa/fold.ts";
export {
  decideReReviewContext,
  priorFindingsSection,
  qaVerdictHistory,
} from "../../src/qa/prior-round.ts";
export {
  DEEP_QA_FAIL_MARKER,
  QA_ESCALATION_LABELS,
  decideDeepQaAction,
  decideQaRoundAction,
  hasFreshDeepQaPass,
  renderDeepQaPassMarker,
  renderQaEscalationSummary,
} from "../../src/qa/round-action.ts";

// temporary bridge — removed when #5081 rewires the playbook shims.
// The trailer grammar now lives in src/qa/verdict-trailer.ts; the hydra-qa.md
// shims still `import('./scripts/ci/qa-verdict.ts')` for these names.
export {
  QA_VERDICT_TRAILER_PREFIX,
  QA_VERDICT_UNKNOWN_SHA,
  QA_VERDICT_ERROR_PREFIX,
  parseQaVerdictTrailers,
  parseQaVerdictTrailer,
  isFailVerdict,
  nextQaVerdictRound,
  qaVerdictShaMatches,
  parseQaVerdictErrors,
  renderQaVerdictErrorLine,
  renderQaVerdictTrailer,
  buildQaVerdictTrailer,
} from "../../src/qa/verdict-trailer.ts";
export type {
  QaSeverity,
  QaVerdictTrailer,
  QaVerdictError,
  FinalVerdict,
} from "../../src/qa/verdict-trailer.ts";
