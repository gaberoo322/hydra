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

async function getCycleStatus() {
  if (currentCycle) return currentCycle;

  const tracker = getTracker();
  const activeId = await tracker.redis.get("hydra:cycle:active");
  if (!activeId) return { status: "idle" };

  const cycle = await tracker.redis.hgetall(`hydra:cycle:${activeId}`);
  if (!cycle || !cycle.status) return { status: "idle" };

  return {
    id: activeId,
    status: cycle.status,
    startedAt: cycle.startedAt || null,
    completedAt: cycle.completedAt || null,
    total: parseInt(cycle.total || 0),
    completed: parseInt(cycle.completed || 0),
    failed: parseInt(cycle.failed || 0),
    abandoned: parseInt(cycle.abandoned || 0),
    timedOut: parseInt(cycle.timedOut || 0),
  };
}

async function getCycleHistory(limit = 10) {
  const tracker = getTracker();
  let ids = [];

  try {
    ids = await tracker.redis.keys("hydra:cycle:cycle-*");
  } catch (err) {
    console.error(`[Cycle] Failed to list cycle keys from Redis: ${err.message}`);
  }

  const seen = new Set();
  const records = [];

  for (const id of ids.filter((k) => !k.endsWith(":agents") && !k.endsWith(":costs") && !k.endsWith(":tasks")).sort().reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cycleId = id.replace(/^hydra:cycle:/, "");
    const cycle = await tracker.redis.hgetall(id);
    if (!cycle || !cycle.status) continue;
    records.push({
      id: cycleId,
      status: cycle.status,
      startedAt: cycle.startedAt || null,
      completedAt: cycle.completedAt || null,
      total: parseInt(cycle.total || 0),
      completed: parseInt(cycle.completed || 0),
      failed: parseInt(cycle.failed || 0),
      abandoned: parseInt(cycle.abandoned || 0),
      timedOut: parseInt(cycle.timedOut || 0),
    });
    if (records.length >= limit) break;
  }

  if (records.length > 0) {
    return records;
  }

  return [];
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
