/**
 * Forecast-calibration-brier leading-outcome producer chore (issue #1657).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 *
 * Since issue #4247 (ADR-0007 D5) one invocation publishes TWO shapes from a
 * single target fetch: the legacy sport-blind aggregate scalar to
 * metrics/forecast-calibration-brier.txt (unchanged contract for its existing
 * readers — it is now display-only for Outcome Holdback, excluded via
 * HOLDBACK_UNWATCHABLE_OUTCOMES) and one per-league sibling file under
 * metrics/forecast-calibration-brier-league/ for the per-league replacement
 * outcomes declared in config/direction/outcomes.yaml. Both live in
 * `publishForecastCalibrationBrierMetric`; this chore stays the thin
 * Housekeeping wrapper.
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
 */
export async function runForecastCalibrationBrier(
  deps: ForecastCalibrationBrierDeps = {},
): Promise<void> {
  const publishBrier = deps.publishBrierMetric ?? publishForecastCalibrationBrierMetric;
  await publishBrier();
}
