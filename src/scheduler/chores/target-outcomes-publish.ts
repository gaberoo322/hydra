/**
 * Target outcomes publish chore (issue #4477).
 *
 * Thin housekeeping delegate over `publishTargetOutcomeMetrics`
 * (`src/metrics/publish.ts`), which samples the Target's `GET /api/outcomes`
 * and writes each declared `file` outcome's value to its `metrics/...` path so
 * the Outcomes loader and Tier-2 Outcome Holdback can read it.
 *
 * This file owns only the LOGGING policy:
 *   - a whole-sample failure (Target unreachable, non-2xx, malformed body,
 *     outcomes.yaml unloadable) is logged ONCE per failure streak — on the
 *     transition into failure; consecutive failures are silent; the next
 *     successful sample resets the streak and logs one recovery line;
 *   - a declared outcome missing from the response logs one aggregated warn
 *     per run.
 *
 * Streak state is process-local (a restart legitimately re-logs once) and held
 * in an injectable state object so tests can reset it. No Redis time-guard —
 * the housekeeping timer is already hourly and republishing the current value
 * is idempotent. Never throws.
 */

import { logger } from "../../logger.ts";
import {
  publishTargetOutcomeMetrics,
  type TargetOutcomesPublishResult,
} from "../../metrics/publish.ts";

/** Process-local failure-streak state. */
export interface TargetOutcomesPublishState {
  /** True while the most recent sample failed. */
  failing: boolean;
}

/** Create a fresh (non-failing) streak state. */
export function createTargetOutcomesPublishState(): TargetOutcomesPublishState {
  return { failing: false };
}

const defaultState: TargetOutcomesPublishState = createTargetOutcomesPublishState();

export interface TargetOutcomesPublishChoreDeps {
  /** The publisher. Defaults to the real `publishTargetOutcomeMetrics`. */
  publish?: () => Promise<TargetOutcomesPublishResult>;
  /** Streak state. Defaults to a module-level singleton. */
  state?: TargetOutcomesPublishState;
}

/**
 * Run one Target outcomes sample. Returns the publisher result (or a synthetic
 * `fetch-failed` result if the publisher itself threw). Never throws.
 */
export async function runTargetOutcomesPublish(
  deps: TargetOutcomesPublishChoreDeps = {},
): Promise<TargetOutcomesPublishResult> {
  const publish = deps.publish ?? (() => publishTargetOutcomeMetrics());
  const state = deps.state ?? defaultState;

  let result: TargetOutcomesPublishResult;
  try {
    result = await publish();
  } catch (err: any) {
    result = { ok: false, reason: "fetch-failed", detail: err?.message || String(err), url: "" };
  }

  if (result.ok === false) {
    const failure = result as Extract<TargetOutcomesPublishResult, { ok: false }>;
    if (!state.failing) {
      logger.error(
        { reason: failure.reason, url: failure.url, detail: failure.detail },
        "[target-outcomes-publish] target outcomes sample failed — nothing written (further consecutive failures are silent)",
      );
    }
    state.failing = true;
    return result;
  }

  if (state.failing) {
    logger.info(
      { written: result.written.length, nulls: result.nulls.length },
      "[target-outcomes-publish] target outcomes sample recovered",
    );
  }
  state.failing = false;

  if (result.missing.length > 0) {
    logger.warn(
      { missing: result.missing },
      "[target-outcomes-publish] declared outcomes absent from the target response — not written",
    );
  }

  return result;
}
