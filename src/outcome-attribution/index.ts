/**
 * Outcome-attribution spine barrel (issue #2629, epic #2628).
 *
 * Public surface of the attribution spine: the raw observation type + ledger
 * seam (from `src/redis/attribution.ts`) and the window recorder policy (from
 * `./recorder.ts`). Later slices layer on top: the read-only `/api/attribution`
 * view (#2631) and live-event subscription + window scheduling (#2632).
 */

export type {
  AttributionObservation,
  AttributionLedger,
  AppendObservationResult,
  LoadObservationsResult,
} from "../redis/attribution.ts";
export {
  appendObservation,
  getObservations,
  redisAttributionLedger,
  attributionLedgerKey,
} from "../redis/attribution.ts";

export type { WindowContext, RecordWindowResult } from "./recorder.ts";
export { deriveObservations, recordWindow } from "./recorder.ts";
