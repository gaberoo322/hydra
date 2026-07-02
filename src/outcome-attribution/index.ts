/**
 * Outcome-attribution spine barrel (issue #2629, epic #2628).
 *
 * Public surface of the attribution spine: the raw observation type + ledger
 * seam (from `src/redis/attribution.ts`), the window recorder policy (from
 * `./recorder.ts`), and the ridge marginal-effect estimator (#2630, from
 * `./estimator.ts`). Later slices layer on top: the read-only `/api/attribution`
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

export type {
  ClassEffect,
  MetricEstimate,
  AttributionEstimate,
} from "./estimator.ts";
export {
  estimateMarginalEffects,
  solveRidge,
  gaussianSolve,
  populationStd,
  RIDGE_LAMBDA,
  NOISE_FLOOR_K,
  LOW_VARIANCE_EPS,
  COLLINEARITY_THRESHOLD,
} from "./estimator.ts";
