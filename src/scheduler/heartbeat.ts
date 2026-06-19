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
 * Controlled via API: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
 */

import { getMetricsTrend } from "../metrics/trend.ts";
import { computeRollingMergeRateFromTrend } from "../metrics/aggregate.ts";
import {
  getSchedulerCyclesRun,
  getSchedulerCyclesMerged,
  getSchedulerCyclesFailed,
  getSchedulerCyclesUnaccounted,
  getLastResearchAtMs,
  getSchedulerStateVersion,
  getSchedulerStateRaw,
  getSchedulerDeliberateStop, setSchedulerDeliberateStop, clearSchedulerDeliberateStop,
} from "../redis/scheduler.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import { getReconcilerHealth } from "../redis/reconciler.ts";
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

// Rolling merge-rate window (issue #232): the operator-visible mergeRate is
// computed from the last N cycles in cycle-history (same source as
// `hydra metrics --count N`). Lifetime counters (cyclesMerged / cyclesRun)
// are still surfaced as `mergeRateLifetime` for audit, but they get heavily
// skewed by historical regressions (e.g. issue #218 where merges were 0 for
// 14 hours) and trip stall-style alerts long after the underlying bug is fixed.
const ROLLING_MERGE_RATE_WINDOW = parseInt(process.env.HYDRA_ROLLING_MERGE_RATE_WINDOW) || 50;

// Issue #381 (codex cut-over PR-1) introduced HYDRA_CODEX_CYCLE_ENABLED as a
// kill-switch that prevented the scheduler from invoking the in-process
// control loop. Issue #383 (PR-3) deleted the control loop entirely — the
// scheduler now ONLY runs housekeeping (stale-claim reaper, weekly digest,
// memory consolidation, design-concept snapshot). There is no codex cycle to
// gate; the flag is gone. Reaching this comment in a debug session = grep for
// "HYDRA_CODEX_CYCLE_ENABLED" in operator runbooks and tell them it is dead.

/**
 * Compute the rolling merge rate from cycle metrics history.
 *
 * Counts a cycle as "merged" when its persisted `tasksMerged` field is > 0,
 * matching the semantics used by `getAggregateStats()` and the post-merge
 * pattern detector (so the scheduler card and `hydra metrics --count N` no
 * longer disagree).
 *
 * Returns null when there's no recent history yet (caller should treat as
 * "no data" rather than 0%, which would falsely flag a healthy fresh start
 * as a stall).
 *
 * Pure-ish: only side effect is a Redis read via getMetricsTrend. The rate
 * arithmetic itself is delegated to the shared pure
 * `computeRollingMergeRateFromTrend` (metrics pure-core; issue #2169) so this
 * wrapper only does the Redis fetch + composes the status shape.
 */
async function computeRollingMergeRate(window: number = ROLLING_MERGE_RATE_WINDOW): Promise<{ mergeRate: number | null; cyclesInWindow: number }> {
  try {
    const trend = await getMetricsTrend(window);
    if (!Array.isArray(trend) || trend.length === 0) {
      return { mergeRate: null, cyclesInWindow: 0 };
    }
    return {
      mergeRate: computeRollingMergeRateFromTrend(trend),
      cyclesInWindow: trend.length,
    };
  } catch (err: any) {
    console.error(`[Heartbeat] Rolling merge-rate computation failed: ${err?.message || err}`);
    return { mergeRate: null, cyclesInWindow: 0 };
  }
}

let state = {
  running: false,
  intervalMs: parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS) || 0,
  timer: null,
  cyclesRun: 0,
  cyclesMerged: 0,
  cyclesFailed: 0,
  // Issue #1919: cycles whose recorded status was in NEITHER MERGED_STATUSES
  // nor FAILED_STATUSES (recordCycle's unaccounted bucket). Surfaced read-only
  // in getStatus so the run = merged + failed + unaccounted identity is
  // operator-visible rather than an inferred subtraction. The heartbeat NEVER
  // increments this (ADR-0012) — recordCycle in src/autopilot/runs.ts is the
  // sole writer; this field is rehydrated from the atomic counter on startup.
  cyclesUnaccounted: 0,
  // Issue #397: heartbeat for the scheduler's housekeeping loop. Updated on
  // every `runScheduledCycle` entry so the watchdog can tell "scheduler is
  // alive" from "scheduler is wedged". This is the field external liveness
  // probes should read.
  lastTickAt: null,
  lastError: null,
  startedAt: null,
  consecutiveErrors: 0,
  researchCyclesRun: 0,
  lastResearchAt: null,
  _stateVersion: 0, // optimistic locking version (issue #140 — AC3)
  // Issue #388: distinguish operator-initiated stops from self-stops so the
  // watchdog can refuse to auto-restart deliberate stops.
  //   - "deliberate"     — POST /scheduler/stop. Watchdog must NOT restart.
  //   - "circuit-breaker"— auto-pause (consecutive-no-op-merges halt).
  //                        Watchdog SHOULD restart once work is queued.
  //   - "error-cap"      — auto-pause (consecutive-errors). Watchdog SHOULD restart.
  //   - null             — never stopped, or last action was start().
  // Mirrored to Redis (`schedulerDeliberateStop` key) with 24h TTL so the
  // marker survives an orchestrator restart.
  stopReason: null as "deliberate" | "circuit-breaker" | "error-cap" | null,
  deliberateStoppedAt: null as string | null,
};

// Issue #388: TTL for the deliberate-stop Redis marker. 24h is the
// operator-friendly maximum — if the operator forgets to restart the
// scheduler within a day, the marker self-clears so the watchdog regains
// the ability to recover from genuine self-stops.
const DELIBERATE_STOP_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Heartbeat state rehydration (read-only)
// ---------------------------------------------------------------------------
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
// (PR-1/4). The persisted `SCHEDULER_STATE_KEY` value is now read-only here —
// loadSchedulerState() still merges any historical value in, but nothing in
// this heartbeat writes it. The research-force policy lives in the autopilot
// brain (`scripts/autopilot/decide.py`).
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

async function loadSchedulerState() {
  try {
    const raw = await getSchedulerStateRaw();
    if (!raw) {
      console.log("[Heartbeat] No persisted state in Redis — starting fresh");
    } else {
      const stored = JSON.parse(raw);
      if (stored.lastResearchAt) state.lastResearchAt = stored.lastResearchAt;
      if (typeof stored.researchCyclesRun === "number") {
        state.researchCyclesRun = stored.researchCyclesRun;
      }
    }

    // Load atomic counter for cyclesRun (issue #140 — AC1)
    const atomicCyclesRun = await getSchedulerCyclesRun();
    if (atomicCyclesRun > 0) state.cyclesRun = atomicCyclesRun;

    // Load atomic counters for cyclesMerged / cyclesFailed (issue #208)
    // so that /api/scheduler/status reports stable lifetime mergeRate
    // immediately after restart, instead of resetting to 0 and confusing
    // the zero-output circuit breaker.
    const atomicCyclesMerged = await getSchedulerCyclesMerged();
    if (atomicCyclesMerged > 0) state.cyclesMerged = atomicCyclesMerged;
    const atomicCyclesFailed = await getSchedulerCyclesFailed();
    if (atomicCyclesFailed > 0) state.cyclesFailed = atomicCyclesFailed;

    // Issue #1919: rehydrate the unaccounted-cycles counter (read-only) so the
    // run = merged + failed + unaccounted identity is restart-stable on the
    // status page. recordCycle is the SOLE writer (ADR-0012); the heartbeat
    // only reads. Then emit a one-time lost-cycle diagnostic: if the live
    // counters do NOT satisfy the identity, a gap exists that the unaccounted
    // counter has not (yet) absorbed — e.g. the frozen 600-cycle historical
    // backfill that predates this counter. Log it so the residual is visible
    // without manual subtraction; this is the diagnostic half of the fix.
    const atomicCyclesUnaccounted = await getSchedulerCyclesUnaccounted();
    if (atomicCyclesUnaccounted > 0) state.cyclesUnaccounted = atomicCyclesUnaccounted;
    const accountedGap =
      state.cyclesRun - (state.cyclesMerged + state.cyclesFailed + state.cyclesUnaccounted);
    if (accountedGap !== 0) {
      console.warn(
        `[Heartbeat] Cycle-accounting gap on startup: cyclesRun=${state.cyclesRun} ` +
          `!= merged(${state.cyclesMerged}) + failed(${state.cyclesFailed}) + ` +
          `unaccounted(${state.cyclesUnaccounted}); residual gap=${accountedGap}. ` +
          `Go-forward cycles are bucketed (issue #1919); a non-zero residual is a ` +
          `frozen historical artifact predating the unaccounted counter, not a live leak.`,
      );
    }

    // Load atomic lastResearchAt (issue #140 — AC2)
    const lastResearchMs = await getLastResearchAtMs();
    if (lastResearchMs) {
      state.lastResearchAt = new Date(lastResearchMs).toISOString();
    }

    // Load state version for optimistic locking (issue #140 — AC3)
    state._stateVersion = await getSchedulerStateVersion();

    // Issue #388: rehydrate the deliberate-stop marker. If a marker exists in
    // Redis the operator stopped the scheduler before the restart — we keep
    // running=false (loadSchedulerState doesn't auto-start) and surface the
    // reason so the watchdog still refuses to restart after a service bounce.
    try {
      const rawDeliberateStop = await getSchedulerDeliberateStop();
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
      console.error(`[Heartbeat] Failed to load deliberate-stop marker: ${err.message}`);
    }

    console.log(`[Heartbeat] Loaded persisted state — lastResearchAt=${state.lastResearchAt}, cyclesRun=${state.cyclesRun}, cyclesMerged=${state.cyclesMerged}, cyclesFailed=${state.cyclesFailed}, version=${state._stateVersion}, stopReason=${state.stopReason ?? "none"}`);
  } catch (err: any) {
    console.error(`[Heartbeat] Failed to load persisted state: ${err.message}`);
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

// The in-process research-decision plane (loadResearchSnapshot /
// orphanAnnotation / executeResearchAction / maybeRunResearch) was deleted
// in #706 (scheduler fold PR-1/4). It fed the `runResearchLoop` no-op shim
// and did nothing in production. The research-force policy now lives in the
// autopilot brain (`scripts/autopilot/decide.py` `_research_force_allowed`).

async function runScheduledCycle(eventBus) {
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
  state.lastTickAt = new Date().toISOString();
  if (state.running) {
    const delay = state.intervalMs || DEFAULT_INTERVAL_MS;
    state.timer = setTimeout(
      () => runScheduledCycle(eventBus).catch((err: any) =>
        console.error(`[Heartbeat] Scheduled cycle failed: ${err.message}`),
      ),
      delay,
    );
  }
}

async function start(eventBus,  opts: Record<string, any> = {}) {
  if (state.running) {
    return { error: "Scheduler is already running" };
  }

  // Hydrate throttle state from Redis so restarts don't trigger an
  // unwanted research cycle by losing lastResearchAt.
  await loadSchedulerState();

  const intervalMs = opts.intervalMs || state.intervalMs || DEFAULT_INTERVAL_MS;
  if (intervalMs < MIN_INTERVAL_MS) {
    return { error: `Interval must be at least ${MIN_INTERVAL_MS}ms (${MIN_INTERVAL_MS / 1000}s)` };
  }

  state.running = true;
  state.intervalMs = intervalMs;
  state.startedAt = new Date().toISOString();
  state.consecutiveErrors = 0;
  // Issue #388: explicit operator intent — clear any deliberate-stop marker
  // so the watchdog regains its auto-restart authority. Failures here are
  // logged but do not block start() (the in-memory flip is the source of
  // truth for this process; Redis is the cross-restart belt-and-braces).
  state.stopReason = null;
  state.deliberateStoppedAt = null;
  try {
    await clearSchedulerDeliberateStop();
  } catch (err: any) {
    console.error(`[Heartbeat] Failed to clear deliberate-stop marker: ${err.message}`);
  }

  console.log(`[Heartbeat] Started — housekeeping cycles every ${intervalMs / 1000}s`);

  // Run first cycle immediately (fire-and-forget — errors handled inside runScheduledCycle)
  runScheduledCycle(eventBus).catch((err: any) => console.error(`[Heartbeat] First cycle failed: ${err.message}`));

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
async function stop(opts: { reason?: "deliberate" | "circuit-breaker" | "error-cap" | "shutdown" } = {}) {
  if (!state.running) {
    return { error: "Scheduler is not running" };
  }

  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const stoppedAt = new Date().toISOString();
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
      await setSchedulerDeliberateStop(
        JSON.stringify({ reason: "deliberate", stoppedAt }),
        DELIBERATE_STOP_TTL_SECONDS,
      );
    } catch (err: any) {
      console.error(`[Heartbeat] Failed to persist deliberate-stop marker: ${err.message}`);
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

  console.log(`[Heartbeat] Stopped after ${state.cyclesRun} cycles (reason=${reason})`);

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

async function getStatus() {
  // Issue #232: report a rolling-window merge rate as the primary
  // operator-visible metric. The lifetime ratio is preserved as
  // `mergeRateLifetime` for audit but is heavily skewed by historical
  // regressions and should not drive alerts or dashboards.
  const rolling = await computeRollingMergeRate();
  const lifetimeMergeRate = state.cyclesRun > 0
    ? Math.round((state.cyclesMerged / state.cyclesRun) * 100)
    : 0;
  // When no rolling history is available yet, fall back to the lifetime ratio
  // so existing consumers that read `mergeRate` keep getting a number.
  const mergeRate = rolling.mergeRate ?? lifetimeMergeRate;

  // Issue #988: operator-only autopilot-pause state. A deliberate pause is a
  // HEALTHY/expected state — surfaced so hydra-doctor / the watchdog can
  // distinguish "operator paused autopilot on purpose" from "scheduler
  // wedged". Fail-safe to not-paused if Redis is unreachable; advisory only.
  let autopilotPause: { paused: boolean; since?: number } = { paused: false };
  try {
    autopilotPause = await getAutopilotPaused();
  } catch (err: any) {
    console.error(`[Heartbeat] getStatus autopilot-pause read failed: ${err?.message ?? err}`);
  }

  // Issue #2057: surface merge→done reconciler liveness on the status page so a
  // stalled/blind reconciler (both gh feeds down) is operator-visible without
  // grepping the journal. Advisory only — a missing record (no run yet, or the
  // 2-day TTL aged out a long-stopped scheduler's record) reports `null`, and a
  // Redis read failure degrades to `null` rather than failing the status call.
  let reconciler: import("../redis/reconciler.ts").ReconcilerHealthRecord | null = null;
  try {
    reconciler = await getReconcilerHealth();
  } catch (err: any) {
    console.error(`[Heartbeat] getStatus reconciler-health read failed: ${err?.message ?? err}`);
  }

  return {
    // Issue #2057: merge→done reconciler last-run health (feed liveness + batch
    // metrics). `null` when no run is recorded yet or the record aged out.
    reconciler,
    running: state.running,
    // Issue #988: autopilot-pause state. `{paused:false}` by default;
    // `{paused:true, since}` while the operator has paused autopilot. A
    // HEALTHY/expected state — NOT degraded.
    autopilotPause,
    // Issue #388: surface why the scheduler is stopped so consumers
    // (especially the watchdog) can distinguish operator-deliberate stops
    // from self-stops. `null` when running, or when start() was the last
    // action. See the `stop()` JSDoc for the closed-list of values.
    stopReason: state.stopReason,
    deliberateStoppedAt: state.deliberateStoppedAt,
    intervalMs: state.intervalMs,
    intervalHuman: state.intervalMs ? formatDuration(state.intervalMs) : null,
    cyclesRun: state.cyclesRun,
    cyclesMerged: state.cyclesMerged,
    cyclesFailed: state.cyclesFailed,
    // Issue #1919: cycles whose status was in NEITHER MERGED_STATUSES nor
    // FAILED_STATUSES (no-op / idle-drain / dry-run / unknown). Read-only here
    // (recordCycle is the sole writer per ADR-0012). Makes the
    // cyclesRun == cyclesMerged + cyclesFailed + cyclesUnaccounted identity
    // queryable instead of an inferred (run - merged - failed) subtraction.
    cyclesUnaccounted: state.cyclesUnaccounted,
    // Rolling N-cycle merge rate (default 50) — same source as
    // `hydra metrics --count N`. Operator-visible primary metric.
    mergeRate,
    mergeRateWindow: ROLLING_MERGE_RATE_WINDOW,
    mergeRateCyclesInWindow: rolling.cyclesInWindow,
    // Lifetime counter ratio — kept for audit / debugging only. Do not use
    // for alerts, stall detection, or operator dashboards (see issue #232).
    mergeRateLifetime: lifetimeMergeRate,
    // Issue #397: heartbeat for the housekeeping tick. The watchdog
    // reads this to distinguish "scheduler alive" from "scheduler wedged".
    // Always present, always advancing when running=true.
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    startedAt: state.startedAt,
    consecutiveErrors: state.consecutiveErrors,
    // Issue #576: per-cycle cost cap (the codex-era circuit breaker) was
    // retired with `src/cost/cap.ts`. Quota gating now lives in the
    // Subscription Usage Tracker (`/api/usage`, `/api/usage/eligibility`).
    //
    // #706 (scheduler fold PR-1/4): the `research` sub-object (queueThreshold,
    // buildRatioMax/Min, currentRatio, queueDepth*, floor telemetry,
    // lastResearchDecision) was removed along with the in-process
    // research-decision plane. No dashboard reader consumed it. The
    // research-force policy now lives in the autopilot brain
    // (`scripts/autopilot/decide.py` `_research_force_allowed`).
  };
}

function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

/**
 * Auto-start the scheduler if HYDRA_AUTO_CYCLE_INTERVAL_MS is set.
 */
async function autoStart(eventBus) {
  const interval = parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS);
  if (interval && interval >= MIN_INTERVAL_MS) {
    console.log(`[Heartbeat] Auto-starting from HYDRA_AUTO_CYCLE_INTERVAL_MS=${interval}`);
    return await start(eventBus, { intervalMs: interval });
  }
  return null;
}

export {
  start, stop, getStatus, autoStart,
  // Exported for test coverage (issue #381 / #383):
  runScheduledCycle,
};
