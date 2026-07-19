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
import { logger } from "../logger.ts";
import {
  getDigestLastWeekly,
  getMemoryLastConsolidation,
  getCleanupLastDaily,
  getUsageSnapshotLastWeekly,
} from "../redis/housekeeping.ts";
import type { PublishableBus } from "../event-bus-seams.ts";

import { runReviewPickupNotify } from "./chores/review-pickup-notify.ts";
import { runWeeklyDigest } from "./chores/weekly-digest.ts";
import { runMemoryConsolidation } from "./chores/memory-consolidation.ts";
import { runDesignConceptSnapshot } from "./chores/design-concept-snapshot.ts";
import { runForecastCalibrationBrier } from "./chores/forecast-calibration-brier.ts";
import { pruneStaleRedisKeys } from "./chores/stale-key-prune.ts";
import { runWorktreeOrphanPrune } from "./chores/worktree-orphan-prune.ts";
import { runSkillCatalogReregister } from "./chores/skill-catalog-reregister.ts";
import { runWiringLiveness } from "./chores/wiring-liveness.ts";
import { runUsageWeeklySnapshot } from "./chores/usage-weekly-snapshot.ts";
import { runHoldbackMergeWatch } from "./chores/holdback-merge-watch.ts";
import { runCycleMergeReconcile } from "./chores/cycle-merge-reconcile.ts";
import { runPatternCueDemotion } from "./chores/pattern-cue-demotion.ts";
import { runAttributionRecord } from "../outcome-attribution/index.ts";

// ---------------------------------------------------------------------------
// Re-exports (issue #2090): keep the pre-split public surface stable so
// existing importers (tests, sibling modules) need no change. The chore
// runners now live in `./chores/<name>.ts`; this file re-exports the runners
// so `from "../scheduler/housekeeping.ts"` keeps resolving. The per-chore
// `*Deps` interfaces are NOT re-exported here — no module imports them from
// housekeeping.ts; each chore's deps type is consumed only inside its own
// `./chores/<name>.ts` source (stale re-exports removed, issue #2105).
// ---------------------------------------------------------------------------
export { runReviewPickupNotify } from "./chores/review-pickup-notify.ts";
export { runWeeklyDigest } from "./chores/weekly-digest.ts";
export { runMemoryConsolidation } from "./chores/memory-consolidation.ts";
export { runDesignConceptSnapshot } from "./chores/design-concept-snapshot.ts";
export { runForecastCalibrationBrier } from "./chores/forecast-calibration-brier.ts";
export { pruneStaleRedisKeys } from "./chores/stale-key-prune.ts";
export { runSkillCatalogReregister } from "./chores/skill-catalog-reregister.ts";

// ---------------------------------------------------------------------------
// Cadence constants (issue #2461)
// ---------------------------------------------------------------------------
//
// Module-private named constants so the cadence guards in `runHousekeeping`
// read `WEEK_MS`/`DAY_MS` instead of computing `7 * 24 * 60 * 60 * 1000`
// inline. Previously `export`ed (issue #2461) on the theory that chore files
// and tests would reference them, but no module ever imported them from this
// path — the chore files receive their guard period as a `choreGuard(getter,
// periodMs)` argument composed here, so the `export` was dead surface (issue
// #2469). Re-export them only if a future chore file genuinely needs the values.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Canonical cadence-check for a time-guarded chore (issue #2461).
 *
 * Reads the last-run timestamp from `getLastTs()` and returns `true` when the
 * chore should proceed: either no prior run is recorded, or `periodMs` has
 * elapsed since the last run. Centralises the `!lastTs || now() -
 * parseInt(lastTs) >= periodMs` pattern that was previously spelled out inline
 * in every guard lambda.
 *
 * Both dependencies are injected — the Redis timestamp read (`getLastTs`) and
 * the clock (`now`, defaulting to `Date.now`). That makes the cadence predicate
 * pure time-arithmetic over injected inputs: a test can pass a stub `getLastTs`
 * (return `null` = always-run, a stale epoch string = guard passes, a fresh
 * epoch string = guard blocks) and a frozen `now` and assert the windowing
 * decision without a Redis fixture (issue #3091). Exported for that unit
 * coverage (mirroring `runChore`); its production callers are the guard lambdas
 * in `runHousekeeping`.
 */
async function choreGuard(
  getLastTs: () => Promise<string | null>,
  periodMs: number,
  now: () => number = Date.now,
): Promise<boolean> {
  const lastTs = await getLastTs();
  return !lastTs || now() - parseInt(lastTs) >= periodMs;
}

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
 * Never throws: a chore that throws is logged (`logger.error`), recorded as a
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
    logger.error({ err, chore: chore.name }, "housekeeping chore failed");
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
    /**
     * Injectable cadence-guard Redis readers + clock (issue #3091). Each of the
     * four time-windowed chores (`weekly-summary`, `usage-weekly-snapshot`,
     * `memory-consolidation`, `stale-key-prune`) reads its last-run timestamp
     * through one of these getters, defaulting to the real
     * `src/redis/housekeeping.ts` accessor. Injecting a stub reader (return
     * `null` = always-run, a stale epoch string = guard passes, a fresh epoch
     * string = guard blocks) plus a frozen `now` lets a test assert the
     * guard-windowing decision — "skipped because the window has not elapsed"
     * vs. "ran because it has" — without standing up Redis. Making the readers
     * visible here also turns the module's Interface into an honest statement of
     * what the registry depends on externally (previously they were hidden
     * module-level imports).
     */
    getDigestLastWeekly?: () => Promise<string | null>;
    getUsageSnapshotLastWeekly?: () => Promise<string | null>;
    getMemoryLastConsolidation?: () => Promise<string | null>;
    getCleanupLastDaily?: () => Promise<string | null>;
    /** Injectable clock for the cadence guards; defaults to `Date.now`. */
    now?: () => number;
  } = {},
): Promise<{ ran: string[]; skipped: string[] }> {
  const ran: string[] = [];
  const skipped: string[] = [];

  // The chores as declarations. Each carries an optional `guard` (the cadence
  // window, read at the composition level) and a `work` thunk that delegates to
  // the chore's named runner imported from `./chores/`. `runChore` applies the
  // uniform guard → work → bookkeeping → error-log + Sentry-breadcrumb pattern.
  // Order is preserved verbatim from the pre-#2090 sequence.
  //
  // Issue #2461: guards now use `choreGuard(getter, periodMs)` — a single
  // canonical cadence-check — instead of the repeated inline
  // `!lastTs || Date.now() - parseInt(lastTs) >= periodMs` pattern. Period
  // constants (`WEEK_MS`, `DAY_MS`) are module-private consts hoisted above
  // `runHousekeeping` so the guards read a named cadence instead of inline math.
  //
  // Issue #3091: each cadence guard reads its Redis timestamp getter (and the
  // clock) through `deps.<getter> ?? <import>` / `deps.now`, so the four
  // time-windowed chores are testable without Redis. The default preserves all
  // production behaviour — a caller that passes no cadence deps binds the real
  // `src/redis/housekeeping.ts` accessors and `Date.now` exactly as before.
  const chores: Chore[] = [
    {
      name: "review-pickup-notify",
      work: async () => {
        await runReviewPickupNotify(eventBus);
      },
    },

    {
      name: "weekly-summary",
      guard: () =>
        choreGuard(deps.getDigestLastWeekly ?? getDigestLastWeekly, WEEK_MS, deps.now),
      work: () => runWeeklyDigest(),
    },

    {
      // Issue #2404: persist this ISO week's per-skill usage rollup so the
      // week-over-week trend has a prior week to compare against. Weekly cadence
      // guard (mirroring weekly-summary); the underlying write is idempotent on
      // the ISO-week key.
      // Issue #2461: the success stamp is now applied inside
      // `runUsageWeeklySnapshot` itself (consistent with `runWeeklyDigest` and
      // `runMemoryConsolidation`) — no stamp call at the registry level.
      name: "usage-weekly-snapshot",
      guard: () =>
        choreGuard(deps.getUsageSnapshotLastWeekly ?? getUsageSnapshotLastWeekly, WEEK_MS, deps.now),
      work: () => runUsageWeeklySnapshot(),
    },

    {
      name: "memory-consolidation",
      guard: () =>
        choreGuard(deps.getMemoryLastConsolidation ?? getMemoryLastConsolidation, DAY_MS, deps.now),
      work: () => runMemoryConsolidation(),
    },

    {
      name: "design-concept-snapshot",
      work: () => runDesignConceptSnapshot(),
    },

    {
      name: "forecast-calibration-brier",
      work: () => runForecastCalibrationBrier({ publishBrierMetric: deps.publishBrierMetric }),
    },

    {
      // Issue #2461: the success stamp is now applied inside
      // `pruneStaleRedisKeys` itself (consistent with `runWeeklyDigest` and
      // `runMemoryConsolidation`) — no stamp call at the registry level.
      name: "stale-key-prune",
      guard: () =>
        choreGuard(deps.getCleanupLastDaily ?? getCleanupLastDaily, DAY_MS, deps.now),
      work: () => pruneStaleRedisKeys(),
    },

    {
      // Issue #3136: periodic reclaim of orphaned /dev/shm target worktrees.
      // `pruneOrphanedTargetWorktrees` previously ran ONLY at boot (src/index.ts),
      // so a mid-cycle crash that leaves a worktree pinning its
      // `feature/claude-cycle-*` branch survived between restarts and made the
      // branch-cleanup path fail on every tick. No Redis time-guard — the prune
      // is intrinsically idempotent (only worktrees classified
      // `delete-orphan-worktree` are removed; the 6h age floor + live-agent guard
      // protect in-flight dispatches), so an hourly tick against an all-clean set
      // is a silent no-op. Never throws — the chore wraps the already
      // best-effort pruner and folds any fault to a logged 0.
      name: "worktree-orphan-prune",
      work: async () => {
        await runWorktreeOrphanPrune();
      },
    },

    {
      // Issue #2148: post-startup recovery for the OV skill catalog. No Redis
      // time-guard — the chore's own work is intrinsically idempotent (it skips
      // unless the catalog is genuinely short AND OpenViking is live again), so
      // an hourly tick against a healthy catalog is a guaranteed no-op.
      name: "skill-catalog-reregister",
      work: () => runSkillCatalogReregister(),
    },

    {
      // Issue #2287: wiring-liveness. No Redis time-guard — the chore is
      // intrinsically idempotent (it reads the manifest + live timer set and
      // only logs when a declared timer is missing or stale), so an hourly tick
      // against an all-present/all-fresh set is a guaranteed silent no-op. Never
      // throws — load/probe failures route to a logged result object.
      name: "wiring-liveness",
      work: async () => {
        await runWiringLiveness();
      },
    },

    {
      // Issue #2632: outcome-attribution recorder. Reacts to merge LANDINGS off
      // the same pending-enroll substrate as holdback-merge-watch — opens a
      // per-metric window on landing, closes each on its own configured duration
      // (appending an observation row), and voids reverted merges. No Redis
      // time-guard — intrinsically idempotent (windows are upserted by
      // metric+merge id; closes/voids are drained and removed), so an hourly
      // tick with nothing due is a guaranteed no-op. Never throws — every
      // failure is logged with the [attribution] prefix and counted, not raised.
      // This is the sanctioned periodic-job substrate for the recorder, NOT a
      // long-lived EventBus consumer (ADR-0010/0012).
      //
      // Issue #3113: MUST run BEFORE holdback-merge-watch. Both chores read the
      // same pending-enroll registry (`pendingEnrollList`), but the recorder only
      // READS it (opening attribution windows for landed merges) while
      // holdback-merge-watch REMOVES each landed PR (`removePending`). When the
      // watch ran first it drained the registry to empty before the recorder read
      // it, so the recorder's OPEN phase always saw an empty list and no
      // attribution window ever opened — the ledger stayed dark despite live
      // holdback baselines. Placing the read-only recorder ahead of the
      // registry-draining watch closes that ordering gap; the recorder never
      // mutates the registry, so the watch still sees every landed PR after.
      name: "attribution-record",
      work: async () => {
        await runAttributionRecord();
      },
    },

    {
      // Issue #2623: merge-completion watcher. No Redis time-guard — the chore
      // is intrinsically idempotent (it consumes the pending-enroll registry and
      // guards each PR's enroll + cycle-record enrichment behind a per-PR marker,
      // so an hourly tick against a landed-and-processed / all-still-open set is a
      // guaranteed no-op). Never throws — per-PR gh/API failures are logged and
      // the entry is retried next tick.
      //
      // Issue #3113: runs AFTER attribution-record (above) — this chore calls
      // `removePending` for each landed PR, draining the pending-enroll registry
      // the read-only recorder depends on, so the recorder must read first.
      name: "holdback-merge-watch",
      work: async () => {
        await runHoldbackMergeWatch();
      },
    },

    {
      // Issue #2860: cycle-record merged-status reconciliation BACKSTOP — the
      // second layer of the merged-status enrichment path, sibling to
      // holdback-merge-watch. It scans recent `status=completed` cycle records
      // carrying a prNumber, confirms the PR merged via `gh pr view`, and re-posts
      // through recordCycle to perform the `completed→merged` upgrade (bumping the
      // metrics tasksMerged without re-firing any lifetime counter). This
      // self-heals cycles the primary merge-watch path missed — PRs that were
      // never armed into the pending-enroll registry (a dropped POST / crash
      // mid-arm), the dominant failure that left 0/50 recent cycles with
      // tasksMerged>0 despite merging. No Redis time-guard — intrinsically
      // idempotent (an upgraded record no longer matches the `completed` filter),
      // and bounded per-tick (scanLimit records, confirmLimit gh calls) so a
      // historical backlog drains gradually. Never throws — per-PR gh failures
      // are logged and retried next tick.
      name: "cycle-merge-reconcile",
      work: async () => {
        await runCycleMergeReconcile();
      },
    },

    {
      // Issue #3340: pattern-cue demotion on issue RESOLUTION — the inverse of
      // the escalation path (#512). Polls recently-closed meta-friction issues,
      // reverse-maps each to its cue, and demotes the matched friction pattern's
      // hit count so a solved-and-closed issue is not re-filed by the next hit.
      // No Redis time-guard — intrinsically idempotent via a per-issue processed
      // marker, so an hourly tick against an all-processed set is a no-op. Placed
      // LAST so any same-hour escalation write (driven by recordPattern via the
      // subagent-friction POST path) has committed before the demotion reads the
      // closed-issue set. Never throws — the underlying pass returns a result
      // object and this chore folds any fault to a logged 0.
      name: "pattern-cue-demotion",
      work: async () => {
        await runPatternCueDemotion();
      },
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
  // Issue #3091: the canonical cadence-check, exported so a unit test can assert
  // the guard-windowing decision (null → always-run, stale ts → passes, fresh
  // ts → blocks) as pure time-arithmetic over an injected getter + frozen clock,
  // without a Redis fixture.
  choreGuard,
};
