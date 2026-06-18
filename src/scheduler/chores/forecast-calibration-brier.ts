/**
 * Forecast-calibration-brier leading-outcome producer chore (issue #1657).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

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
 */
export async function runForecastCalibrationBrier(
  deps: ForecastCalibrationBrierDeps = {},
): Promise<void> {
  const publishBrier =
    deps.publishBrierMetric ?? (await import("../../metrics/publish.ts")).publishForecastCalibrationBrierMetric;
  await publishBrier();
}
