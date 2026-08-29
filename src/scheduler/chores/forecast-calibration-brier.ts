/**
 * Forecast-calibration-brier leading-outcome producer chore (issue #1657).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

import { publishForecastCalibrationBrierMetric } from "../../metrics/publish.ts";

/** External touchpoints of the forecast-calibration-brier chore. */
export interface ForecastCalibrationBrierDeps {
  publishBrierMetric?: () => Promise<{ ok: boolean }>;
}

/**
 * Forecast-calibration-brier leading-outcome producer (issue #1657) — samples
 * the target's aggregate Brier score and publishes it to
 * metrics/forecast-calibration-brier.txt for the outcomes file adapter. The
 * producer itself never throws and never writes on failure, so "ran" here means
 * "sampled", not necessarily "wrote". Hourly re-publish of the same current
 * value is idempotent, so no Redis time-guard is needed.
 *
 * Since issue #4247 (hydra-betting ADR-0007 D5) the SAME sample also publishes
 * one sibling file per league reported in the target's `bySourceLeague` map
 * (metrics/forecast-calibration-brier-<league>.txt — see
 * `publishPerLeagueBrierFiles` in src/metrics/publish.ts). The aggregate file
 * keeps flowing unchanged as a display number; Outcome Holdback no longer keys
 * on it (excluded via src/holdback-policy.ts) — the per-league siblings carry
 * the holdback signal instead. This chore stays a thin delegate: the per-league
 * logic lives with the rest of the producer's fetch/write policy.
 */
export async function runForecastCalibrationBrier(
  deps: ForecastCalibrationBrierDeps = {},
): Promise<void> {
  const publishBrier = deps.publishBrierMetric ?? publishForecastCalibrationBrierMetric;
  await publishBrier();
}
