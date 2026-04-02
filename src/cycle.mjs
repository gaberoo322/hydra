import { getTracker } from "./task-tracker.mjs";
import { runControlLoop } from "./control-loop.mjs";

// Cycle state
let currentCycle = null;
const cycleHistory = [];

// ---------------------------------------------------------------------------
// Cycle execution — V2 control loop only
// ---------------------------------------------------------------------------

async function startCycle(eventBus, opts = {}) {
  // Synchronous mutex — set BEFORE any await to prevent concurrent cycles.
  // Node.js is single-threaded, so this flag is checked atomically.
  if (currentCycle?.status === "running") {
    return { error: "A cycle is already running", cycle: currentCycle };
  }

  currentCycle = { id: "pending", status: "running", startedAt: new Date().toISOString() };
  try {
    const result = await runControlLoop(eventBus, { anchor: opts?.anchor });
    currentCycle = {
      id: result.cycleId,
      status: "completed",
      startedAt: currentCycle.startedAt,
      completedAt: new Date().toISOString(),
      tasks: result.tasks || [],
      result,
    };
    cycleHistory.push({ ...currentCycle });
    const completed = currentCycle;
    currentCycle = null;
    return { cycle: completed, ...result };
  } catch (err) {
    const errorMsg = err?.message || String(err);
    if (currentCycle) {
      currentCycle.status = "failed";
      currentCycle.error = errorMsg;
      currentCycle.completedAt = new Date().toISOString();
      cycleHistory.push({ ...currentCycle });
    }
    currentCycle = null;
    return { error: errorMsg, cycle: { status: "failed" } };
  }
}

function getCycleStatus() {
  return currentCycle || { status: "idle" };
}

function getCycleHistory(limit = 10) {
  return cycleHistory.slice(-limit);
}

async function killCycle(eventBus) {
  if (currentCycle?.status === "running") {
    try {
      const timedOut = await getTracker().timeoutStaleTasks(currentCycle.id, eventBus);
      console.log(`[Cycle] Killed cycle ${currentCycle.id} — ${timedOut} tasks timed out`);
    } catch (err) {
      console.error(`[Cycle] Error timing out tasks:`, err.message);
    }

    currentCycle.status = "killed";
    currentCycle.completedAt = new Date().toISOString();
    cycleHistory.push({ ...currentCycle });
    const killed = currentCycle;
    currentCycle = null;
    return { killed: true, cycle: killed };
  }
  return { killed: false, reason: "No running cycle" };
}

export { startCycle, getCycleStatus, getCycleHistory, killCycle };
