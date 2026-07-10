/**
 * Autopilot status seam — one read-model composition of "what is the autopilot
 * doing right now" (issue #2673).
 *
 * Three HTTP surfaces independently re-derive overlapping projections of the
 * SAME underlying autopilot facts:
 *
 *   - `src/api/now-page.ts`          (`GET /api/v2/now/autopilot-tick`)
 *       scheduler heartbeat → lastTickAt, currentRun projection, lifecycle.
 *   - `src/api/autopilot-idle.ts`    (`GET /api/autopilot/idle-diagnostics`)
 *       lifecycle (liveness), usage-eligibility pacing projection.
 *   - `src/aggregators/autopilot-health.ts` (`GET /api/now/autopilot-health`)
 *       the live run view + the recent run-history window + os-heartbeat age.
 *
 * The ONLY source shared by all three is `getCurrentLifecycle()`; the rest is
 * per-site. So this seam exposes OVERLAPPING PROJECTIONS over one lazily-composed
 * snapshot, NOT a unified response shape. Each call site maps only the slice it
 * needs into its own response type — the seam does not force one site to pay for
 * another's fan-out.
 *
 * # Design contract — the deps-injectable / never-throw aggregator contract of
 * `src/aggregators/builder-health.ts` and `active-dispatches.ts`.
 *
 * - **Never throws.** Every sub-source runs under `Promise.allSettled` and
 *   degrades to a safe default (idle lifecycle, null run, on-pace eligibility,
 *   empty history). A rejected sub-read logs `console.error` with context
 *   (CLAUDE.md fail-loud) and contributes its default. The public entrypoint
 *   cannot throw.
 * - **Readers injectable.** Every underlying reader lives in `deps` so tests run
 *   without Redis / subprocesses. Production callers pass nothing and the
 *   defaults thin-wrap the already-typed readers in `src/autopilot/runs.ts`
 *   (`getCurrentLifecycle` / `getCurrentRun` / `listRuns`), `src/cost/index.ts`
 *   (`getUsage` → `projectEligibility`), and `src/autopilot/os-heartbeat.ts`.
 * - **Respects the Redis Adapters seam transitively.** This module reads ONLY
 *   through those typed readers — never `src/redis/*`, never `new Redis()`, and
 *   it adds no new Redis key. `runs.ts` is the only sanctioned Redis path for run
 *   state; the seam stays one layer above it. `redis-seam-check.ts` stays green.
 * - **Source-of-truth ordering is unchanged.** `running`/`alive` is derived from
 *   the autopilot LIFECYCLE (`getCurrentLifecycle` → `state === "running"`), NOT
 *   the scheduler heartbeat (issue #888). The scheduler heartbeat is surfaced
 *   only as `lastTickAt`.
 * - **Opt-in field-groups.** `eligibility` (idle-only) and `history`
 *   (health-only) are read only when requested via `options`, so the
 *   autopilot-tick route issues no `getUsage()` / `listRuns()` read it never did
 *   before. The snapshot fan-out is opt-in per field-group.
 * - **No `generatedAt`.** Each ROUTE stamps its own `generatedAt` from its own
 *   injected clock, keeping the clock at the route boundary exactly as today.
 *
 * This seam owns READ COMPOSITION only. The pure heuristic detectors
 * (`detectStalledDispatch` etc.) stay in `autopilot/run-health.ts` (issue #1378)
 * — analysis over the read-model, not the read-model itself.
 */

import { settledOr, settledOrEmpty, settledOrNull } from "../aggregators/settle.ts";
import {
  getCurrentLifecycle as defaultGetCurrentLifecycle,
  getCurrentRun as defaultGetCurrentRun,
  listRuns as defaultListRuns,
} from "./run-reads.ts";
import type { AutopilotLifecycle } from "./run-lifecycle-state.ts";
import { osHeartbeatAgeS as defaultOsHeartbeatAgeS } from "./os-heartbeat.ts";
import type { LiveRunView, RunDigest } from "./run-health.ts";
import {
  getUsage as defaultGetUsage,
  projectEligibility as defaultProjectEligibility,
} from "../cost/index.ts";
import { getStatus as defaultGetSchedulerStatus } from "../scheduler/heartbeat.ts";

// ---------------------------------------------------------------------------
// Field-group shapes
// ---------------------------------------------------------------------------

/** The scheduler housekeeping heartbeat (issue #397) — feeds `lastTickAt` only. */
interface SchedulerHeartbeatView {
  running: boolean;
  lastTickAt: string | null;
}

/**
 * The usage-eligibility pacing projection the Pace Gate consults (ADR-0021).
 * Structural slice of `UsageEligibility` (`src/cost/usage-tracker.ts`) — kept
 * small so a test stub needn't build a whole snapshot. Consumed only by the
 * idle-diagnostics site; opt-in via `options.eligibility`.
 */
export interface EligibilityView {
  paceState: "behind" | "on" | "ahead";
  targetPercent: number;
  sinceResetPercent: number;
  anchor: string | null;
  emergencyStop: boolean;
  calibrated: boolean;
  percentLast5h: number;
}

/**
 * The recent-run-history field-group. Consumed only by the autopilot-health
 * aggregator; opt-in via `options.history`.
 */
interface HistoryView {
  /** The live autopilot run's projected view (`getCurrentRun().view`), or `null`. */
  liveRun: LiveRunView | null;
  /** Recent run digests, newest-first (`listRuns(historyWindow)`). */
  recentRuns: RunDigest[];
  /** OS-heartbeat age in seconds (#1091), or `null` when unreadable. */
  osHeartbeatAgeS: number | null;
}

/**
 * The overlapping-projection snapshot. `lifecycle` and `scheduler` are always
 * read; `currentRun` is always read (shared by now-page + health, projected
 * two different ways downstream); `eligibility` and `history` are opt-in and
 * are `null` when not requested (so non-consumers pay for no extra read).
 */
export interface AutopilotStatusSnapshot {
  /** Discriminated lifecycle — the source of truth for `running` (issue #888). */
  lifecycle: AutopilotLifecycle;
  /** Projected current-run view (`getCurrentRun().view`), or `null`. */
  currentRun: Record<string, unknown> | null;
  /** Scheduler housekeeping heartbeat — feeds `lastTickAt` only. */
  scheduler: SchedulerHeartbeatView;
  /** Usage-eligibility pacing projection — `null` unless `options.eligibility`. */
  eligibility: EligibilityView | null;
  /** Recent-run-history field-group — `null` unless `options.history`. */
  history: HistoryView | null;
}

// ---------------------------------------------------------------------------
// Injectable readers + options
// ---------------------------------------------------------------------------

export interface AutopilotStatusDeps {
  /** Discriminated lifecycle reader. Defaults to `runs.getCurrentLifecycle()`. */
  readLifecycle?: () => Promise<AutopilotLifecycle>;
  /** Current-run view reader. Defaults to `runs.getCurrentRun()` (`view`, else `null`). */
  readCurrentRun?: () => Promise<Record<string, unknown> | null>;
  /** Scheduler heartbeat reader. Defaults to `scheduler/heartbeat.getStatus()`. */
  readScheduler?: () => Promise<SchedulerHeartbeatView>;
  /** Eligibility reader. Defaults to `cost.getUsage()` → `projectEligibility()`. */
  readEligibility?: () => Promise<EligibilityView>;
  /** Live-run view reader (health). Defaults to `runs.getCurrentRun()` view. */
  readLiveRun?: () => Promise<LiveRunView | null>;
  /** Recent-run digests reader (health). Defaults to `runs.listRuns(limit)`. */
  readRecentRuns?: (limit: number) => Promise<RunDigest[]>;
  /** OS-heartbeat age reader (health). Defaults to `os-heartbeat.osHeartbeatAgeS`. */
  readOsHeartbeatAgeS?: (nowS: number) => number | null;
}

export interface AutopilotStatusOptions {
  /** Read the usage-eligibility pacing field-group (idle-only). Default `false`. */
  eligibility?: boolean;
  /** Read the recent-run-history field-group (health-only). Default `false`. */
  history?: boolean;
  /** How many recent runs the `history` field-group scans. Default 14. */
  historyWindow?: number;
  /**
   * Wall-clock anchor for the os-heartbeat age (epoch seconds derived from it).
   * Only used when `history` is requested. Defaults to `new Date()`.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Safe defaults
// ---------------------------------------------------------------------------

const IDLE_LIFECYCLE: AutopilotLifecycle = {
  state: "idle",
  run_id: null,
  term_reason: null,
  ended_epoch: null,
};

const SCHEDULER_DEFAULT: SchedulerHeartbeatView = {
  running: false,
  lastTickAt: null,
};

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Compose one snapshot of the autopilot's current status from the injectable
 * readers, degrading each sub-read to a safe default under `Promise.allSettled`.
 *
 * Always reads `lifecycle`, `currentRun`, and `scheduler`. Reads `eligibility`
 * only when `options.eligibility`, and `history` only when `options.history` —
 * so a caller that projects only the lifecycle/tick fields issues no extra read.
 */
export async function getAutopilotStatusSnapshot(
  deps: AutopilotStatusDeps = {},
  options: AutopilotStatusOptions = {},
): Promise<AutopilotStatusSnapshot> {
  const readLifecycle = deps.readLifecycle ?? defaultReadLifecycle;
  const readCurrentRun = deps.readCurrentRun ?? defaultReadCurrentRun;
  const readScheduler = deps.readScheduler ?? defaultReadScheduler;

  const [lifecycleSettled, currentRunSettled, schedulerSettled] =
    await Promise.allSettled([
      readLifecycle(),
      readCurrentRun(),
      readScheduler(),
    ]);

  const lifecycle = settledOr(
    lifecycleSettled,
    IDLE_LIFECYCLE,
    "autopilot-status/lifecycle",
  );
  const currentRun = settledOrNull(
    currentRunSettled,
    "autopilot-status/current-run",
  );
  const scheduler = settledOr(
    schedulerSettled,
    SCHEDULER_DEFAULT,
    "autopilot-status/scheduler",
  );

  let eligibility: EligibilityView | null = null;
  if (options.eligibility) {
    const readEligibility = deps.readEligibility ?? defaultReadEligibility;
    const [eligSettled] = await Promise.allSettled([readEligibility()]);
    eligibility = settledOrNull(eligSettled, "autopilot-status/eligibility");
  }

  let history: HistoryView | null = null;
  if (options.history) {
    const readLiveRun = deps.readLiveRun ?? defaultReadLiveRun;
    const readRecentRuns = deps.readRecentRuns ?? defaultReadRecentRuns;
    const readOsHb = deps.readOsHeartbeatAgeS ?? defaultOsHeartbeatAgeS;
    const historyWindow = options.historyWindow ?? 14;
    const nowS = Math.floor((options.now ?? new Date()).getTime() / 1000);

    const [liveSettled, recentSettled] = await Promise.allSettled([
      readLiveRun(),
      readRecentRuns(historyWindow),
    ]);
    const liveRun = settledOrNull(liveSettled, "autopilot-status/live-run");
    const recentRuns = settledOrEmpty(
      recentSettled,
      "autopilot-status/run-history",
    );

    // Fail open: an os-heartbeat read failure is treated as "unreadable"
    // (`null`), matching the health aggregator's fail-open-to-stale contract.
    let osHb: number | null = null;
    try {
      osHb = readOsHb(nowS);
    } catch (err: any) {
      console.error(
        `[autopilot-status] os-heartbeat read failed: ${err?.message || err}`,
      );
      osHb = null;
    }

    history = { liveRun, recentRuns, osHeartbeatAgeS: osHb };
  }

  return { lifecycle, currentRun, scheduler, eligibility, history };
}

// ---------------------------------------------------------------------------
// Default wiring — thin read-only consumption of the typed readers.
// ---------------------------------------------------------------------------

async function defaultReadLifecycle(): Promise<AutopilotLifecycle> {
  const result = await defaultGetCurrentLifecycle();
  if (!result.ok) return IDLE_LIFECYCLE;
  return result.lifecycle;
}

async function defaultReadCurrentRun(): Promise<Record<string, unknown> | null> {
  const result = await defaultGetCurrentRun();
  if (!result.ok) return null;
  return result.view;
}

async function defaultReadScheduler(): Promise<SchedulerHeartbeatView> {
  const status = await defaultGetSchedulerStatus();
  return {
    running: !!status.running,
    lastTickAt:
      typeof status.lastTickAt === "string" ? status.lastTickAt : null,
  };
}

async function defaultReadEligibility(): Promise<EligibilityView> {
  const snapshot = await defaultGetUsage();
  const e = defaultProjectEligibility(snapshot);
  return {
    paceState: e.paceState,
    targetPercent: e.targetPercent,
    sinceResetPercent: e.sinceResetPercent,
    anchor: e.anchor,
    emergencyStop: e.reasons.emergencyStop,
    calibrated: e.reasons.calibrated,
    percentLast5h: e.usage.percentLast5h,
  };
}

async function defaultReadLiveRun(): Promise<LiveRunView | null> {
  const result = await defaultGetCurrentRun();
  if (!result.ok) return null;
  return result.view as LiveRunView;
}

async function defaultReadRecentRuns(limit: number): Promise<RunDigest[]> {
  const result = await defaultListRuns(limit);
  if (!result.ok) return [];
  return result.runs as RunDigest[];
}
