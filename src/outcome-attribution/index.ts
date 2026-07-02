/**
 * Outcome-attribution spine barrel (issue #2629, epic #2628).
 *
 * Public surface of the attribution spine: the raw observation type + ledger
 * seam (from `src/redis/attribution.ts`), the window recorder policy (from
 * `./recorder.ts`), the per-metric window state machine (`./windows.ts`, #2632),
 * and the live merge-landing recorder chore (`./subscribe.ts`, #2632). The
 * read-only `/api/attribution` view (#2631) layers on top of these types.
 */

export type {
  AttributionObservation,
  VoidMarker,
  LedgerRow,
  AttributionWindow,
  RevertedMerge,
  AttributionLedger,
  AppendObservationResult,
  LoadObservationsResult,
  LoadLedgerResult,
} from "../redis/attribution.ts";
export {
  appendObservation,
  appendVoidMarker,
  getObservations,
  getLedger,
  isVoidMarker,
  redisAttributionLedger,
  attributionLedgerKey,
  // Open-window state (#2632).
  openWindow,
  listOpenWindows,
  closeWindow,
  attributionWindowsKey,
  // Reverted-merge registry (#2632).
  markMergeReverted,
  listRevertedMerges,
  removeRevertedMerge,
  attributionRevertedKey,
} from "../redis/attribution.ts";

export type { WindowContext, RecordWindowResult } from "./recorder.ts";
export { deriveObservations, recordWindow } from "./recorder.ts";

// Per-metric window state machine (#2632).
export type { MergeWindowContext, DueWindows } from "./windows.ts";
export {
  windowDurationMs,
  windowId,
  buildWindowsForMerge,
  dueWindows,
  ATTRIBUTION_DEFAULT_WINDOW_MS,
} from "./windows.ts";

// Live merge-landing recorder chore (#2632).
export type {
  AttributionRecordDeps,
  AttributionRecordResult,
  MergeStatus,
} from "./subscribe.ts";
export { runAttributionRecord, producerClassFromCycleId } from "./subscribe.ts";
