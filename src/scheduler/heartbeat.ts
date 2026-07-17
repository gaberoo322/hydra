/**
 * Observability Heartbeat
 *
 * NOT a decisional brain. This module makes no policy decisions, dispatches
 * no work, and mutates no kanban/work-queue state — the autopilot
 * (`scripts/autopilot/decide.py`) is the orchestrator's single decisional
 * brain. This is a dumb liveness heartbeat plus a counter/observability
 * surface:
 *
 *   - stamps `lastTickAt` every tick so the watchdog can tell "alive" from
 *     "wedged" (issue #397);
 *   - computes the rolling merge-rate window for `GET /api/scheduler/status`
 *     (issue #232);
 *   - holds the deliberate-stop marker so the watchdog refuses to
 *     auto-restart an operator stop (issue #388);
 *   - rehydrates lifetime cycle counters from Redis on start so
 *     `/api/scheduler/status` reports stable metrics after a restart.
 *
 * The time-boxed housekeeping chores were lifted out to the hourly
 * `/api/maintenance/housekeeping` endpoint in #723 (scheduler fold PR-3/4),
 * and the chore CODE was moved into a dedicated **Housekeeping** Module
 * (`src/scheduler/housekeeping.ts`) in #938 so this Heartbeat stays genuinely
 * observability-only. Housekeeping is a sibling Module, not part of the
 * Heartbeat — see CONTEXT.md ("Housekeeping").
 *
 * Renamed from the former `loop.ts` in this directory in #725 (scheduler
 * fold PR-4/4, completes PP-1) to make the "no second brain" identity
 * explicit. The public surface is unchanged:
 * `start`/`stop`/`getStatus`/`autoStart`.
 *
 * # Injectable controller seam (issue #2195)
 *
 * The mutable state machine — start/stop lifecycle, deliberate-stop
 * rehydration from Redis, the rolling-merge-rate computation, timer
 * management, and the 8-field in-memory `state` object — was historically
 * bound to a module-level `let state = {...}` singleton. That hidden
 * shared-state seam forced every scheduler test to share one `state` object
 * with no per-case reset, so all six scheduler test files were pinned to real
 * Redis (DB 1) and could not exercise the transitions deterministically with
 * injected stubs.
 *
 * That state and its management methods now live inside the
 * {@link HeartbeatController} class below, parameterised by an injectable
 * {@link HeartbeatControllerDeps} surface (Redis readers/writers + a clock +
 * the rolling-merge-rate reader). Each dep defaults to the real
 * side-effecting implementation, so a unit test can construct a *fresh*
 * controller per case with injected stubs and a fixed clock — no module-level
 * state to reset. This mirrors the `DigestAccumulator` extraction (issue
 * #1487) that resolved the identical problem in `src/digest.ts`.
 *
 * The module-level functions (`start`, `stop`, `getStatus`, `autoStart`,
 * `runScheduledCycle`) are thin delegators to one {@link defaultController}
 * singleton, so all existing callers (`src/index.ts`, `src/api/scheduler.ts`,
 * `src/health/fan-out.ts`, `src/api/now-page.ts`, `src/api/recommendations.ts`)
 * keep their import paths zero-diff (`interfaceImpact: none`).
 *
 * Controlled via API: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
 */

import { logger } from "../logger.ts";
import {
  getSchedulerCyclesRun,
  getSchedulerCyclesMerged,
  getSchedulerCyclesFailed,
  getSchedulerCyclesUnaccounted,
  getSchedulerStateVersion,
  getSchedulerStateRaw,
  getSchedulerDeliberateStop, setSchedulerDeliberateStop, clearSchedulerDeliberateStop,
} from "../redis/scheduler.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import { getReconcilerHealth } from "../redis/reconciler.ts";
// Builder-health stagnation emit (issue #3290) was lifted OUT of this heartbeat
// into a sibling tick-side-effect module in #3371 so the liveness state machine
// stops carrying the two-domain import chain (builder-health aggregator +
// notification bus) and the process-lifetime edge-state store. The heartbeat now
// injects a single emit function (`emitTickStagnationAlerts`, defaulting to the
// real implementation) and fires it fire-and-forget on the tick — same event,
// same payload, same edge-trigger timing. Mirrors the status-projection.ts /
// rolling-rates.ts extractions (#2974).
import { emitTickStagnationAlerts } from "./tick-stagnation-alert.ts";
// Status projection (issue #2935) + its types were lifted into a sibling
// module in #2974 so the heartbeat file carries only the state machine. The
// `SchedulerStatus` return type, `StatusProjectionDeps`, `SchedulerStateSnapshot`,
// and `buildSchedulerStatus` are re-exported below so every existing import
// path (src/api/scheduler.ts, src/health/fan-out.ts, tests, …) stays zero-diff.
import {
  formatDuration,
  buildSchedulerStatus,
  type SchedulerStatus,
  type StatusProjectionDeps,
  type SchedulerStateSnapshot,
} from "./status-projection.ts";
// Rolling-rate readers (issues #232 / #2818) + their window constants were
// lifted into a sibling module in #2974 (the two Redis-read wrappers are the
// controller's default rate deps). Re-exported below where the public surface
// is composed.
import {
  defaultComputeRollingMergeRate,
  defaultComputeRollingEmptyRate,
  ROLLING_MERGE_RATE_WINDOW,
  ROLLING_EMPTY_RATE_WINDOW,
} from "./rolling-rates.ts";

export type { SchedulerStatus, StatusProjectionDeps, SchedulerStateSnapshot };
export { buildSchedulerStatus };

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (issue #725: slowed from 2min; watchdog staleness threshold is 15min = 3x margin)
const MIN_INTERVAL_MS = 30 * 1000; // 30 seconds minimum

// Note: the in-process scheduler research-decision plane (queue-depth /
// ratio-cap / capacity-floor throttling that fed the `runResearchLoop`
// no-op shim) was deleted in #706 (scheduler fold PR-1/4). The research-force
// policy now lives in the autopilot brain (`scripts/autopilot/decide.py`
// `_research_force_allowed`). The `HYDRA_RESEARCH_QUEUE_THRESHOLD`,
// `HYDRA_RESEARCH_BUILD_RATIO_MAX`, and `HYDRA_RESEARCH_MIN_INTERVAL_MS`
// env vars are inert if still set.

// Note: the legacy `HYDRA_DAILY_COST_CAP_USD` env var, the dollar-based
// daily-spend cap, and the `recordSpend`/`getDailySpend` helpers were
// retired in the Subscription Usage Tracker B-series PRs. Quota gating
// is now done by the autopilot via `/api/usage/eligibility` (PR B1),
// using real Anthropic-quota numbers from `~/.claude/projects/*.jsonl`
// instead of a HYDRA_TOKEN_USD_RATE × token estimate. The env var is
// inert if still set.

// The rolling merge-rate (#232) and empty-cycle-rate (#2818) windows +
// their Redis-read computers moved to `./rolling-rates.ts` in #2974
// (ROLLING_MERGE_RATE_WINDOW / ROLLING_EMPTY_RATE_WINDOW /
// defaultComputeRollingMergeRate / defaultComputeRollingEmptyRate) —
// imported at the top of this file.

// Issue #381 (codex cut-over PR-1) introduced HYDRA_CODEX_CYCLE_ENABLED as a
// kill-switch that prevented the scheduler from invoking the in-process
// control loop. Issue #383 (PR-3) deleted the control loop entirely — the
// scheduler now ONLY runs housekeeping (stale-claim reaper, weekly digest,
// memory consolidation, design-concept snapshot). There is no codex cycle to
// gate; the flag is gone. Reaching this comment in a debug session = grep for
// "HYDRA_CODEX_CYCLE_ENABLED" in operator runbooks and tell them it is dead.

/**
 * The mutable in-memory heartbeat state. Owned by a {@link HeartbeatController}
 * instance — no longer a module-level singleton (issue #2195). Each field's
 * historical rationale is documented inline below.
 */
interface HeartbeatState {
  running: boolean;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  cyclesRun: number;
  cyclesMerged: number;
  cyclesFailed: number;
  // Issue #1919: cycles whose recorded status was in NEITHER MERGED_STATUSES
  // nor FAILED_STATUSES (recordCycle's unaccounted bucket). Surfaced read-only
  // in getStatus so the run = merged + failed + unaccounted identity is
  // operator-visible rather than an inferred subtraction. The heartbeat NEVER
  // increments this (ADR-0012) — recordCycle in src/autopilot/runs.ts is the
  // sole writer; this field is rehydrated from the atomic counter on startup.
  cyclesUnaccounted: number;
  // Issue #397: heartbeat for the scheduler's housekeeping loop. Updated on
  // every `runScheduledCycle` entry so the watchdog can tell "scheduler is
  // alive" from "scheduler is wedged". This is the field external liveness
  // probes should read.
  lastTickAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  consecutiveErrors: number;
  _stateVersion: number; // optimistic locking version (issue #140 — AC3)
  // Issue #388: distinguish operator-initiated stops from self-stops so the
  // watchdog can refuse to auto-restart deliberate stops.
  //   - "deliberate"     — POST /scheduler/stop. Watchdog must NOT restart.
  //   - "circuit-breaker"— auto-pause (consecutive-no-op-merges halt).
  //                        Watchdog SHOULD restart once work is queued.
  //   - "error-cap"      — auto-pause (consecutive-errors). Watchdog SHOULD restart.
  //   - null             — never stopped, or last action was start().
  // Mirrored to Redis (`schedulerDeliberateStop` key) with 24h TTL so the
  // marker survives an orchestrator restart.
  stopReason: "deliberate" | "circuit-breaker" | "error-cap" | null;
  deliberateStoppedAt: string | null;
}

function freshState(): HeartbeatState {
  return {
    running: false,
    intervalMs: parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS) || 0,
    timer: null,
    cyclesRun: 0,
    cyclesMerged: 0,
    cyclesFailed: 0,
    cyclesUnaccounted: 0,
    lastTickAt: null,
    lastError: null,
    startedAt: null,
    consecutiveErrors: 0,
    _stateVersion: 0,
    stopReason: null,
    deliberateStoppedAt: null,
  };
}

// Issue #388: TTL for the deliberate-stop Redis marker. 24h is the
// operator-friendly maximum — if the operator forgets to restart the
// scheduler within a day, the marker self-clears so the watchdog regains
// the ability to recover from genuine self-stops.
const DELIBERATE_STOP_TTL_SECONDS = 24 * 60 * 60;

/**
 * Injectable dependencies for {@link HeartbeatController} (issue #2195). All
 * optional — each defaults to the real side-effecting implementation, so
 * production constructs the controller with `new HeartbeatController()` and a
 * unit test injects deterministic Redis readers + a fixed clock.
 *
 * The Redis *adapter* (`src/redis/scheduler.ts`) is intentionally NOT injected
 * wholesale; instead the controller injects the specific reader/writer
 * functions it consumes, so the adapter seam stays unchanged (per the issue's
 * "Files out of scope" note).
 */
export interface HeartbeatControllerDeps {
  /** Wall-clock source. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Rolling-merge-rate reader. Defaults to the real
   * `defaultComputeRollingMergeRate` (a Redis read via getMetricsTrend). Tests
   * inject a deterministic stub so getStatus never touches Redis.
   */
  computeRollingMergeRate?: (window?: number) => Promise<{ mergeRate: number | null; cyclesInWindow: number }>;
  /**
   * Rolling-empty-rate reader (issue #2818). Defaults to the real
   * `defaultComputeRollingEmptyRate` (a Redis read via getMetricsTrend). Tests
   * inject a deterministic stub so getStatus never touches Redis.
   */
  computeRollingEmptyRate?: (window?: number) => Promise<{ emptyRate: number | null; cyclesInWindow: number }>;

  // --- Redis state-rehydration readers (loadSchedulerState) ---
  getSchedulerStateRaw?: () => Promise<string | null>;
  getSchedulerCyclesRun?: () => Promise<number>;
  getSchedulerCyclesMerged?: () => Promise<number>;
  getSchedulerCyclesFailed?: () => Promise<number>;
  getSchedulerCyclesUnaccounted?: () => Promise<number>;
  getSchedulerStateVersion?: () => Promise<number>;
  getSchedulerDeliberateStop?: () => Promise<string | null>;

  // --- Deliberate-stop marker writers (start/stop) ---
  setSchedulerDeliberateStop?: (payload: string, ttlSeconds: number) => Promise<void>;
  clearSchedulerDeliberateStop?: () => Promise<void>;

  // --- getStatus advisory readers ---
  getAutopilotPaused?: () => Promise<{ paused: boolean; since?: number }>;
  getReconcilerHealth?: () => Promise<import("../redis/reconciler.ts").ReconcilerHealthRecord | null>;

  // --- Builder-health stagnation alert (issue #3290; extracted #3371) ---
  /**
   * Per-tick builder-health stagnation emit. Defaults to the real
   * `emitTickStagnationAlerts` (from `./tick-stagnation-alert.ts`), which reads
   * the Builder-Health Scorecard and fires an edge-triggered
   * `builder-health.stagnation` notification for any signal that transitioned
   * INTO `breach`. Fired fire-and-forget on the tick and never throws. Tests
   * inject a spy to assert the tick still fires it without constructing the
   * scorecard + notification-bus fixture chain (the coupling #3371 removed).
   */
  emitTickStagnationAlerts?: (eventBus: unknown) => Promise<void>;
}

/**
 * Owns the heartbeat's mutable state machine (the `running` lifecycle,
 * lifetime cycle counters, the timer handle, deliberate-stop discriminant) and
 * the side-effecting behavior over it: Redis rehydration on start, the timer
 * lifecycle, and the rolling-merge-rate status composition. Construct with
 * injected deps for testability; production uses the {@link defaultController}
 * singleton (issue #2195).
 */
export class HeartbeatController {
  private state: HeartbeatState = freshState();

  private readonly now: () => Date;
  private readonly computeRollingMergeRate: (window?: number) => Promise<{ mergeRate: number | null; cyclesInWindow: number }>;
  private readonly computeRollingEmptyRate: (window?: number) => Promise<{ emptyRate: number | null; cyclesInWindow: number }>;
  private readonly getSchedulerStateRaw: () => Promise<string | null>;
  private readonly getSchedulerCyclesRun: () => Promise<number>;
  private readonly getSchedulerCyclesMerged: () => Promise<number>;
  private readonly getSchedulerCyclesFailed: () => Promise<number>;
  private readonly getSchedulerCyclesUnaccounted: () => Promise<number>;
  private readonly getSchedulerStateVersion: () => Promise<number>;
  private readonly getSchedulerDeliberateStop: () => Promise<string | null>;
  private readonly setSchedulerDeliberateStop: (payload: string, ttlSeconds: number) => Promise<void>;
  private readonly clearSchedulerDeliberateStop: () => Promise<void>;
  private readonly getAutopilotPaused: () => Promise<{ paused: boolean; since?: number }>;
  private readonly getReconcilerHealth: () => Promise<import("../redis/reconciler.ts").ReconcilerHealthRecord | null>;
  private readonly emitTickStagnationAlerts: (eventBus: unknown) => Promise<void>;

  constructor(deps: HeartbeatControllerDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.computeRollingMergeRate = deps.computeRollingMergeRate ?? defaultComputeRollingMergeRate;
    this.computeRollingEmptyRate = deps.computeRollingEmptyRate ?? defaultComputeRollingEmptyRate;
    this.getSchedulerStateRaw = deps.getSchedulerStateRaw ?? getSchedulerStateRaw;
    this.getSchedulerCyclesRun = deps.getSchedulerCyclesRun ?? getSchedulerCyclesRun;
    this.getSchedulerCyclesMerged = deps.getSchedulerCyclesMerged ?? getSchedulerCyclesMerged;
    this.getSchedulerCyclesFailed = deps.getSchedulerCyclesFailed ?? getSchedulerCyclesFailed;
    this.getSchedulerCyclesUnaccounted = deps.getSchedulerCyclesUnaccounted ?? getSchedulerCyclesUnaccounted;
    this.getSchedulerStateVersion = deps.getSchedulerStateVersion ?? getSchedulerStateVersion;
    this.getSchedulerDeliberateStop = deps.getSchedulerDeliberateStop ?? getSchedulerDeliberateStop;
    this.setSchedulerDeliberateStop = deps.setSchedulerDeliberateStop ?? setSchedulerDeliberateStop;
    this.clearSchedulerDeliberateStop = deps.clearSchedulerDeliberateStop ?? clearSchedulerDeliberateStop;
    this.getAutopilotPaused = deps.getAutopilotPaused ?? getAutopilotPaused;
    this.getReconcilerHealth = deps.getReconcilerHealth ?? getReconcilerHealth;
    this.emitTickStagnationAlerts = deps.emitTickStagnationAlerts ?? emitTickStagnationAlerts;
  }

  // -------------------------------------------------------------------------
  // Heartbeat state rehydration (read-only)
  // -------------------------------------------------------------------------
  //
  // The in-memory `state` is reset on every orchestrator restart. On startup,
  // loadSchedulerState() merges any persisted values back in before the first
  // tick so /api/scheduler/status reports stable metrics immediately.
  //
  // Historical note: the research-throttle (`lastResearchAt`) and architect
  // counter were written back via a `saveSchedulerState()` writer, because a
  // reset `lastResearchAt` used to trigger an immediate unwanted research cycle
  // (~$3-8 in Codex). That writer was removed in #725 (scheduler fold PR-4/4)
  // once the research-decision plane that called it was deleted in #706
  // (PR-1/4). The vestigial read-back of those fields (the `SCHEDULER_STATE_KEY`
  // research merge and the atomic `getLastResearchAtMs` load) was then removed in
  // #3133 — nothing populated them and nothing projected them into
  // SchedulerStatus. The research-force policy lives in the autopilot brain
  // (`scripts/autopilot/decide.py`).
  //
  // Lifetime cycle counters (cyclesRun, cyclesMerged, cyclesFailed) are also
  // persisted via dedicated Redis atomic counters — see incrSchedulerCyclesRun /
  // incrSchedulerCyclesMerged / incrSchedulerCyclesFailed. Originally only
  // cyclesRun was persisted (issue #140); the other two were in-memory only,
  // which made mergeRate snap to a misleading near-zero value after every
  // restart and tripped the zero-output circuit breaker on transient resets
  // (issue #208). On startup, loadSchedulerState() seeds in-memory state from
  // the Redis counters when they're non-zero so /api/scheduler/status reports
  // stable lifetime metrics immediately after restart.
  private async loadSchedulerState(): Promise<void> {
    const state = this.state;
    try {
      const raw = await this.getSchedulerStateRaw();
      if (!raw) {
        logger.info({}, "no persisted state in Redis — starting fresh");
      }

      // Load atomic counter for cyclesRun (issue #140 — AC1)
      const atomicCyclesRun = await this.getSchedulerCyclesRun();
      if (atomicCyclesRun > 0) state.cyclesRun = atomicCyclesRun;

      // Load atomic counters for cyclesMerged / cyclesFailed (issue #208)
      // so that /api/scheduler/status reports stable lifetime mergeRate
      // immediately after restart, instead of resetting to 0 and confusing
      // the zero-output circuit breaker.
      const atomicCyclesMerged = await this.getSchedulerCyclesMerged();
      if (atomicCyclesMerged > 0) state.cyclesMerged = atomicCyclesMerged;
      const atomicCyclesFailed = await this.getSchedulerCyclesFailed();
      if (atomicCyclesFailed > 0) state.cyclesFailed = atomicCyclesFailed;

      // Issue #1919: rehydrate the unaccounted-cycles counter (read-only) so the
      // run = merged + failed + unaccounted identity is restart-stable on the
      // status page. recordCycle is the SOLE writer (ADR-0012); the heartbeat
      // only reads. Then emit a one-time lost-cycle diagnostic: if the live
      // counters do NOT satisfy the identity, a gap exists that the unaccounted
      // counter has not (yet) absorbed — e.g. the frozen 600-cycle historical
      // backfill that predates this counter. Log it so the residual is visible
      // without manual subtraction; this is the diagnostic half of the fix.
      const atomicCyclesUnaccounted = await this.getSchedulerCyclesUnaccounted();
      if (atomicCyclesUnaccounted > 0) state.cyclesUnaccounted = atomicCyclesUnaccounted;
      const accountedGap =
        state.cyclesRun - (state.cyclesMerged + state.cyclesFailed + state.cyclesUnaccounted);
      if (accountedGap !== 0) {
        logger.warn(
          {
            cyclesRun: state.cyclesRun,
            cyclesMerged: state.cyclesMerged,
            cyclesFailed: state.cyclesFailed,
            cyclesUnaccounted: state.cyclesUnaccounted,
            residualGap: accountedGap,
          },
          "cycle-accounting gap on startup; non-zero residual is a frozen historical artifact predating the unaccounted counter, not a live leak",
        );
      }

      // Load state version for optimistic locking (issue #140 — AC3)
      state._stateVersion = await this.getSchedulerStateVersion();

      // Issue #388: rehydrate the deliberate-stop marker. If a marker exists in
      // Redis the operator stopped the scheduler before the restart — we keep
      // running=false (loadSchedulerState doesn't auto-start) and surface the
      // reason so the watchdog still refuses to restart after a service bounce.
      try {
        const rawDeliberateStop = await this.getSchedulerDeliberateStop();
        if (rawDeliberateStop) {
          const parsed = JSON.parse(rawDeliberateStop);
          if (parsed && typeof parsed.reason === "string") {
            state.stopReason = parsed.reason;
          }
          if (parsed && typeof parsed.stoppedAt === "string") {
            state.deliberateStoppedAt = parsed.stoppedAt;
          }
        }
      } catch (err: any) {
        logger.error({ err }, "failed to load deliberate-stop marker");
      }

      logger.info({ cyclesRun: state.cyclesRun, cyclesMerged: state.cyclesMerged, cyclesFailed: state.cyclesFailed, stateVersion: state._stateVersion, stopReason: state.stopReason ?? "none" }, "persisted state loaded");
    } catch (err: any) {
      logger.error({ err }, "failed to load persisted state");
    }
  }

  // The in-process research-decision plane (loadResearchSnapshot /
  // orphanAnnotation / executeResearchAction / maybeRunResearch) was deleted
  // in #706 (scheduler fold PR-1/4). It fed the `runResearchLoop` no-op shim
  // and did nothing in production. The research-force policy now lives in the
  // autopilot brain (`scripts/autopilot/decide.py` `_research_force_allowed`).

  async runScheduledCycle(eventBus): Promise<void> {
    const state = this.state;
    if (!state.running) return;

    // Issue #383 (codex cut-over PR-3): the in-process control loop is gone.
    // #706 (scheduler fold PR-1/4) additionally removed the research-decision
    // plane that used to run here. #723 (scheduler fold PR-3/4) moved the six
    // time-boxed housekeeping chores (blocked re-escalation, done-lane pruning,
    // weekly digest, memory consolidation, design-concept snapshot, review-pickup
    // notify) out to an hourly `hydra-housekeeping.timer` that POSTs
    // `/api/maintenance/housekeeping` → `runHousekeeping(eventBus)`. #938 then
    // moved the chore CODE into `src/scheduler/housekeeping.ts` (a sibling
    // Module). `runScheduledCycle` now exists solely as a heartbeat +
    // rolling-merge-rate observability surface.
    //
    // Issue #397: the heartbeat moves to `lastTickAt` so liveness probes can
    // tell "scheduler is alive" apart from "the control loop ran". The legacy
    // `lastCycleAt` field is left null on purpose — there is no `runControlLoop`
    // invocation to point at, so reporting a stale codex timestamp here misleads
    // the dashboard and the watchdog. Operators that want liveness must read
    // `lastTickAt`. computeRollingMergeRate is exercised here (via getStatus on
    // the status endpoint) — the tick keeps the heartbeat advancing so the
    // watchdog can distinguish alive from wedged.
    state.lastTickAt = this.now().toISOString();

    // Issue #3290 (extracted to a sibling module in #3371): proactive
    // builder-health stagnation alert. This is a pure observability surface —
    // it reads the scorecard and (edge-triggered) emits a
    // `builder-health.stagnation` notification when a signal transitions into
    // `breach`. It makes NO policy decision, dispatches no work, and mutates no
    // kanban/work-queue state, so it respects the heartbeat's "no second brain"
    // identity (ADR-0012). Fire-and-forget + never-throws so a slow scorecard
    // read (Redis + GitHub fan-out) can never wedge the liveness tick. The
    // scorecard read, edge-state store, and never-throws guard now live in
    // `./tick-stagnation-alert.ts`; the heartbeat only fires the injected emit.
    this.emitTickStagnationAlerts(eventBus).catch((err: any) =>
      logger.error({ err }, "stagnation-alert emit failed"),
    );

    if (state.running) {
      const delay = state.intervalMs || DEFAULT_INTERVAL_MS;
      state.timer = setTimeout(
        () => this.runScheduledCycle(eventBus).catch((err: any) =>
          logger.error({ err }, "scheduled cycle failed"),
        ),
        delay,
      );
    }
  }

  async start(eventBus, opts: Record<string, any> = {}): Promise<Record<string, any>> {
    const state = this.state;
    if (state.running) {
      return { error: "Scheduler is already running" };
    }

    // Hydrate throttle state from Redis so restarts don't trigger an
    // unwanted research cycle by losing lastResearchAt.
    await this.loadSchedulerState();

    const intervalMs = opts.intervalMs || state.intervalMs || DEFAULT_INTERVAL_MS;
    if (intervalMs < MIN_INTERVAL_MS) {
      return { error: `Interval must be at least ${MIN_INTERVAL_MS}ms (${MIN_INTERVAL_MS / 1000}s)` };
    }

    state.running = true;
    state.intervalMs = intervalMs;
    state.startedAt = this.now().toISOString();
    state.consecutiveErrors = 0;
    // Issue #388: explicit operator intent — clear any deliberate-stop marker
    // so the watchdog regains its auto-restart authority. Failures here are
    // logged but do not block start() (the in-memory flip is the source of
    // truth for this process; Redis is the cross-restart belt-and-braces).
    state.stopReason = null;
    state.deliberateStoppedAt = null;
    try {
      await this.clearSchedulerDeliberateStop();
    } catch (err: any) {
      logger.error({ err }, "failed to clear deliberate-stop marker");
    }

    logger.info({ intervalMs, intervalSecs: intervalMs / 1000 }, "heartbeat started");

    // Run first cycle immediately (fire-and-forget — errors handled inside runScheduledCycle)
    this.runScheduledCycle(eventBus).catch((err: any) => logger.error({ err }, "first cycle failed"));

    return {
      started: true,
      intervalMs,
      intervalHuman: formatDuration(intervalMs),
    };
  }

  /**
   * Stop the scheduler.
   *
   * @param opts.reason — why the scheduler is being stopped. The reason
   *   determines whether a deliberate-stop marker is written to Redis so the
   *   watchdog can refuse to auto-restart (issue #388).
   *
   *     "deliberate"      — operator intent (POST /scheduler/stop). Marker
   *                         written; watchdog will NOT restart.
   *     "circuit-breaker" — auto-pause (no-op-merge halt). Marker NOT
   *                         written; watchdog SHOULD restart once work is
   *                         queued.
   *     "error-cap"       — auto-pause (consecutive errors). Same as
   *                         circuit-breaker.
   *     "shutdown"        — process exit (SIGTERM/SIGINT). Marker NOT written;
   *                         the service will be restarted by systemd and the
   *                         scheduler will autoStart again on boot.
   *
   *   Default: "deliberate". This preserves the historical contract — anyone
   *   calling `stop()` with no args is treating it as an operator action.
   */
  async stop(opts: { reason?: "deliberate" | "circuit-breaker" | "error-cap" | "shutdown" } = {}): Promise<Record<string, any>> {
    const state = this.state;
    if (!state.running) {
      return { error: "Scheduler is not running" };
    }

    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const stoppedAt = this.now().toISOString();
    const reason = opts.reason ?? "deliberate";

    // Issue #388: persist the marker for deliberate stops so the watchdog
    // refuses to auto-restart. Auto-pause reasons (circuit-breaker / error-cap)
    // are explicitly NOT persisted — those are exactly the cases the watchdog
    // is designed to recover from. Shutdown is also skipped: systemd will
    // restart the service and autoStart() needs a clean slate.
    if (reason === "deliberate") {
      state.stopReason = "deliberate";
      state.deliberateStoppedAt = stoppedAt;
      try {
        await this.setSchedulerDeliberateStop(
          JSON.stringify({ reason: "deliberate", stoppedAt }),
          DELIBERATE_STOP_TTL_SECONDS,
        );
      } catch (err: any) {
        logger.error({ err }, "failed to persist deliberate-stop marker");
      }
    } else if (reason === "circuit-breaker" || reason === "error-cap") {
      // Track the reason in-memory so /status surfaces it, but DO NOT write
      // the marker — the watchdog must still be able to recover these.
      state.stopReason = reason;
      state.deliberateStoppedAt = null;
    } else {
      // reason === "shutdown" — leave stopReason untouched so a deliberate
      // stop survives a clean shutdown/restart cycle via the Redis marker.
    }

    logger.info({ cyclesRun: state.cyclesRun, reason }, "heartbeat stopped");

    return {
      stopped: true,
      reason,
      cyclesRun: state.cyclesRun,
      cyclesMerged: state.cyclesMerged,
      cyclesFailed: state.cyclesFailed,
      startedAt: state.startedAt,
      stoppedAt,
    };
  }

  async getStatus(): Promise<SchedulerStatus> {
    // Issue #2935: delegate to the exported `buildSchedulerStatus` free function
    // so the projection logic (advisory reads, field assembly) is testable
    // without constructing a full HeartbeatController. The controller passes its
    // in-memory state snapshot and pre-computes the rolling rates here — the
    // advisory reader deps come from the controller's injected deps (so tests
    // that stub getAutopilotPaused / getReconcilerHealth still work through the
    // existing HeartbeatControllerDeps seam).
    const rolling = await this.computeRollingMergeRate();
    const emptyRolling = await this.computeRollingEmptyRate();
    return buildSchedulerStatus(
      this.state,
      {
        rolling,
        emptyRolling,
        mergeRateWindow: ROLLING_MERGE_RATE_WINDOW,
        emptyRateWindow: ROLLING_EMPTY_RATE_WINDOW,
      },
      {
        getAutopilotPaused: this.getAutopilotPaused,
        getReconcilerHealth: this.getReconcilerHealth,
      },
    );
  }

  /**
   * Auto-start the scheduler if HYDRA_AUTO_CYCLE_INTERVAL_MS is set.
   */
  async autoStart(eventBus): Promise<Record<string, any> | null> {
    const interval = parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS);
    if (interval && interval >= MIN_INTERVAL_MS) {
      logger.info({ intervalMs: interval }, "auto-starting from HYDRA_AUTO_CYCLE_INTERVAL_MS");
      return await this.start(eventBus, { intervalMs: interval });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Daily Codex spend cap
// ---------------------------------------------------------------------------
//
// Daily-spend cap retired (Subscription Usage Tracker B-series). The
// historical context: between 2026-04-02 and 2026-04-04 the codex weekly
// quota was exhausted in ~3 days of unconstrained research, and every
// subsequent research cycle failed silently until the quota reset on
// 2026-04-08. The dollar-based cap (HYDRA_DAILY_COST_CAP_USD) was the
// fix for that.
//
// Post-codex (ADR-0006), `HYDRA_TOKEN_USD_RATE` was never set in
// production, so the surrogate-converted dollar spend was always $0 and
// the cap never fired. The Subscription Usage Tracker
// (src/cost/usage-tracker.ts) replaces this entirely: it reads real
// Anthropic-quota percentages from the JSONL transcripts and exposes
// `/api/usage/eligibility` for autopilot dispatch gating (PR B1). The
// scheduler itself doesn't dispatch Claude Code subagents — research is
// driven by the /hydra-target-research skill under the autopilot, so the
// autopilot's eligibility gate covers it.

// ---------------------------------------------------------------------------
// Module-level delegators (issue #2195)
// ---------------------------------------------------------------------------
//
// The single production controller. The exported functions below delegate to
// it so callers keep their existing import paths (`interfaceImpact: none`).
const defaultController = new HeartbeatController();

async function start(eventBus, opts: Record<string, any> = {}) {
  return defaultController.start(eventBus, opts);
}

async function stop(opts: { reason?: "deliberate" | "circuit-breaker" | "error-cap" | "shutdown" } = {}) {
  return defaultController.stop(opts);
}

async function getStatus(): Promise<SchedulerStatus> {
  return defaultController.getStatus();
}

async function autoStart(eventBus) {
  return defaultController.autoStart(eventBus);
}

async function runScheduledCycle(eventBus) {
  return defaultController.runScheduledCycle(eventBus);
}

export {
  start, stop, getStatus, autoStart,
  // Exported for test coverage (issue #381 / #383):
  runScheduledCycle,
};
