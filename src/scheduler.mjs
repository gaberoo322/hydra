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
import { getMetricsTrend } from "./metrics.mjs";
import { getBacklogCounts, promoteToQueued, pruneOldDoneItems } from "./backlog.mjs";
import { getTracker } from "./task-tracker.mjs";
import { runResearchLoop } from "./research-loop.mjs";
// research-architect removed — methodology files are frozen at current state

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_INTERVAL_MS = 30 * 1000; // 30 seconds minimum
const COOLDOWN_ON_ERROR_MS = 60 * 1000; // 1 minute cooldown after errors

const RESEARCH_QUEUE_THRESHOLD = parseInt(process.env.HYDRA_RESEARCH_QUEUE_THRESHOLD) || 3;
const RESEARCH_MIN_INTERVAL_MS = parseInt(process.env.HYDRA_RESEARCH_MIN_INTERVAL_MS) || 2 * 60 * 60 * 1000; // 2 hours
// ARCHITECT_EVERY_N_RESEARCH removed — research-architect module disconnected
const DAILY_COST_CAP_USD = parseFloat(process.env.HYDRA_DAILY_COST_CAP_USD) || Infinity;
const REPETITION_WINDOW = parseInt(process.env.HYDRA_REPETITION_WINDOW) || 5; // Check last N cycles
const REPETITION_THRESHOLD = parseFloat(process.env.HYDRA_REPETITION_THRESHOLD) || 0.5; // Pause if >50% of recent titles are similar

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
};

// ---------------------------------------------------------------------------
// Scheduler state persistence
// ---------------------------------------------------------------------------
//
// The scheduler's in-memory `state` was being reset on every orchestrator
// restart, which silently cleared the research-throttle (`lastResearchAt`)
// and the architect counter (`researchSinceLastArchitect`). On the next
// scheduler tick after restart, an empty queue + null lastResearchAt
// triggered an immediate, unwanted research cycle costing ~$3-8 in Codex.
//
// We now persist the research-related fields to Redis under
// SCHEDULER_STATE_KEY. On startup, loadSchedulerState() merges the stored
// values into `state` before the first tick. After every research cycle
// and architect review, saveSchedulerState() writes the updated fields
// back to Redis. Non-research counters (cyclesRun, cyclesMerged, etc.)
// still reset on restart — they're per-session metrics, not throttle state.

const SCHEDULER_STATE_KEY = "hydra:scheduler:state";

async function loadSchedulerState() {
  try {
    const raw = await getTracker().redis.get(SCHEDULER_STATE_KEY);
    if (!raw) {
      console.log("[Scheduler] No persisted state in Redis — starting fresh");
      return;
    }
    const stored = JSON.parse(raw);
    if (stored.lastResearchAt) state.lastResearchAt = stored.lastResearchAt;
    if (typeof stored.researchCyclesRun === "number") {
      state.researchCyclesRun = stored.researchCyclesRun;
    }
    console.log(`[Scheduler] Loaded persisted state — lastResearchAt=${state.lastResearchAt}`);
  } catch (err) {
    console.error(`[Scheduler] Failed to load persisted state: ${err.message}`);
  }
}

async function saveSchedulerState() {
  try {
    const payload = {
      lastResearchAt: state.lastResearchAt,
      researchCyclesRun: state.researchCyclesRun,
      savedAt: new Date().toISOString(),
    };
    await getTracker().redis.set(SCHEDULER_STATE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.error(`[Scheduler] Failed to save state: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Daily Codex spend cap
// ---------------------------------------------------------------------------
//
// Hydra's Codex usage is bucketed on a weekly quota (ChatGPT subscription),
// and in practice the bucket has been exhausted in ~3 days of unconstrained
// research runs. The 2026-04-02/04 window saw $118+ of research spend and
// then locked the quota until 2026-04-08 01:03 PDT, during which every
// research cycle and every architect review failed silently.
//
// To prevent that recurrence: track daily research spend in Redis under
// SCHEDULER_SPEND_KEY. Before each research cycle, check against
// DAILY_COST_CAP_USD. If exceeded, skip research and notify the operator.
// After each research cycle, add the reported cost to the counter. Counter
// resets automatically when the date rolls over (in local time).
//
// Control-loop agents (planner / skeptic / executor) don't self-report cost,
// so they aren't counted — this cap gates the largest single cost driver
// (research) rather than trying to be a perfect budget. Accept the
// incompleteness in exchange for no changes to the control-loop hot path.

const SCHEDULER_SPEND_KEY = "hydra:scheduler:daily-spend";

function todayLocalDate() {
  // Use local date so the counter resets at local midnight, not UTC midnight.
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function getDailySpend() {
  try {
    const raw = await getTracker().redis.get(SCHEDULER_SPEND_KEY);
    if (!raw) return { date: todayLocalDate(), usd: 0 };
    const stored = JSON.parse(raw);
    if (stored.date !== todayLocalDate()) {
      // Roll over — return a fresh zero for today
      return { date: todayLocalDate(), usd: 0 };
    }
    return stored;
  } catch {
    return { date: todayLocalDate(), usd: 0 };
  }
}

async function recordSpend(amountUsd) {
  try {
    const current = await getDailySpend();
    const updated = {
      date: current.date,
      usd: (current.usd || 0) + (amountUsd || 0),
      updatedAt: new Date().toISOString(),
    };
    await getTracker().redis.set(SCHEDULER_SPEND_KEY, JSON.stringify(updated));
    return updated;
  } catch (err) {
    console.error(`[Scheduler] Failed to record spend: ${err.message}`);
    return null;
  }
}

/**
 * Detect if recent cycles are producing repetitive work.
 * Compares task titles using word overlap — if too many recent cycles
 * look similar, pauses the scheduler and notifies the operator.
 *
 * Returns true if the scheduler was paused.
 */
async function detectRepetition(eventBus) {
  try {
    const trend = await getMetricsTrend(REPETITION_WINDOW);
    if (trend.length < REPETITION_WINDOW) return false; // not enough data

    const titles = trend.map(m => m.taskTitle).filter(Boolean);
    if (titles.length < REPETITION_WINDOW) return false;

    // Count pairwise similarities — how many pairs of titles are >60% similar?
    let similarPairs = 0;
    let totalPairs = 0;
    for (let i = 0; i < titles.length; i++) {
      for (let j = i + 1; j < titles.length; j++) {
        totalPairs++;
        const wordsA = new Set(titles[i].toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const wordsB = new Set(titles[j].toLowerCase().split(/\s+/).filter(w => w.length > 3));
        if (wordsA.size === 0 || wordsB.size === 0) continue;
        const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
        const similarity = overlap / Math.max(wordsA.size, wordsB.size);
        if (similarity > 0.6) similarPairs++;
      }
    }

    const repetitionRate = totalPairs > 0 ? similarPairs / totalPairs : 0;

    if (repetitionRate >= REPETITION_THRESHOLD) {
      console.log(`[Scheduler] REPETITION DETECTED: ${Math.round(repetitionRate * 100)}% of last ${REPETITION_WINDOW} cycle pairs are similar — pausing for operator direction`);
      console.log(`[Scheduler] Recent titles: ${titles.map(t => `"${t.slice(0, 60)}"`).join(", ")}`);

      await sendNotification({
        type: "scheduler:paused_repetition",
        payload: {
          reason: `${Math.round(repetitionRate * 100)}% of the last ${REPETITION_WINDOW} cycles produced similar tasks. Hydra needs new direction.`,
          recentTitles: titles.slice(0, 5),
          suggestion: "Update priorities.md, run a research cycle, or queue specific work. Then restart the scheduler.",
          cyclesRun: state.cyclesRun,
        },
      });

      stop();
      return true;
    }
  } catch (err) {
    console.error(`[Scheduler] Repetition detection error: ${err.message}`);
  }
  return false;
}

async function maybeRunResearch(eventBus) {
  // Prune old done items from backlog
  try { await pruneOldDoneItems(); } catch {}

  // Check queue depth
  const queueLen = await getTracker().redis.llen("hydra:anchors:work-queue");
  if (queueLen >= RESEARCH_QUEUE_THRESHOLD) return;

  // If queue is low but backlog has items, promote from backlog first
  try {
    const counts = await getBacklogCounts();
    if (counts.backlog > 0) {
      const needed = RESEARCH_QUEUE_THRESHOLD - queueLen;
      const promoted = await promoteToQueued(needed);
      if (promoted.length > 0) {
        // Push promoted items into Redis queue
        for (const item of promoted) {
          await getTracker().redis.rpush("hydra:anchors:work-queue", JSON.stringify({
            reference: item.title,
            reason: `Promoted from backlog (score: ${item.meta?.score || "?"}, ${item.meta?.confidence || "?"} confidence)`,
            context: JSON.stringify(item.meta || {}),
            queuedAt: new Date().toISOString(),
            source: "backlog",
          }));
        }
        console.log(`[Scheduler] Promoted ${promoted.length} items from backlog to queue`);
        return; // Queue is now filled, no need for research
      }
    }

    // Alert if backlog AND queue are both empty
    if (counts.total === 0 && counts.inProgress === 0) {
      console.log(`[Scheduler] Backlog and queue are both empty`);
      await sendNotification({
        type: "scheduler:backlog_empty",
        payload: {
          message: "Backlog and work queue are both empty. Hydra needs new direction or a research cycle.",
          suggestion: "Update priorities.md, run POST /research/start, or queue work with POST /queue.",
        },
      });
    }
  } catch (err) {
    console.error(`[Scheduler] Backlog check failed: ${err.message}`);
  }

  // Check throttle — don't run research more often than the minimum interval
  if (state.lastResearchAt) {
    const elapsed = Date.now() - new Date(state.lastResearchAt).getTime();
    if (elapsed < RESEARCH_MIN_INTERVAL_MS) {
      const remaining = Math.round((RESEARCH_MIN_INTERVAL_MS - elapsed) / 60_000);
      console.log(`[Scheduler] Queue low (${queueLen}) but research throttled — next research in ~${remaining}min`);
      return;
    }
  }

  // Check daily spend cap — refuse to start research if today's budget is exhausted.
  // Reason: the Codex weekly quota caught us on 2026-04-02/08. See kanban-scope
  // decision + Spending dashboard in the vault.
  const spend = await getDailySpend();
  if (spend.usd >= DAILY_COST_CAP_USD) {
    console.log(`[Scheduler] Daily spend cap reached — $${spend.usd.toFixed(2)} >= $${DAILY_COST_CAP_USD.toFixed(2)}, skipping research`);
    try {
      await sendNotification({
        type: "scheduler:spend_cap_reached",
        payload: {
          message: `Daily research spend cap reached: $${spend.usd.toFixed(2)} of $${DAILY_COST_CAP_USD.toFixed(2)}. Research paused until local midnight.`,
          date: spend.date,
          spentUsd: spend.usd,
          capUsd: DAILY_COST_CAP_USD,
        },
      });
    } catch {}
    return;
  }

  console.log(`[Scheduler] Queue has ${queueLen} items (threshold: ${RESEARCH_QUEUE_THRESHOLD}) — running research cycle (daily spend: $${spend.usd.toFixed(2)} of $${DAILY_COST_CAP_USD.toFixed(2)})`);
  try {
    const research = await runResearchLoop(eventBus);
    state.researchCyclesRun++;
    state.lastResearchAt = new Date().toISOString();
    // research-architect counter removed
    await saveSchedulerState();

    // Track research spend against the daily cap.
    const researchCost = research?.cost?.totalUsd || 0;
    if (researchCost > 0) {
      const updated = await recordSpend(researchCost);
      if (updated) {
        console.log(`[Scheduler] Daily research spend: $${updated.usd.toFixed(2)} of $${DAILY_COST_CAP_USD.toFixed(2)}`);
      }
    }
    console.log(`[Scheduler] Research complete — ${research.autoQueued || 0} items auto-queued`);
    // Priorities refresh is handled inside the research loop by the
    // research-strategist (Step 5.5) — it has the richest context.
    // Research architect removed — methodology files are frozen at current state.
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

      // Check for repetitive work pattern
      if (await detectRepetition(eventBus)) return; // scheduler was paused
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

  // Schedule next cycle — immediate if there's work, delayed if idle
  if (state.running) {
    let delay;
    if (state.consecutiveErrors > 0) {
      // Back off on errors
      delay = COOLDOWN_ON_ERROR_MS * state.consecutiveErrors;
    } else {
      // Check if there's work waiting — if so, start immediately
      const queueLen = await getTracker().redis.llen("hydra:anchors:work-queue").catch(() => 0);
      const hadWork = !result?.reason?.includes("No actionable anchor") &&
                      !result?.reason?.includes("No work needed") &&
                      !result?.reason?.includes("Planner produced no task");
      if (queueLen > 0 || hadWork) {
        delay = 0; // work available — no idle gap
      } else {
        delay = state.intervalMs; // queue empty — wait before trying again
      }
    }
    if (delay === 0) {
      console.log(`[Scheduler] Work available — starting next cycle immediately`);
    }
    state.timer = setTimeout(() => runScheduledCycle(eventBus), delay);
  }
}

async function start(eventBus, opts = {}) {
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

  console.log(`[Scheduler] Started — cycles every ${intervalMs / 1000}s, research throttle ${RESEARCH_MIN_INTERVAL_MS / 3600_000}h`);

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

async function getStatus() {
  const spend = await getDailySpend();
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
      dailyCostCapUsd: DAILY_COST_CAP_USD,
      dailySpendUsd: spend.usd,
      dailySpendDate: spend.date,
    },
    repetition: {
      window: REPETITION_WINDOW,
      threshold: `${Math.round(REPETITION_THRESHOLD * 100)}%`,
      pausedForRepetition: state.pausedForRepetition || false,
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
async function autoStart(eventBus) {
  const interval = parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS);
  if (interval && interval >= MIN_INTERVAL_MS) {
    console.log(`[Scheduler] Auto-starting from HYDRA_AUTO_CYCLE_INTERVAL_MS=${interval}`);
    return await start(eventBus, { intervalMs: interval });
  }
  return null;
}

export { start, stop, getStatus, autoStart };
