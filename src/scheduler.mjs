/**
 * Cycle Scheduler
 *
 * Runs development cycles on a configurable interval.
 * Controlled via API: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
 */

import { startCycle } from "./cycle.mjs";
import { sendNotification } from "./notify.mjs";
import { getTracker } from "./task-tracker.mjs";
import { runResearchLoop } from "./research-loop.mjs";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_INTERVAL_MS = 30 * 1000; // 30 seconds minimum
const COOLDOWN_ON_ERROR_MS = 60 * 1000; // 1 minute cooldown after errors
const RESEARCH_QUEUE_THRESHOLD = parseInt(process.env.HYDRA_RESEARCH_QUEUE_THRESHOLD) || 3;

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
};

async function runScheduledCycle(eventBus) {
  if (!state.running) return;

  // Check queue depth — trigger research if running low
  try {
    const queueLen = await getTracker().redis.llen("hydra:anchors:work-queue");
    if (queueLen < RESEARCH_QUEUE_THRESHOLD) {
      console.log(`[Scheduler] Queue has ${queueLen} items (threshold: ${RESEARCH_QUEUE_THRESHOLD}) — running research cycle`);
      state.lastResearchAt = new Date().toISOString();
      state.researchCyclesRun = (state.researchCyclesRun || 0) + 1;
      try {
        const research = await runResearchLoop(eventBus);
        console.log(`[Scheduler] Research complete — ${research.autoQueued || 0} items auto-queued`);
      } catch (err) {
        console.error(`[Scheduler] Research cycle failed: ${err.message}`);
      }
    }
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

  console.log(`[Scheduler] Started — running cycles every ${intervalMs / 1000}s`);

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
    researchQueueThreshold: RESEARCH_QUEUE_THRESHOLD,
    researchCyclesRun: state.researchCyclesRun || 0,
    lastResearchAt: state.lastResearchAt || null,
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
