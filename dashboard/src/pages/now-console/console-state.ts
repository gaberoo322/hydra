/**
 * console-state.ts — the /now Console's public module surface: a pure
 * re-export barrel over the four concern-scoped leaves (issue #4382; the
 * leaves were extracted verbatim from this file, which previously bundled
 * them — original issues #891 now-console-4 parent #887, #2411 now-status-5
 * parent #2408).
 *
 * The Console widgets each import their own single concern from this one
 * path; the barrel keeps that contract stable while the implementations live
 * in narrow, independently-editable siblings (same shape as the
 * `src/cost/index.ts` barrel over `src/cost/`, #4347):
 *
 *   - status-verdict-state.ts — the composite hero verdict
 *     (RUNNING / IDLE / STUCK / CRASHED / PAUSED) + stuck-signal ranking.
 *   - usage-panel-state.ts — weekly-pace classification + the usage
 *     attribution flattener.
 *   - console-format.ts — the shared percent/tokens/duration/ratio
 *     formatters.
 *   - status-strip-state.ts — the StatusStrip widgets' next-dispatch
 *     countdown + in-flight slot list.
 *
 * The former view-mode section (Console ↔ Habitat deep-link + localStorage
 * round-trip) is NOT here: ADR-0034 §3 retired the mode toggle with the
 * Habitat (PR #4106), leaving that block with zero production consumers, and
 * #4382 deleted it rather than giving dead code a new home. The barrel's
 * value exports are pinned === to their leaf exports by
 * `test/now-console-state.test.mts`.
 *
 * This file deliberately contains no logic and no imports other than the
 * re-exports below — new Console derivations belong in a leaf (or a new
 * one), re-exported here only when a widget consumes them.
 */

export {
  VERDICT_RUNNING,
  VERDICT_IDLE,
  VERDICT_STUCK,
  VERDICT_CRASHED,
  VERDICT_PAUSED,
  rankStuckSignals,
  resolveVerdict,
} from "./status-verdict-state.ts";
export type {
  LifecycleLike,
  StuckSignalLike,
  IdleDiagnosticsLike,
  PausedLike,
  VerdictResult,
} from "./status-verdict-state.ts";

export { classifyPace, flattenAttribution } from "./usage-panel-state.ts";
export type { PaceVerdict, AttributionRow } from "./usage-panel-state.ts";

export {
  formatPercent,
  formatTokens,
  formatDuration,
  formatRatio,
} from "./console-format.ts";

export {
  formatNextDispatchCountdown,
  deriveInflightSlots,
} from "./status-strip-state.ts";
export type {
  NextDispatchCountdown,
  InflightSlotRow,
} from "./status-strip-state.ts";
