/**
 * Cycle Scheduler
 *
 * Runs development cycles on a configurable interval.
 * Auto-triggers research when the work queue runs low (throttled).
 * Auto-triggers architect review every N research cycles.
 *
 * Controlled via API: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
 */

import { startCycle } from "./cycle.mjs";
import { sendNotification } from "./notify.mjs";
import { getTracker } from "./task-tracker.mjs";
import { runResearchLoop } from "./research-loop.mjs";
import { runArchitectReview } from "./research-architect.mjs";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_INTERVAL_MS = 30 * 1000; // 30 seconds minimum
const COOLDOWN_ON_ERROR_MS = 60 * 1000; // 1 minute cooldown after errors

const RESEARCH_QUEUE_THRESHOLD = parseInt(process.env.HYDRA_RESEARCH_QUEUE_THRESHOLD) || 3;
const RESEARCH_MIN_INTERVAL_MS = parseInt(process.env.HYDRA_RESEARCH_MIN_INTERVAL_MS) || 12 * 60 * 60 * 1000; // 12 hours
const ARCHITECT_EVERY_N_RESEARCH = parseInt(process.env.HYDRA_ARCHITECT_EVERY_N_RESEARCH) || 3;

let state = {
  running: false,
  intervalMs: parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS) || 0,
  timer: null,
  cyclesRun: 0,
  cyclesMerged: 0,
  cyclesFailed: 0,
  lastCycleAt: null,
  lastError: null,
  startedAt: null,
  consecutiveErrors: 0,
  researchCyclesRun: 0,
  lastResearchAt: null,
  lastArchitectAt: null,
  researchSinceLastArchitect: 0,
};

async function maybeRunResearch(eventBus) {
  // Check queue depth
  const queueLen = await getTracker().redis.llen("hydra:anchors:work-queue");
  if (queueLen >= RESEARCH_QUEUE_THRESHOLD) return;

  // Check throttle — don't run research more often than the minimum interval
  if (state.lastResearchAt) {
    const elapsed = Date.now() - new Date(state.lastResearchAt).getTime();
    if (elapsed < RESEARCH_MIN_INTERVAL_MS) {
      const remaining = Math.round((RESEARCH_MIN_INTERVAL_MS - elapsed) / 60_000);
      console.log(`[Scheduler] Queue low (${queueLen}) but research throttled — next research in ~${remaining}min`);
      return;
    }
  }

  console.log(`[Scheduler] Queue has ${queueLen} items (threshold: ${RESEARCH_QUEUE_THRESHOLD}) — running research cycle`);
  try {
    const research = await runResearchLoop(eventBus);
    state.researchCyclesRun++;
    state.lastResearchAt = new Date().toISOString();
    state.researchSinceLastArchitect++;
    console.log(`[Scheduler] Research complete — ${research.autoQueued || 0} items auto-queued`);

    // Auto-trigger architect review every N research cycles
    if (state.researchSinceLastArchitect >= ARCHITECT_EVERY_N_RESEARCH) {
      console.log(`[Scheduler] ${state.researchSinceLastArchitect} research cycles since last architect review — triggering`);
      try {
        const review = await runArchitectReview(eventBus);
        state.lastArchitectAt = new Date().toISOString();
        state.researchSinceLastArchitect = 0;
        const updates = review.updatesApplied || review.review?.methodologyUpdates?.length || 0;
        console.log(`[Scheduler] Architect review complete — ${updates} methodology updates`);
      } catch (err) {
        console.error(`[Scheduler] Architect review failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Research cycle failed: ${err.message}`);
  }
}

async function runScheduledCycle(eventBus) {
  if (!state.running) return;

  // Check if research is needed (throttled)
  try {
    await maybeRunResearch(eventBus);
  } catch {}

  try {
    console.log(`[Scheduler] Starting scheduled cycle #${state.cyclesRun + 1}`);
    const result = await startCycle(eventBus);

    state.cyclesRun++;
    state.lastCycleAt = new Date().toISOString();
    state.consecutiveErrors = 0;

    if (result.error) {
      state.cyclesFailed++;
      state.lastError = result.error;
      console.log(`[Scheduler] Cycle returned error: ${result.error}`);
    } else {
      const merged = result.tasks?.some(t => t.finalState === "merged") ||
                     result.task?.finalState === "merged";
      if (merged) state.cyclesMerged++;
      state.lastError = null;
    }
  } catch (err) {
    state.cyclesRun++;
    state.cyclesFailed++;
    state.consecutiveErrors++;
    state.lastError = err.message;
    state.lastCycleAt = new Date().toISOString();
    console.error(`[Scheduler] Cycle error (${state.consecutiveErrors} consecutive):`, err.message);

    // Back off after repeated errors
    if (state.consecutiveErrors >= 5) {
      console.error(`[Scheduler] 5 consecutive errors — stopping scheduler`);
      await sendNotification({
        type: "scheduler:stopped",
        payload: {
          reason: `5 consecutive errors. Last: ${err.message}`,
          cyclesRun: state.cyclesRun,
        },
      });
      stop();
      return;
    }
  }

  // Schedule next cycle
  if (state.running) {
    const delay = state.consecutiveErrors > 0
      ? COOLDOWN_ON_ERROR_MS * state.consecutiveErrors
      : state.intervalMs;
    state.timer = setTimeout(() => runScheduledCycle(eventBus), delay);
  }
}

function start(eventBus, opts = {}) {
  if (state.running) {
    return { error: "Scheduler is already running" };
  }

  const intervalMs = opts.intervalMs || state.intervalMs || DEFAULT_INTERVAL_MS;
  if (intervalMs < MIN_INTERVAL_MS) {
    return { error: `Interval must be at least ${MIN_INTERVAL_MS}ms (${MIN_INTERVAL_MS / 1000}s)` };
  }

  state.running = true;
  state.intervalMs = intervalMs;
  state.startedAt = new Date().toISOString();
  state.consecutiveErrors = 0;

  console.log(`[Scheduler] Started — cycles every ${intervalMs / 1000}s, research throttle ${RESEARCH_MIN_INTERVAL_MS / 3600_000}h, architect every ${ARCHITECT_EVERY_N_RESEARCH} research cycles`);

  // Run first cycle immediately
  runScheduledCycle(eventBus);

  return {
    started: true,
    intervalMs,
    intervalHuman: formatDuration(intervalMs),
  };
}

function stop() {
  if (!state.running) {
    return { error: "Scheduler is not running" };
  }

  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const stoppedAt = new Date().toISOString();
  console.log(`[Scheduler] Stopped after ${state.cyclesRun} cycles`);

  return {
    stopped: true,
    cyclesRun: state.cyclesRun,
    cyclesMerged: state.cyclesMerged,
    cyclesFailed: state.cyclesFailed,
    startedAt: state.startedAt,
    stoppedAt,
  };
}

function getStatus() {
  return {
    running: state.running,
    intervalMs: state.intervalMs,
    intervalHuman: state.intervalMs ? formatDuration(state.intervalMs) : null,
    cyclesRun: state.cyclesRun,
    cyclesMerged: state.cyclesMerged,
    cyclesFailed: state.cyclesFailed,
    mergeRate: state.cyclesRun > 0 ? Math.round((state.cyclesMerged / state.cyclesRun) * 100) : 0,
    lastCycleAt: state.lastCycleAt,
    lastError: state.lastError,
    startedAt: state.startedAt,
    consecutiveErrors: state.consecutiveErrors,
    research: {
      queueThreshold: RESEARCH_QUEUE_THRESHOLD,
      minIntervalHuman: formatDuration(RESEARCH_MIN_INTERVAL_MS),
      cyclesRun: state.researchCyclesRun,
      lastResearchAt: state.lastResearchAt,
      architectEveryN: ARCHITECT_EVERY_N_RESEARCH,
      researchSinceLastArchitect: state.researchSinceLastArchitect,
      lastArchitectAt: state.lastArchitectAt,
    },
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
function autoStart(eventBus) {
  const interval = parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS);
  if (interval && interval >= MIN_INTERVAL_MS) {
    console.log(`[Scheduler] Auto-starting from HYDRA_AUTO_CYCLE_INTERVAL_MS=${interval}`);
    return start(eventBus, { intervalMs: interval });
  }
  return null;
}

export { start, stop, getStatus, autoStart };
