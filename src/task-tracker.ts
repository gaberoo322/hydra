import { canTransitionTo, isTerminal, TERMINAL_STATES, VALID_TARGETS } from "./task-machine.ts";
import type { TaskState } from "./task-machine.ts";
import { getRedisConnection } from "./redis/connection.ts";

// Inline key shapes — task-tracker is the canonical domain owner for cycle
// progress, per-task state, evidence, and dependency-hold state. Keeping the
// strings local (rather than importing from redis/keys.ts) means every key
// this module owns is defined alongside the code that reads and writes it.
const KEY_ACTIVE = "hydra:cycle:active";
const KEY_LAST = "hydra:cycle:last";
const cycleKey = (id: string) => `hydra:cycle:${id}`;
const tasksKey = (id: string) => `hydra:cycle:${id}:tasks`;
const taskKey = (id: string) => `hydra:task:${id}`;
const agentsKey = (id: string) => `hydra:cycle:${id}:agents`;
const costsKey = (id: string) => `hydra:cycle:${id}:costs`;
const evidenceKey = (taskId: string, state: string) => `hydra:task:${taskId}:evidence:${state}`;
const DEPS_COMPLETED = "hydra:deps:completed";
const DEPS_INDEX = "hydra:deps:index";
const heldKey = (id: string) => `hydra:deps:held:${id}`;

/** TTL for cycle-related Redis keys: 7 days in seconds */
const CYCLE_KEY_TTL = 7 * 24 * 60 * 60; // 604800

const TERMINAL = new Set(["completed", "failed", "timed_out", "shelved"]);

class TaskTracker {
  /**
   * Initialize a new cycle with its tasks in Redis.
   * Each task gets a hash with status, stage, title, etc.
   */
  async initCycle(cycleId, tasks) {
    const r = getRedisConnection();
    // Clear dependency state from previous cycle
    const oldHeld = await r.smembers(DEPS_INDEX);
    const cleanPipe = r.pipeline();
    cleanPipe.del(DEPS_COMPLETED, DEPS_INDEX);
    for (const id of oldHeld) cleanPipe.del(heldKey(id));
    await cleanPipe.exec();

    const pipe = r.pipeline();
    pipe.set(KEY_ACTIVE, cycleId);
    pipe.hset(cycleKey(cycleId),
      "status", "running",
      "startedAt", new Date().toISOString(),
      "total", tasks.length,
      "completed", 0,
      "failed", 0,
      "abandoned", 0,
      "timedOut", 0,
    );
    for (const task of tasks) {
      pipe.sadd(tasksKey(cycleId), task.taskId);
      pipe.hset(taskKey(task.taskId),
        "cycleId", cycleId,
        "status", "created",
        "stage", "queued",
        "title", task.title || "",
        "taskType", task.taskType || "build",
        "createdAt", new Date().toISOString(),
        "updatedAt", new Date().toISOString(),
      );
    }
    pipe.hset(costsKey(cycleId), "inputTokens", 0, "outputTokens", 0, "cachedInputTokens", 0);

    // Set 7-day TTL on all cycle-related keys
    pipe.expire(cycleKey(cycleId), CYCLE_KEY_TTL);
    pipe.expire(tasksKey(cycleId), CYCLE_KEY_TTL);
    pipe.expire(costsKey(cycleId), CYCLE_KEY_TTL);
    for (const task of tasks) {
      pipe.expire(taskKey(task.taskId), CYCLE_KEY_TTL);
    }

    await pipe.exec();
    console.log(`[TaskTracker] Initialized cycle ${cycleId} with ${tasks.length} tasks`);
  }

  /**
   * Update a task's pipeline stage (e.g., "builder", "reviewer", "tester").
   */
  async updateTaskStage(taskId, stage, agent) {
    const r = getRedisConnection();
    const exists = await r.exists(taskKey(taskId));
    if (!exists) return;
    await r.hset(taskKey(taskId),
      "stage", stage,
      "agent", agent,
      "status", "in_progress",
      "updatedAt", new Date().toISOString(),
    );
  }

  /**
   * Mark a task as terminal (completed, failed, timed_out, shelved).
   * Increments the cycle counter and checks if the cycle is done.
   * Idempotent — skips if the task is already terminal.
   */
  async markTaskDone(taskId, status, eventBus) {
    const r = getRedisConnection();
    const task = await r.hgetall(taskKey(taskId));
    if (!task.cycleId) return null;
    if (TERMINAL.has(task.status)) {
      console.log(`[TaskTracker] Task ${taskId} already ${task.status} — skipping`);
      return null;
    }

    await r.hset(taskKey(taskId),
      "status", status,
      "stage", status,
      "completedAt", new Date().toISOString(),
      "updatedAt", new Date().toISOString(),
    );

    const field = status === "completed" ? "completed" : status === "timed_out" ? "timedOut" : "failed";
    await r.hincrby(cycleKey(task.cycleId), field, 1);

    // Cascade: block any held tasks that depend on this failed/shelved task
    if ((status === "shelved" || status === "failed") && task.title) {
      await this.blockDependentsOf(task.title, eventBus);
    }

    const cycle = await r.hgetall(cycleKey(task.cycleId));
    const total = parseInt(cycle.total);
    const done = parseInt(cycle.completed) + parseInt(cycle.failed) + parseInt(cycle.timedOut);
    console.log(`[TaskTracker] Task ${taskId} → ${status} | Cycle progress: ${done}/${total}`);

    if (done >= total && cycle.status === "running") {
      await this._completeCycle(task.cycleId, eventBus);
    }
    return { done, total };
  }

  async _completeCycle(cycleId, eventBus) {
    const r = getRedisConnection();
    const cycle = await r.hgetall(cycleKey(cycleId));
    await r.hset(cycleKey(cycleId), "status", "completed", "completedAt", new Date().toISOString());
    // Refresh TTL so the 7-day window starts from cycle completion
    await r.expire(cycleKey(cycleId), CYCLE_KEY_TTL);
    await r.set(KEY_LAST, cycleId);
    await r.del(KEY_ACTIVE);

    const completed = parseInt(cycle.completed || "0");
    const failed = parseInt(cycle.failed || "0");
    const abandoned = parseInt(cycle.abandoned || "0");
    const timedOut = parseInt(cycle.timedOut || "0");
    const total = parseInt(cycle.total || "0");
    console.log(`[TaskTracker] Cycle ${cycleId} completed — ${completed} ok, ${failed} failed, ${abandoned} abandoned, ${timedOut} timed out`);

    // Meta stream publish removed in #345 — meta agent deleted; V2 control loop
    // handles its own notifications with the full reality report payload.
  }

  /**
   * Timeout all non-terminal tasks in a cycle. Used by the watchdog auto-kill.
   * Returns the number of tasks timed out.
   */
  async timeoutStaleTasks(cycleId, eventBus) {
    const r = getRedisConnection();
    const taskIds = await r.smembers(tasksKey(cycleId));
    let count = 0;
    for (const taskId of taskIds) {
      const task = await r.hgetall(taskKey(taskId));
      if (!TERMINAL.has(task.status)) {
        await this.markTaskDone(taskId, "timed_out", eventBus);
        count++;
      }
    }
    return count;
  }

  /**
   * Log an agent execution to the cycle's agent run list.
   *
   * `model` is optional (added for issue #271 cost attribution). When present
   * it lets the cost-attribution endpoint map a run to a model tier (frontier
   * / codex / mini) directly instead of falling back to an agent-role table.
   * Pre-#271 entries lack the field — src/cost/attribution.ts handles that.
   */
  async logAgentRun(cycleId, agentName, taskId, duration, verdict, usage, costUsd, model) {
    const r = getRedisConnection();
    await r.rpush(agentsKey(cycleId), JSON.stringify({
      agent: agentName, task: taskId, duration,
      verdict: verdict || "completed",
      costUsd: costUsd || 0,
      ...(model ? { model } : {}),
      timestamp: new Date().toISOString(),
    }));
    // Ensure agents list has TTL (created on first rpush)
    await r.expire(agentsKey(cycleId), CYCLE_KEY_TTL);
    if (usage) {
      const pipe = r.pipeline();
      pipe.hincrby(costsKey(cycleId), "inputTokens", usage.inputTokens || 0);
      pipe.hincrby(costsKey(cycleId), "outputTokens", usage.outputTokens || 0);
      pipe.hincrby(costsKey(cycleId), "cachedInputTokens", usage.cachedInputTokens || 0);
      // Store cost as integer microdollars to avoid floating point in Redis hincrby
      pipe.hincrby(costsKey(cycleId), "costMicrodollars", Math.round((costUsd || 0) * 1_000_000));
      await pipe.exec();
    }
  }

  /**
   * Get full cycle state including per-task detail.
   */
  async getCycleState() {
    const r = getRedisConnection();
    const cycleId = await r.get(KEY_ACTIVE);
    if (!cycleId) return { status: "idle" };

    const cycle = await r.hgetall(cycleKey(cycleId));
    const taskIds = await r.smembers(tasksKey(cycleId));
    const tasks = [];
    for (const id of taskIds) {
      tasks.push({ taskId: id, ...(await r.hgetall(taskKey(id))) });
    }

    return {
      cycleId,
      status: cycle.status,
      startedAt: cycle.startedAt,
      total: parseInt(cycle.total || "0"),
      completed: parseInt(cycle.completed || "0"),
      failed: parseInt(cycle.failed || "0"),
      abandoned: parseInt(cycle.abandoned || "0"),
      timedOut: parseInt(cycle.timedOut || "0"),
      tasks,
    };
  }

  /**
   * Get a structured cycle report (active or last completed).
   */
  async getCycleReport(cycleId) {
    const r = getRedisConnection();
    const id = cycleId || await r.get(KEY_ACTIVE) || await r.get(KEY_LAST);
    if (!id) return { cycleId: null, tasks: {}, agents: [], costs: {} };

    const cycle = await r.hgetall(cycleKey(id));
    const agents = (await r.lrange(agentsKey(id), 0, -1))
      .map((e) => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);
    const costs = await r.hgetall(costsKey(id));
    const total = parseInt(cycle.total || "0");
    const completed = parseInt(cycle.completed || "0");
    const failed = parseInt(cycle.failed || "0");
    const abandoned = parseInt(cycle.abandoned || "0");
    const timedOut = parseInt(cycle.timedOut || "0");

    return {
      cycleId: id,
      tasks: {
        total,
        completed,
        failed,
        abandoned,
        timedOut,
        inProgress: Math.max(0, total - completed - failed - abandoned - timedOut),
      },
      agents,
      costs: {
        inputTokens: parseInt(costs.inputTokens || "0"),
        outputTokens: parseInt(costs.outputTokens || "0"),
        cachedInputTokens: parseInt(costs.cachedInputTokens || "0"),
      },
    };
  }

  /**
   * Get a single task's state.
   */
  async getTaskState(taskId) {
    const r = getRedisConnection();
    return r.hgetall(taskKey(taskId));
  }

  // ---------------------------------------------------------------------------
  // V2 state machine — evidence-backed task lifecycle for control-loop.mjs
  // ---------------------------------------------------------------------------

  /**
   * Initialize a task with the v2 schema (anchored, with verification plan).
   * Used by the new control loop. Coexists with initCycle() for backward compat.
   */
  async initTaskV2(cycleId, task) {
    const r = getRedisConnection();
    const taskId = task.taskId || task.id;
    const pipe = r.pipeline();

    pipe.sadd(tasksKey(cycleId), taskId);
    pipe.hset(taskKey(taskId),
      "cycleId", cycleId,
      "state", "proposed",
      "status", "created", // backward compat with v1 readers
      "title", task.title || "",
      "taskType", task.taskType || "build",
      "anchorType", task.anchorType || "unknown",
      "anchorReference", task.anchorReference || "",
      "confidence", task.confidence || "medium",
      "verificationPlan", JSON.stringify(task.verificationPlan || []),
      "scopeBoundary", JSON.stringify(task.scopeBoundary || {}),
      "whyNow", task.whyNow || "",
      "createdAt", new Date().toISOString(),
      "updatedAt", new Date().toISOString(),
    );

    // Set 7-day TTL on task key and refresh tasks set TTL
    pipe.expire(taskKey(taskId), CYCLE_KEY_TTL);
    pipe.expire(tasksKey(cycleId), CYCLE_KEY_TTL);

    await pipe.exec();
    console.log(`[TaskTracker] Initialized v2 task ${taskId} (anchor: ${task.anchorType}, confidence: ${task.confidence})`);
  }

  /**
   * Transition a task to a new state with evidence.
   * Validates the transition is legal per VALID_TRANSITIONS.
   * Stores evidence as a separate Redis key for auditability.
   *
   * @param {string} taskId
   * @param {string} newState - Target state
   * @param {object} evidence - Proof of the transition (diff, test output, etc.)
   * @returns {{ ok: boolean, error?: string }}
   */
  async transitionTask(taskId, newState, evidence = {}) {
    const r = getRedisConnection();
    const task = await r.hgetall(taskKey(taskId));
    if (!task.cycleId) return { ok: false, error: `Task ${taskId} not found` };

    const currentState = (task.state || task.status || "proposed") as TaskState;
    const result = canTransitionTo(currentState, newState as TaskState);

    if (!result.ok) {
      const reason = (result as { ok: false; reason: string }).reason;
      console.log(`[TaskTracker] Illegal transition: ${taskId} ${currentState} → ${newState} (${reason})`);
      return { ok: false, error: reason };
    }

    // Update task state
    const updates = {
      state: newState,
      status: newState, // backward compat
      updatedAt: new Date().toISOString(),
    };
    if (isTerminal(newState as TaskState)) {
    // @ts-expect-error — migrate to proper types
      updates.completedAt = new Date().toISOString();
    }
    await r.hset(taskKey(taskId), ...Object.entries(updates).flat());

    // Store evidence
    if (Object.keys(evidence).length > 0) {
      const evidenceJson = JSON.stringify({
        ...evidence,
        transitionedAt: new Date().toISOString(),
        from: currentState,
        to: newState,
      });
      await r.set(evidenceKey(taskId, newState), evidenceJson, "EX", CYCLE_KEY_TTL);
    }

    console.log(`[TaskTracker] ${taskId}: ${currentState} → ${newState}`);

    // If terminal, update cycle counters
    if (isTerminal(newState as TaskState)) {
      const shouldCountTerminal = !isTerminal(currentState);
      if (shouldCountTerminal) {
        const field = newState === "merged" || newState === "verified"
          ? "completed"
          : newState === "abandoned"
            ? "abandoned"
            : "failed";
        await r.hincrby(cycleKey(task.cycleId), field, 1);
      }

      const cycle = await r.hgetall(cycleKey(task.cycleId));
      const total = parseInt(cycle.total);
      const done = parseInt(cycle.completed || "0") + parseInt(cycle.failed || "0") + parseInt(cycle.abandoned || "0") + parseInt(cycle.timedOut || "0");
      console.log(`[TaskTracker] Cycle progress: ${done}/${total}`);

      if (done >= total && cycle.status === "running") {
        await this._completeCycle(task.cycleId, null); // no eventBus publish in v2 — control loop handles reporting
      }
    }

    return { ok: true };
  }

  /**
   * Get a task's full evidence chain — all state transitions with their proof.
   */
  async getTaskEvidence(taskId) {
    const r = getRedisConnection();
    const states = ["proposed", "approved", "in-progress", "changed-code", "verified", "merged", "blocked", "failed", "abandoned"];
    const evidence: Record<string, any> = {};

    for (const state of states) {
      const data = await r.get(evidenceKey(taskId, state));
      if (data) {
        try { evidence[state] = JSON.parse(data); } catch { evidence[state] = data; }
      }
    }

    return evidence;
  }

  /**
   * Check if a state is terminal in the v2 state machine.
   */
  isTerminalV2(state) {
    return isTerminal(state);
  }

  // ---------------------------------------------------------------------------
  // Dependency tracking — persisted in Redis so held tasks survive restarts
  // ---------------------------------------------------------------------------

  /**
   * Check if a task's dependencies are all met.
   * Returns { proceed: true } if all met, { proceed: false, unmet: [...] } otherwise.
   */
  async checkDependenciesMet(dependencies) {
    if (!dependencies || dependencies.length === 0) return { proceed: true, unmet: [] };

    const r = getRedisConnection();
    const completed = await r.smembers(DEPS_COMPLETED);
    const completedSet = new Set(completed);
    const unmet = dependencies.filter((d) => !completedSet.has(d));

    return { proceed: unmet.length === 0, unmet };
  }

  /**
   * Hold a task in Redis until its dependencies are met.
   * The full event is stored so it can be re-published on release.
   */
  async holdTask(taskId, event, unmetDeps) {
    const r = getRedisConnection();
    await r.hset(heldKey(taskId),
      "event", JSON.stringify(event),
      "deps", JSON.stringify(unmetDeps),
    );
    await r.sadd(DEPS_INDEX, taskId);
    console.log(`[TaskTracker] Holding ${taskId} — waiting for: ${unmetDeps.join(", ")}`);
  }

  /**
   * Mark a dependency title as completed and release any held tasks whose
   * dependencies are now fully met. Returns the events to re-publish.
   */
  async releaseByTitle(completedTitle) {
    const r = getRedisConnection();
    await r.sadd(DEPS_COMPLETED, completedTitle);

    const heldIds = await r.smembers(DEPS_INDEX);
    const released = [];

    for (const taskId of heldIds) {
      const held = await r.hgetall(heldKey(taskId));
      if (!held.deps) continue;

      let deps;
      try { deps = JSON.parse(held.deps); } catch { continue; }

      const remaining = deps.filter((d) => d !== completedTitle);

      if (remaining.length === 0) {
        let event;
        try { event = JSON.parse(held.event); } catch { continue; }
        released.push(event);
        await r.del(heldKey(taskId));
        await r.srem(DEPS_INDEX, taskId);
        console.log(`[TaskTracker] Released ${taskId} — all dependencies met`);
      } else {
        await r.hset(heldKey(taskId), "deps", JSON.stringify(remaining));
      }
    }

    return released;
  }

  /**
   * Block all held tasks that depend on a failed/shelved task's title.
   * Cascade: blocked tasks trigger further blocks on their dependents.
   */
  async blockDependentsOf(failedTitle, eventBus) {
    const r = getRedisConnection();
    const heldIds = await r.smembers(DEPS_INDEX);

    for (const taskId of heldIds) {
      const held = await r.hgetall(heldKey(taskId));
      if (!held.deps) continue;

      let deps;
      try { deps = JSON.parse(held.deps); } catch { continue; }

      if (deps.includes(failedTitle)) {
        console.log(`[TaskTracker] Blocking ${taskId} — dependency "${failedTitle}" failed`);

        // Clean up held state before markTaskDone (which cascades recursively)
        await r.del(heldKey(taskId));
        await r.srem(DEPS_INDEX, taskId);

        // markTaskDone with "failed" will cascade to further dependents
        await this.markTaskDone(taskId, "failed", eventBus);
      }
    }
  }

  /**
   * On startup, check if any previously held tasks can now proceed.
   * Returns events that should be re-published to STREAMS.TASKS.
   */
  async recoverHeldTasks() {
    const r = getRedisConnection();
    const heldIds = await r.smembers(DEPS_INDEX);
    if (heldIds.length === 0) return [];

    console.log(`[TaskTracker] Checking ${heldIds.length} held tasks for recovery...`);
    const completed = await r.smembers(DEPS_COMPLETED);
    const completedSet = new Set(completed);
    const released = [];

    for (const taskId of heldIds) {
      const held = await r.hgetall(heldKey(taskId));
      if (!held.deps) continue;

      let deps;
      try { deps = JSON.parse(held.deps); } catch { continue; }

      const unmet = deps.filter((d) => !completedSet.has(d));

      if (unmet.length === 0) {
        let event;
        try { event = JSON.parse(held.event); } catch { continue; }
        released.push(event);
        await r.del(heldKey(taskId));
        await r.srem(DEPS_INDEX, taskId);
        console.log(`[TaskTracker] Recovered held task ${taskId} — all dependencies now met`);
      }
    }

    return released;
  }

  async close() {
    /* no-op: connection owned by src/redis/connection.ts singleton */
  }
}

let instance;

function createTracker(_redisUrl?: string) {
  instance = new TaskTracker();
  return instance;
}

function getTracker() {
  if (!instance) throw new Error("TaskTracker not initialized — call createTracker() first");
  return instance;
}

export { createTracker, getTracker, CYCLE_KEY_TTL };
