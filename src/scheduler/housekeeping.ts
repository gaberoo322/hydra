/**
 * Housekeeping
 *
 * The periodic, non-decisional maintenance chores that run hourly in the
 * orchestrator process, surfaced by `POST /api/maintenance/housekeeping` which
 * the host-local `hydra-housekeeping.timer` triggers. This Module is a SIBLING
 * of the **Observability Heartbeat** (`src/scheduler/heartbeat.ts`), not part
 * of it: the Heartbeat records *what happened* (counters, liveness,
 * merge-rate); Housekeeping *performs* periodic maintenance.
 *
 * Both are non-decisional — the **Autopilot Run** (`scripts/autopilot/decide.py`)
 * owns all decisions about *what to do* (ADR-0012: "scheduler is bookkeeping;
 * autopilot is decisions"). Splitting the chores out of `heartbeat.ts`
 * (issue #938) keeps each Module's name a true description of its body: the
 * Heartbeat's "strictly observability-and-counters only" contract is no longer
 * contradicted by chore code sharing the same file.
 *
 * Issue #2090: each chore now lives in its own focused file under
 * `src/scheduler/chores/<name>.ts` — each owns its deps interface, its exported
 * runner, and any private helpers. THIS file is the thin **registry**: it
 * imports every chore runner, owns the `Chore` type + `runChore` (the uniform
 * guard → work → bookkeeping → error-log + Sentry-breadcrumb wrapper), and
 * sequences them in `runHousekeeping`. The `{ ran, skipped }` composition
 * contract is unchanged. The chore set is:
 *   - blocked-item re-escalation (+ its operator unblock-command builder),
 *   - the `/hydra-review` pickup-set edge-triggered phone-notify,
 *   - done-lane pruning,
 *   - the weekly Telegram digest,
 *   - daily memory consolidation,
 *   - the daily design-concept snapshot,
 *   - work-queue hygiene,
 *   - the merge→done reconciler,
 *   - the forecast-calibration-brier leading-outcome producer (#1657),
 *   - the stale-Redis-key sweep + stale-inProgress return (#1876),
 *   - the lane-index reconciler (#2056).
 *
 * Each chore carries its own Redis time-guard (per-item / daily / weekly), so
 * an hourly invocation is idempotent — a chore whose window has not elapsed is
 * skipped. The daily/weekly cadence guards are read here at the composition
 * level (the chore bodies stamp their own success keys); the per-item guards
 * live inside the chore bodies. The Module's Interface is the `{ ran, skipped }`
 * summary: a single Seam reporting which chores did work this invocation.
 */

import * as Sentry from "@sentry/node";
import {
  getDigestLastWeekly,
  getMemoryLastConsolidation,
  getCleanupLastDaily,
  setCleanupLastDaily,
} from "../redis/housekeeping.ts";
import type { PublishableBus } from "../api/event-bus-types.ts";

import { runBlockedItemEscalation } from "./chores/blocked-escalation.ts";
import { runReviewPickupNotify } from "./chores/review-pickup-notify.ts";
import { runDoneLanePrune } from "./chores/done-lane-prune.ts";
import { runWeeklyDigest } from "./chores/weekly-digest.ts";
import { runMemoryConsolidation } from "./chores/memory-consolidation.ts";
import { runDesignConceptSnapshot } from "./chores/design-concept-snapshot.ts";
import { runWorkQueueHygiene } from "./chores/work-queue-hygiene.ts";
import { runMergedItemReconciler } from "./chores/merged-item-reconciler.ts";
import { runForecastCalibrationBrier } from "./chores/forecast-calibration-brier.ts";
import { pruneStaleRedisKeys } from "./chores/stale-key-prune.ts";
import { returnStaleInProgressItems } from "./chores/stale-inprogress-return.ts";
import { runLaneIndexReconcile } from "./chores/lane-index-reconcile.ts";
import { runSkillCatalogReregister } from "./chores/skill-catalog-reregister.ts";

// ---------------------------------------------------------------------------
// Re-exports (issue #2090): keep the pre-split public surface stable so
// existing importers (tests, sibling modules) need no change. The chore
// runners now live in `./chores/<name>.ts`; this file re-exports the runners
// so `from "../scheduler/housekeeping.ts"` keeps resolving. The per-chore
// `*Deps` interfaces are NOT re-exported here — no module imports them from
// housekeeping.ts; each chore's deps type is consumed only inside its own
// `./chores/<name>.ts` source (stale re-exports removed, issue #2105).
// ---------------------------------------------------------------------------
export { runBlockedItemEscalation } from "./chores/blocked-escalation.ts";
export { runReviewPickupNotify, checkReviewPickupNotify } from "./chores/review-pickup-notify.ts";
export { runDoneLanePrune } from "./chores/done-lane-prune.ts";
export { runWeeklyDigest } from "./chores/weekly-digest.ts";
export { runMemoryConsolidation } from "./chores/memory-consolidation.ts";
export { runDesignConceptSnapshot } from "./chores/design-concept-snapshot.ts";
export { runWorkQueueHygiene } from "./chores/work-queue-hygiene.ts";
export { runForecastCalibrationBrier } from "./chores/forecast-calibration-brier.ts";
export { pruneStaleRedisKeys } from "./chores/stale-key-prune.ts";
export { returnStaleInProgressItems } from "./chores/stale-inprogress-return.ts";
export { runSkillCatalogReregister } from "./chores/skill-catalog-reregister.ts";

// ---------------------------------------------------------------------------
// Chore runner (issue #1864)
// ---------------------------------------------------------------------------
//
// Every housekeeping chore repeats the same 5-part shape: optional time-guard
// → work → success bookkeeping (`ran.push`) → error log + Sentry breadcrumb →
// failure bookkeeping (`skipped.push`). Spelling that shape inline 9 times let
// the parts drift — two chores (blocked-escalation, review-pickup-notify) were
// missing their Sentry breadcrumb, and a chore author could silently mis-report
// a chore as skipped by forgetting `ran.push`.
//
// `runChore` encapsulates the pattern so each chore becomes a thin declaration
// (name, optional guard, work) and inherits the error log, the Sentry
// breadcrumb, and the ran/skipped bookkeeping uniformly. A new chore added to
// the registry gets all of that operational hygiene for free.

/**
 * A single housekeeping chore declaration.
 *
 * - `guard` (optional) is the time-window / cadence check. It returns `false`
 *   when the chore should be skipped without running its work (the
 *   weekly/daily idempotency window has not elapsed). A chore with no `guard`
 *   always proceeds to `work` (its idempotency lives inside `work`, e.g. a
 *   per-item Redis stamp).
 * - `work` performs the chore. Returning `false` signals the chore decided at
 *   runtime not to do anything (e.g. the design-concept snapshot whose stored
 *   value is already up to date) — the runner routes that to `skipped` exactly
 *   as a `guard` miss would. Returning `void`/`true` counts as `ran`.
 */
interface Chore {
  name: string;
  guard?: () => Promise<boolean>;
  work: () => Promise<boolean | void>;
}

/**
 * Run one chore through the uniform guard → work → bookkeeping → error-log
 * pattern, appending its name to `ran` or `skipped` accordingly.
 *
 * Never throws: a chore that throws is logged (`console.error`), recorded as a
 * Sentry breadcrumb, and routed to `skipped` so one failure doesn't abort the
 * remaining chores. This is the single place the error format + Sentry
 * breadcrumb live, so a change applies to all chores at once.
 *
 * Exported for unit coverage — a test can inject a failing `work` thunk and
 * assert the runner logs + skips without aborting, with no Redis or HTTP
 * endpoint stood up.
 */
async function runChore(
  chore: Chore,
  ran: string[],
  skipped: string[],
): Promise<void> {
  try {
    if (chore.guard && !(await chore.guard())) {
      skipped.push(chore.name);
      return;
    }
    const result = await chore.work();
    if (result === false) {
      skipped.push(chore.name);
      return;
    }
    ran.push(chore.name);
  } catch (err: any) {
    console.error(`[Housekeeping] ${chore.name} failed: ${err.message}`);
    Sentry.addBreadcrumb({
      category: "scheduler",
      message: `${chore.name} failed: ${err.message}`,
      level: "error",
    });
    skipped.push(chore.name);
  }
}

/**
 * Run the time-boxed housekeeping chores.
 *
 * Issue #723 (scheduler fold PR-3/4): these chores were extracted out of
 * `runScheduledCycle` so they can be driven externally by an hourly
 * `hydra-housekeeping.timer` POSTing to `/api/maintenance/housekeeping`,
 * rather than riding on the 5-minute scheduler heartbeat. They still run
 * IN the orchestrator process (they use the live `eventBus` + dynamic
 * imports), so the endpoint approach reuses the running process rather than
 * reconstructing eventBus/Redis in a standalone job.
 *
 * Issue #938: these chores (and their helpers) were moved out of
 * `heartbeat.ts` into this dedicated **Housekeeping** Module so the
 * **Observability Heartbeat** stays genuinely observability-only.
 *
 * Issue #1864: the bespoke try/catch blocks were collapsed to `Chore`
 * declarations driven by `runChore`, so the guard → work → bookkeeping →
 * error-log + Sentry-breadcrumb pattern lives in exactly one place.
 *
 * Issue #2067: each chore's *work* was made a named exported function accepting
 * only its own deps subset, defaulting to the real implementation.
 *
 * Issue #2090: each chore moved into its own focused file under
 * `src/scheduler/chores/`. `runHousekeeping` stays the composition owner — it
 * imports each chore runner, sequences them in the same order, applies the same
 * Redis time-guards (still read here at the composition level), and wraps each
 * through `runChore`. Behaviour is unchanged.
 *
 * Returns a `{ ran, skipped }` summary so callers (the endpoint, tests) can
 * see which chores did work this invocation vs. which were skipped by their
 * time-guard. Never throws — each chore is independently run through
 * `runChore`, which try/catches so one failure doesn't abort the rest.
 */
async function runHousekeeping(
  eventBus: PublishableBus,
  deps: {
    /**
     * Injectable forecast-calibration-brier producer (issue #1657) so the
     * wiring test runs without a live hydra-betting target. Defaults to the
     * real `publishForecastCalibrationBrierMetric` from `src/metrics/publish.ts`.
     */
    publishBrierMetric?: () => Promise<{ ok: boolean }>;
  } = {},
): Promise<{ ran: string[]; skipped: string[] }> {
  const ran: string[] = [];
  const skipped: string[] = [];

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // The chores as declarations. Each carries an optional `guard` (the cadence
  // window, read at the composition level) and a `work` thunk that delegates to
  // the chore's named runner imported from `./chores/`. `runChore` applies the
  // uniform guard → work → bookkeeping → error-log + Sentry-breadcrumb pattern.
  // Order is preserved verbatim from the pre-#2090 sequence.
  const chores: Chore[] = [
    {
      name: "blocked-escalation",
      work: () => runBlockedItemEscalation(eventBus),
    },

    {
      name: "review-pickup-notify",
      work: async () => {
        await runReviewPickupNotify(eventBus);
      },
    },

    {
      name: "prune-done",
      work: () => runDoneLanePrune(),
    },

    {
      name: "weekly-summary",
      guard: async () => {
        const lastWeekly = await getDigestLastWeekly();
        return !lastWeekly || Date.now() - parseInt(lastWeekly) >= WEEK_MS;
      },
      work: () => runWeeklyDigest(),
    },

    {
      name: "memory-consolidation",
      guard: async () => {
        const lastConsolidation = await getMemoryLastConsolidation();
        return !lastConsolidation || Date.now() - parseInt(lastConsolidation) >= DAY_MS;
      },
      work: () => runMemoryConsolidation(),
    },

    {
      name: "design-concept-snapshot",
      work: () => runDesignConceptSnapshot(),
    },

    {
      name: "work-queue-hygiene",
      work: () => runWorkQueueHygiene(),
    },

    {
      name: "merged-item-reconciler",
      work: () => runMergedItemReconciler(),
    },

    {
      name: "forecast-calibration-brier",
      work: () => runForecastCalibrationBrier({ publishBrierMetric: deps.publishBrierMetric }),
    },

    {
      name: "stale-key-prune",
      guard: async () => {
        const lastDaily = await getCleanupLastDaily();
        return !lastDaily || Date.now() - parseInt(lastDaily) >= DAY_MS;
      },
      work: async () => {
        await pruneStaleRedisKeys();
        await setCleanupLastDaily(Date.now().toString());
      },
    },

    {
      name: "stale-inprogress-return",
      work: () => returnStaleInProgressItems(),
    },

    {
      name: "lane-index-reconcile",
      work: () => runLaneIndexReconcile(),
    },

    {
      // Issue #2148: post-startup recovery for the OV skill catalog. No Redis
      // time-guard — the chore's own work is intrinsically idempotent (it skips
      // unless the catalog is genuinely short AND OpenViking is live again), so
      // an hourly tick against a healthy catalog is a guaranteed no-op.
      name: "skill-catalog-reregister",
      work: () => runSkillCatalogReregister(),
    },
  ];

  for (const chore of chores) {
    await runChore(chore, ran, skipped);
  }

  return { ran, skipped };
}

export {
  runHousekeeping,
  // Issue #1864: the extracted guarded-chore runner, exported so a unit test
  // can inject a failing / guard-skipping / work-skipping chore thunk and
  // assert the uniform guard → work → bookkeeping → error-log + Sentry
  // pattern without standing up the maintenance endpoint or Redis.
  runChore,
  // Issue #2057: exported so a unit test can inject the reconciler result + a
  // fake `setReconcilerHealth` and assert the last-run health snapshot is
  // persisted (feed liveness + batch metrics) without standing up Redis.
  runMergedItemReconciler,
};
