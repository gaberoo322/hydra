import Redis from "ioredis";
import { STREAMS } from "./event-bus.ts";
import { redisKeys } from "./redis-keys.ts";
import { canTransitionTo, isTerminal, TERMINAL_STATES, VALID_TARGETS } from "./task-machine.ts";
import type { TaskState } from "./task-machine.ts";

const KEY_ACTIVE = redisKeys.cycleActive();
const KEY_LAST = redisKeys.cycleLast();
const cycleKey = (id) => redisKeys.cycle(id);
const tasksKey = (id) => redisKeys.cycleTasks(id);
const taskKey = (id) => redisKeys.task(id);
const agentsKey = (id) => redisKeys.cycleAgents(id);
const costsKey = (id) => redisKeys.cycleCosts(id);

/** TTL for cycle-related Redis keys: 7 days in seconds */
const CYCLE_KEY_TTL = 7 * 24 * 60 * 60; // 604800

const TERMINAL = new Set(["completed", "failed", "timed_out", "shelved"]);

const evidenceKey = (taskId, state) => redisKeys.taskEvidence(taskId, state);

// Dependency tracking keys
const DEPS_COMPLETED = redisKeys.depsCompleted();
const DEPS_INDEX = redisKeys.depsIndex();
const heldKey = (id) => redisKeys.depsHeld(id);

class TaskTracker {
  private _redis: any;
  constructor(redisUrl: string) {
    this._redis = new Redis(redisUrl);
  }

  /** Redis client accessor — prefer dedicated methods over raw Redis calls. */
  getRedisClient() {
    return this._redis;
  }

  /**
   * Initialize a new cycle with its tasks in Redis.
   * Each task gets a hash with status, stage, title, etc.
   */
  async initCycle(cycleId, tasks) {
    // Clear dependency state from previous cycle
    const oldHeld = await this._redis.smembers(DEPS_INDEX);
    const cleanPipe = this._redis.pipeline();
    cleanPipe.del(DEPS_COMPLETED, DEPS_INDEX);
    for (const id of oldHeld) cleanPipe.del(heldKey(id));
    await cleanPipe.exec();

    const pipe = this._redis.pipeline();
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
    const exists = await this._redis.exists(taskKey(taskId));
    if (!exists) return;
    await this._redis.hset(taskKey(taskId),
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
    const task = await this._redis.hgetall(taskKey(taskId));
    if (!task.cycleId) return null;
    if (TERMINAL.has(task.status)) {
      console.log(`[TaskTracker] Task ${taskId} already ${task.status} — skipping`);
      return null;
    }

    await this._redis.hset(taskKey(taskId),
      "status", status,
      "stage", status,
      "completedAt", new Date().toISOString(),
      "updatedAt", new Date().toISOString(),
    );

    const field = status === "completed" ? "completed" : status === "timed_out" ? "timedOut" : "failed";
    await this._redis.hincrby(cycleKey(task.cycleId), field, 1);

    // Cascade: block any held tasks that depend on this failed/shelved task
    if ((status === "shelved" || status === "failed") && task.title) {
      await this.blockDependentsOf(task.title, eventBus);
    }

    const cycle = await this._redis.hgetall(cycleKey(task.cycleId));
    const total = parseInt(cycle.total);
    const done = parseInt(cycle.completed) + parseInt(cycle.failed) + parseInt(cycle.timedOut);
    console.log(`[TaskTracker] Task ${taskId} → ${status} | Cycle progress: ${done}/${total}`);

    if (done >= total && cycle.status === "running") {
      await this._completeCycle(task.cycleId, eventBus);
    }
    return { done, total };
  }

  async _completeCycle(cycleId, eventBus) {
    const cycle = await this._redis.hgetall(cycleKey(cycleId));
    await this._redis.hset(cycleKey(cycleId), "status", "completed", "completedAt", new Date().toISOString());
    // Refresh TTL so the 7-day window starts from cycle completion
    await this._redis.expire(cycleKey(cycleId), CYCLE_KEY_TTL);
    await this._redis.set(KEY_LAST, cycleId);
    await this._redis.del(KEY_ACTIVE);

    const completed = parseInt(cycle.completed || 0);
    const failed = parseInt(cycle.failed || 0);
    const abandoned = parseInt(cycle.abandoned || 0);
    const timedOut = parseInt(cycle.timedOut || 0);
    const total = parseInt(cycle.total || 0);
    console.log(`[TaskTracker] Cycle ${cycleId} completed — ${completed} ok, ${failed} failed, ${abandoned} abandoned, ${timedOut} timed out`);

    // Only publish to Meta stream — the V2 control loop handles notifications
    // with the full reality report payload (task title, grounding, commit, etc.)
    if (eventBus) {
      await eventBus.publish(STREAMS.META, {
        type: "cycle:report",
        source: "orchestrator",
        correlationId: cycleId,
        payload: { trigger: "all_tasks_complete", total, completed, failed, abandoned, timedOut },
      });
    }
  }

  /**
   * Timeout all non-terminal tasks in a cycle. Used by the watchdog auto-kill.
   * Returns the number of tasks timed out.
   */
  async timeoutStaleTasks(cycleId, eventBus) {
    const taskIds = await this._redis.smembers(tasksKey(cycleId));
    let count = 0;
    for (const taskId of taskIds) {
      const task = await this._redis.hgetall(taskKey(taskId));
      if (!TERMINAL.has(task.status)) {
        await this.markTaskDone(taskId, "timed_out", eventBus);
        count++;
      }
    }
    return count;
  }

  /**
   * Log an agent execution to the cycle's agent run list.
   */
  async logAgentRun(cycleId, agentName, taskId, duration, verdict, usage, costUsd) {
    await this._redis.rpush(agentsKey(cycleId), JSON.stringify({
      agent: agentName, task: taskId, duration,
      verdict: verdict || "completed",
      costUsd: costUsd || 0,
      timestamp: new Date().toISOString(),
    }));
    // Ensure agents list has TTL (created on first rpush)
    await this._redis.expire(agentsKey(cycleId), CYCLE_KEY_TTL);
    if (usage) {
      const pipe = this._redis.pipeline();
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
    const cycleId = await this._redis.get(KEY_ACTIVE);
    if (!cycleId) return { status: "idle" };

    const cycle = await this._redis.hgetall(cycleKey(cycleId));
    const taskIds = await this._redis.smembers(tasksKey(cycleId));
    const tasks = [];
    for (const id of taskIds) {
      tasks.push({ taskId: id, ...(await this._redis.hgetall(taskKey(id))) });
    }

    return {
      cycleId,
      status: cycle.status,
      startedAt: cycle.startedAt,
      total: parseInt(cycle.total || 0),
      completed: parseInt(cycle.completed || 0),
      failed: parseInt(cycle.failed || 0),
      abandoned: parseInt(cycle.abandoned || 0),
      timedOut: parseInt(cycle.timedOut || 0),
      tasks,
    };
  }

  /**
   * Get a structured cycle report (active or last completed).
   */
  async getCycleReport(cycleId) {
    const id = cycleId || await this._redis.get(KEY_ACTIVE) || await this._redis.get(KEY_LAST);
    if (!id) return { cycleId: null, tasks: {}, agents: [], costs: {} };

    const cycle = await this._redis.hgetall(cycleKey(id));
    const agents = (await this._redis.lrange(agentsKey(id), 0, -1))
      .map((e) => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);
    const costs = await this._redis.hgetall(costsKey(id));
    const total = parseInt(cycle.total || 0);
    const completed = parseInt(cycle.completed || 0);
    const failed = parseInt(cycle.failed || 0);
    const abandoned = parseInt(cycle.abandoned || 0);
    const timedOut = parseInt(cycle.timedOut || 0);

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
        inputTokens: parseInt(costs.inputTokens || 0),
        outputTokens: parseInt(costs.outputTokens || 0),
        cachedInputTokens: parseInt(costs.cachedInputTokens || 0),
      },
    };
  }

  /**
   * Get a single task's state.
   */
  async getTaskState(taskId) {
    return this._redis.hgetall(taskKey(taskId));
  }

  // ---------------------------------------------------------------------------
  // V2 state machine — evidence-backed task lifecycle for control-loop.mjs
  // ---------------------------------------------------------------------------

  /**
   * Initialize a task with the v2 schema (anchored, with verification plan).
   * Used by the new control loop. Coexists with initCycle() for backward compat.
   */
  async initTaskV2(cycleId, task) {
    const taskId = task.taskId || task.id;
    const pipe = this._redis.pipeline();

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
    const task = await this._redis.hgetall(taskKey(taskId));
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
    await this._redis.hset(taskKey(taskId), ...Object.entries(updates).flat());

    // Store evidence
    if (Object.keys(evidence).length > 0) {
      const evidenceJson = JSON.stringify({
        ...evidence,
        transitionedAt: new Date().toISOString(),
        from: currentState,
        to: newState,
      });
      await this._redis.set(evidenceKey(taskId, newState), evidenceJson, "EX", CYCLE_KEY_TTL);
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
        await this._redis.hincrby(cycleKey(task.cycleId), field, 1);
      }

      const cycle = await this._redis.hgetall(cycleKey(task.cycleId));
      const total = parseInt(cycle.total);
      const done = parseInt(cycle.completed || 0) + parseInt(cycle.failed || 0) + parseInt(cycle.abandoned || 0) + parseInt(cycle.timedOut || 0);
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
    const states = ["proposed", "approved", "in-progress", "changed-code", "verified", "merged", "blocked", "failed", "abandoned"];
    const evidence: Record<string, any> = {};

    for (const state of states) {
      const data = await this._redis.get(evidenceKey(taskId, state));
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

    const completed = await this._redis.smembers(DEPS_COMPLETED);
    const completedSet = new Set(completed);
    const unmet = dependencies.filter((d) => !completedSet.has(d));

    return { proceed: unmet.length === 0, unmet };
  }

  /**
   * Hold a task in Redis until its dependencies are met.
   * The full event is stored so it can be re-published on release.
   */
  async holdTask(taskId, event, unmetDeps) {
    await this._redis.hset(heldKey(taskId),
      "event", JSON.stringify(event),
      "deps", JSON.stringify(unmetDeps),
    );
    await this._redis.sadd(DEPS_INDEX, taskId);
    console.log(`[TaskTracker] Holding ${taskId} — waiting for: ${unmetDeps.join(", ")}`);
  }

  /**
   * Mark a dependency title as completed and release any held tasks whose
   * dependencies are now fully met. Returns the events to re-publish.
   */
  async releaseByTitle(completedTitle) {
    await this._redis.sadd(DEPS_COMPLETED, completedTitle);

    const heldIds = await this._redis.smembers(DEPS_INDEX);
    const released = [];

    for (const taskId of heldIds) {
      const held = await this._redis.hgetall(heldKey(taskId));
      if (!held.deps) continue;

      let deps;
      try { deps = JSON.parse(held.deps); } catch { continue; }

      const remaining = deps.filter((d) => d !== completedTitle);

      if (remaining.length === 0) {
        let event;
        try { event = JSON.parse(held.event); } catch { continue; }
        released.push(event);
        await this._redis.del(heldKey(taskId));
        await this._redis.srem(DEPS_INDEX, taskId);
        console.log(`[TaskTracker] Released ${taskId} — all dependencies met`);
      } else {
        await this._redis.hset(heldKey(taskId), "deps", JSON.stringify(remaining));
      }
    }

    return released;
  }

  /**
   * Block all held tasks that depend on a failed/shelved task's title.
   * Cascade: blocked tasks trigger further blocks on their dependents.
   */
  async blockDependentsOf(failedTitle, eventBus) {
    const heldIds = await this._redis.smembers(DEPS_INDEX);

    for (const taskId of heldIds) {
      const held = await this._redis.hgetall(heldKey(taskId));
      if (!held.deps) continue;

      let deps;
      try { deps = JSON.parse(held.deps); } catch { continue; }

      if (deps.includes(failedTitle)) {
        console.log(`[TaskTracker] Blocking ${taskId} — dependency "${failedTitle}" failed`);

        // Clean up held state before markTaskDone (which cascades recursively)
        await this._redis.del(heldKey(taskId));
        await this._redis.srem(DEPS_INDEX, taskId);

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
    const heldIds = await this._redis.smembers(DEPS_INDEX);
    if (heldIds.length === 0) return [];

    console.log(`[TaskTracker] Checking ${heldIds.length} held tasks for recovery...`);
    const completed = await this._redis.smembers(DEPS_COMPLETED);
    const completedSet = new Set(completed);
    const released = [];

    for (const taskId of heldIds) {
      const held = await this._redis.hgetall(heldKey(taskId));
      if (!held.deps) continue;

      let deps;
      try { deps = JSON.parse(held.deps); } catch { continue; }

      const unmet = deps.filter((d) => !completedSet.has(d));

      if (unmet.length === 0) {
        let event;
        try { event = JSON.parse(held.event); } catch { continue; }
        released.push(event);
        await this._redis.del(heldKey(taskId));
        await this._redis.srem(DEPS_INDEX, taskId);
        console.log(`[TaskTracker] Recovered held task ${taskId} — all dependencies now met`);
      }
    }

    return released;
  }

  async close() {
    this._redis.disconnect();
  }
}

let instance;

function createTracker(redisUrl) {
  instance = new TaskTracker(redisUrl);
  return instance;
}

function getTracker() {
  if (!instance) throw new Error("TaskTracker not initialized — call createTracker() first");
  return instance;
}

export { createTracker, getTracker, CYCLE_KEY_TTL };
