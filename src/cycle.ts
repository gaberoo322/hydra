import { getTracker } from "./task-tracker.ts";
import { runControlLoop } from "./control-loop.ts";
import { redisKeys } from "./redis-keys.ts";

interface CycleRecord {
  id: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  total?: number;
  completed?: number;
  failed?: number;
  abandoned?: number;
  timedOut?: number;
  tasks?: any[];
  result?: any;
  error?: string;
}

// Cycle state
let currentCycle: CycleRecord | null = null;
const cycleHistory: CycleRecord[] = [];

async function startCycle(eventBus: any, opts: any = {}) {
  if (currentCycle?.status === "running") {
    return { error: "A cycle is already running", cycle: currentCycle };
  }

  currentCycle = { id: "pending", status: "running", startedAt: new Date().toISOString() };
  try {
    const result: any = await runControlLoop(eventBus, { anchor: opts?.anchor });
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
  } catch (err: any) {
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

async function getCycleStatus(): Promise<CycleRecord | { status: string }> {
  if (currentCycle) return currentCycle;

  const tracker = getTracker();
  const activeId = await tracker.getRedisClient().get(redisKeys.cycleActive());
  if (!activeId) return { status: "idle" };

  const cycle = await tracker.getRedisClient().hgetall(redisKeys.cycle(activeId));
  if (!cycle || !cycle.status) return { status: "idle" };

  return {
    id: activeId,
    status: cycle.status,
    startedAt: cycle.startedAt || null,
    completedAt: cycle.completedAt || null,
    total: parseInt(cycle.total || "0"),
    completed: parseInt(cycle.completed || "0"),
    failed: parseInt(cycle.failed || "0"),
    abandoned: parseInt(cycle.abandoned || "0"),
    timedOut: parseInt(cycle.timedOut || "0"),
  };
}

async function getCycleHistory(limit = 10): Promise<CycleRecord[]> {
  const tracker = getTracker();
  let ids: string[] = [];

  try {
    ids = await tracker.getRedisClient().keys(redisKeys.cycle("cycle-*"));
  } catch (err: any) {
    console.error(`[Cycle] Failed to list cycle keys from Redis: ${err.message}`);
  }

  const seen = new Set<string>();
  const records: CycleRecord[] = [];

  for (const id of ids.filter((k: string) => !k.endsWith(":agents") && !k.endsWith(":costs") && !k.endsWith(":tasks")).sort().reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cycleId = id.replace(new RegExp(`^${redisKeys.cycle("")}`), "");
    const cycle = await tracker.getRedisClient().hgetall(id);
    if (!cycle || !cycle.status) continue;
    records.push({
      id: cycleId,
      status: cycle.status,
      startedAt: cycle.startedAt || null,
      completedAt: cycle.completedAt || null,
      total: parseInt(cycle.total || "0"),
      completed: parseInt(cycle.completed || "0"),
      failed: parseInt(cycle.failed || "0"),
      abandoned: parseInt(cycle.abandoned || "0"),
      timedOut: parseInt(cycle.timedOut || "0"),
    });
    if (records.length >= limit) break;
  }

  return records;
}

async function killCycle(eventBus: any) {
  if (currentCycle?.status === "running") {
    try {
      const timedOut = await getTracker().timeoutStaleTasks(currentCycle.id, eventBus);
      console.log(`[Cycle] Killed cycle ${currentCycle.id} — ${timedOut} tasks timed out`);
    } catch (err: any) {
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
