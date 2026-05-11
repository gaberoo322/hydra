/**
 * Cycle Scheduler
 *
 * Runs development cycles on a configurable interval.
 * Auto-triggers research when the work queue runs low (throttled).
 * Auto-triggers architect review every N research cycles.
 *
 * Controlled via API: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
 */

import * as Sentry from "@sentry/node";
import { startCycle } from "./cycle.ts";
import { sendNotification } from "./notify.ts";
import { getMetricsTrend } from "./metrics.ts";
import { _admin } from "./backlog.ts";
const { getBacklogCounts, promoteToQueued, pruneOldDoneItems } = _admin;
import { runResearchLoop } from "./research-loop.ts";
import { getPerCycleCostCapUsd } from "./cost-cap.ts";
import { redisKeys } from "./redis-keys.ts";
import { getTargetName } from "./target-config.ts";
import {
  getString, setString, getWorkQueueLen, pushToWorkQueue,
  hashGet, hashSetField,
  recordResearchEvent, recordBuildEvent,
  getResearchEventCount24h, getBuildEventCount24h,
  consumeResearchForceOnce,
  listLPop, listLen,
  incrSchedulerCyclesRun, getSchedulerCyclesRun,
  incrSchedulerCyclesMerged, getSchedulerCyclesMerged,
  incrSchedulerCyclesFailed, getSchedulerCyclesFailed,
  atomicClaimResearch, getLastResearchAtMs, setLastResearchAt,
  saveSchedulerStateVersioned, getSchedulerStateVersion,
} from "./redis-adapter.ts";
// Reframe queue key + interleave interval (internalized in anchor-selection.ts, issue #70)
const REFRAME_QUEUE = "hydra:anchors:reframe-queue";
const REFRAME_INTERLEAVE_INTERVAL = 5;
// research-architect removed — methodology files are frozen at current state

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_INTERVAL_MS = 30 * 1000; // 30 seconds minimum
const COOLDOWN_ON_ERROR_MS = 60 * 1000; // 1 minute cooldown after errors

const RESEARCH_QUEUE_THRESHOLD = parseInt(process.env.HYDRA_RESEARCH_QUEUE_THRESHOLD) || 6;
const RESEARCH_BUILD_RATIO_MAX = parseFloat(process.env.HYDRA_RESEARCH_BUILD_RATIO_MAX) || 3;
const RESEARCH_MIN_INTERVAL_MS = parseInt(process.env.HYDRA_RESEARCH_MIN_INTERVAL_MS) || 2 * 60 * 60 * 1000; // 2 hours
// ARCHITECT_EVERY_N_RESEARCH removed — research-architect module disconnected
const DAILY_COST_CAP_USD = parseFloat(process.env.HYDRA_DAILY_COST_CAP_USD) || Infinity;
const REPETITION_WINDOW = parseInt(process.env.HYDRA_REPETITION_WINDOW) || 5; // Check last N cycles
const REPETITION_THRESHOLD = parseFloat(process.env.HYDRA_REPETITION_THRESHOLD) || 0.5; // Pause if >50% of recent titles are similar

// Zero-output stall detection (issue #24): consecutive cycles that produce no
// merge indicate the system is churning on work it cannot complete. At the
// alert threshold we notify the operator and begin exponential backoff; at the
// hard-stop threshold we pause the scheduler entirely.
const STALL_ALERT_THRESHOLD = parseInt(process.env.HYDRA_STALL_ALERT_THRESHOLD) || 5;
const ZERO_OUTPUT_THRESHOLD = parseInt(process.env.HYDRA_ZERO_OUTPUT_THRESHOLD) || 8;
const MAX_STALL_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes max backoff

// No-op merge detection (issue #222): cycles that report a merge but write
// zero files indicate a phantom-merge bug (verification or merge-extraction).
// Three consecutive no-op merges halt the scheduler — running more cycles
// burns money for no output. Threshold matches existing stall-detection
// pattern but is much more aggressive because a no-op merge is unambiguous
// evidence of system rot, not just slow work.
const NO_OP_MERGE_HALT_THRESHOLD = parseInt(process.env.HYDRA_NO_OP_MERGE_HALT_THRESHOLD) || 3;

// Rolling merge-rate window (issue #232): the operator-visible mergeRate is
// computed from the last N cycles in cycle-history (same source as
// `hydra metrics --count N`). Lifetime counters (cyclesMerged / cyclesRun)
// are still surfaced as `mergeRateLifetime` for audit, but they get heavily
// skewed by historical regressions (e.g. issue #218 where merges were 0 for
// 14 hours) and trip stall-style alerts long after the underlying bug is fixed.
const ROLLING_MERGE_RATE_WINDOW = parseInt(process.env.HYDRA_ROLLING_MERGE_RATE_WINDOW) || 50;

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
 * Pure-ish: only side effect is a Redis read via getMetricsTrend.
 */
async function computeRollingMergeRate(window: number = ROLLING_MERGE_RATE_WINDOW): Promise<{ mergeRate: number | null; cyclesInWindow: number }> {
  try {
    const trend = await getMetricsTrend(window);
    if (!Array.isArray(trend) || trend.length === 0) {
      return { mergeRate: null, cyclesInWindow: 0 };
    }
    const merged = trend.filter((m) => (m?.tasksMerged ?? 0) > 0).length;
    return {
      mergeRate: Math.round((merged / trend.length) * 100),
      cyclesInWindow: trend.length,
    };
  } catch (err: any) {
    console.error(`[Scheduler] Rolling merge-rate computation failed: ${err?.message || err}`);
    return { mergeRate: null, cyclesInWindow: 0 };
  }
}

/**
 * Compute exponential backoff delay for stall detection.
 * Exported for testability (issue #24 test coverage).
 */
function computeStallBackoffMs(consecutiveNonMerges: number): number {
  const backoffExponent = consecutiveNonMerges - STALL_ALERT_THRESHOLD;
  return Math.min(
    COOLDOWN_ON_ERROR_MS * Math.pow(2, backoffExponent),
    MAX_STALL_BACKOFF_MS,
  );
}

/**
 * Determine whether a stall alert notification should fire.
 * Fires on the first hit (threshold) and every 5 non-merge cycles after.
 */
function shouldSendStallAlert(consecutiveNonMerges: number): boolean {
  if (consecutiveNonMerges < STALL_ALERT_THRESHOLD) return false;
  const backoffExponent = consecutiveNonMerges - STALL_ALERT_THRESHOLD;
  return backoffExponent === 0 || consecutiveNonMerges % 5 === 0;
}

/**
 * Classify the stall state based on consecutiveNonMerges.
 * Returns "ok" | "alert" | "hard-stop".
 */
function classifyStallState(consecutiveNonMerges: number): "ok" | "alert" | "hard-stop" {
  if (consecutiveNonMerges >= ZERO_OUTPUT_THRESHOLD) return "hard-stop";
  if (consecutiveNonMerges >= STALL_ALERT_THRESHOLD) return "alert";
  return "ok";
}

/**
 * Classify the no-op-merge state (issue #222).
 * Returns "ok" | "halt" — there's no intermediate alert tier because every
 * no-op merge already triggers a per-cycle critical alert in post-merge.ts.
 * The scheduler-level halt fires once the run hits NO_OP_MERGE_HALT_THRESHOLD.
 */
function classifyNoOpMergeState(consecutiveNoOpMerges: number): "ok" | "halt" {
  return consecutiveNoOpMerges >= NO_OP_MERGE_HALT_THRESHOLD ? "halt" : "ok";
}

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
  consecutiveNonMerges: 0,
  consecutiveNoOpMerges: 0,
  haltedForNoOpMerges: false,
  researchCyclesRun: 0,
  lastResearchAt: null,
  _stateVersion: 0, // optimistic locking version (issue #140 — AC3)
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
// back to Redis.
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

const SCHEDULER_STATE_KEY = redisKeys.schedulerState();

async function loadSchedulerState() {
  try {
    const raw = await getString(SCHEDULER_STATE_KEY);
    if (!raw) {
      console.log("[Scheduler] No persisted state in Redis — starting fresh");
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

    // Load atomic lastResearchAt (issue #140 — AC2)
    const lastResearchMs = await getLastResearchAtMs();
    if (lastResearchMs) {
      state.lastResearchAt = new Date(lastResearchMs).toISOString();
    }

    // Load state version for optimistic locking (issue #140 — AC3)
    state._stateVersion = await getSchedulerStateVersion();

    console.log(`[Scheduler] Loaded persisted state — lastResearchAt=${state.lastResearchAt}, cyclesRun=${state.cyclesRun}, cyclesMerged=${state.cyclesMerged}, cyclesFailed=${state.cyclesFailed}, version=${state._stateVersion}`);
  } catch (err: any) {
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
    const { saved, newVersion } = await saveSchedulerStateVersioned(
      JSON.stringify(payload),
      state._stateVersion,
    );
    if (saved) {
      state._stateVersion = newVersion;
    } else {
      console.error(`[Scheduler] State version conflict — expected ${state._stateVersion}, found ${newVersion}. Retrying with fresh version.`);
      // Retry once with the current version from Redis
      const retry = await saveSchedulerStateVersioned(JSON.stringify(payload), newVersion);
      if (retry.saved) {
        state._stateVersion = retry.newVersion;
      } else {
        console.error(`[Scheduler] State save retry failed — version ${newVersion} vs ${retry.newVersion}`);
      }
    }
  } catch (err: any) {
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

const SCHEDULER_SPEND_KEY = redisKeys.schedulerDailySpend();

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
    const raw = await getString(SCHEDULER_SPEND_KEY);
    if (!raw) return { date: todayLocalDate(), usd: 0 };
    const stored = JSON.parse(raw);
    if (stored.date !== todayLocalDate()) {
      // Roll over — return a fresh zero for today
      return { date: todayLocalDate(), usd: 0 };
    }
    return stored;
  } catch (err: any) {
    /* intentional: fallback to zero spend on parse/Redis failure — non-critical for cycle operation */
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
    await setString(SCHEDULER_SPEND_KEY, JSON.stringify(updated));
    return updated;
  } catch (err: any) {
    console.error(`[Scheduler] Failed to record spend: ${err.message}`);
    return null;
  }
}

/**
 * Detect if recent cycles are producing repetitive work.
 * Alerts the operator but does NOT stop the scheduler.
 * Instead, triggers a research cycle to find fresh work.
 *
 * Returns true if repetition was detected (caller should add delay).
 */
async function detectRepetition(eventBus) {
  try {
    const trend = await getMetricsTrend(REPETITION_WINDOW);
    if (trend.length < REPETITION_WINDOW) return false;

    const titles = trend.map(m => m.taskTitle).filter(Boolean);
    if (titles.length < REPETITION_WINDOW) return false;

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
      console.log(`[Scheduler] REPETITION ALERT: ${Math.round(repetitionRate * 100)}% of last ${REPETITION_WINDOW} cycle pairs are similar — triggering research for fresh work`);
      console.log(`[Scheduler] Recent titles: ${titles.map(t => `"${t.slice(0, 60)}"`).join(", ")}`);

      await sendNotification({
        type: "scheduler:repetition_alert",
        payload: {
          reason: `${Math.round(repetitionRate * 100)}% of the last ${REPETITION_WINDOW} cycles produced similar tasks. Triggering research for fresh work.`,
          recentTitles: titles.slice(0, 5),
          cyclesRun: state.cyclesRun,
        },
      });

      // Trigger research instead of stopping — find fresh work
      try {
        console.log(`[Scheduler] Running research cycle to break repetition pattern`);
        await runResearchLoop(eventBus);
        state.researchCyclesRun++;
        await setLastResearchAt(); // AC2: atomic timestamp
        state.lastResearchAt = new Date().toISOString();
        await saveSchedulerState();
      } catch (err: any) {
        console.error(`[Scheduler] Repetition-break research failed: ${err.message}`);
      }

      return true; // signal caller to add delay before next cycle
    }
  } catch (err: any) {
    console.error(`[Scheduler] Repetition detection error: ${err.message}`);
  }
  return false;
}

async function maybeRunResearch(eventBus) {
  // Prune old done items from backlog
  try { await pruneOldDoneItems(); } catch (err: any) {
    console.error(`[Scheduler] Failed to prune old done items: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `pruneOldDoneItems failed: ${err.message}`, level: "error" });
  }

  // Check if operator forced a research cycle (bypasses all throttles)
  const forced = await consumeResearchForceOnce();
  if (forced) {
    console.log(`[Scheduler] Research FORCED by operator — bypassing all throttles`);
    try {
      const research = await runResearchLoop(eventBus);
      state.researchCyclesRun++;
      await setLastResearchAt(); // AC2: atomic timestamp
      state.lastResearchAt = new Date().toISOString();
      await recordResearchEvent();
      await saveSchedulerState();
      // @ts-expect-error — migrate to proper types
      console.log(`[Scheduler] Forced research complete — ${research.autoQueued || 0} items auto-queued`);
    } catch (err: any) {
      console.error(`[Scheduler] Forced research cycle failed: ${err.message}`);
    }
    return;
  }

  // Check queue depth — skip research when there's enough work to build
  const queueLen = await getWorkQueueLen();
  if (queueLen >= RESEARCH_QUEUE_THRESHOLD) {
    console.log(`[Scheduler] Research suppressed: queue depth ${queueLen} >= threshold ${RESEARCH_QUEUE_THRESHOLD}`);
    return;
  }

  // Check research-to-build ratio (rolling 24h window)
  const researchCount24h = await getResearchEventCount24h();
  const buildCount24h = await getBuildEventCount24h();
  const ratio = buildCount24h > 0 ? researchCount24h / buildCount24h : researchCount24h;
  if (researchCount24h > 0 && ratio > RESEARCH_BUILD_RATIO_MAX) {
    console.log(`[Scheduler] Research suppressed: ratio ${ratio.toFixed(1)} exceeds max ${RESEARCH_BUILD_RATIO_MAX} (${researchCount24h} research / ${buildCount24h} builds in 24h)`);
    return;
  }

  // Ratio throttle: if queue still has items, prefer building over researching.
  // Research should only run when the queue is nearly empty (< 3 items).
  const RESEARCH_QUEUE_LOW_WATERMARK = Math.min(3, Math.floor(RESEARCH_QUEUE_THRESHOLD / 2));
  if (queueLen >= RESEARCH_QUEUE_LOW_WATERMARK) {
    console.log(`[Scheduler] Queue has ${queueLen} items (>= ${RESEARCH_QUEUE_LOW_WATERMARK}) — prefer building over researching`);
    return;
  }

  // If queue is low but backlog has items, promote from backlog first
  try {
    const counts = await getBacklogCounts();
    if (counts.backlog > 0) {
      const needed = RESEARCH_QUEUE_THRESHOLD - queueLen;
      const promoted = await promoteToQueued(needed);
      if (promoted.length > 0) {
        // Push promoted items into Redis queue with full context
        for (const item of promoted) {
          await pushToWorkQueue(JSON.stringify({
            reference: item.title,
            reason: `Promoted from backlog (priority: ${item.priority || 0}, score: ${item.meta?.score || "?"}, ${item.meta?.confidence || "?"} confidence)`,
            context: JSON.stringify({
              ...item.meta,
              description: item.description,
              priority: item.priority,
              estimate: item.estimate,
              labels: item.labels,
              parentId: item.parentId,
            }),
            queuedAt: new Date().toISOString(),
            source: "backlog",
          }));
        }
        console.log(`[Scheduler] Promoted ${promoted.length} items from backlog to queue`);
        return; // Queue is now filled, no need for research
      }
    }

    // Log if backlog AND queue are both empty (no notification — too noisy)
    if (counts.total === 0 && counts.inProgress === 0) {
      console.log(`[Scheduler] Backlog and queue are both empty — will pick from priorities doc`);
    }
  } catch (err: any) {
    console.error(`[Scheduler] Backlog check failed: ${err.message}`);
  }

  // Check throttle — don't run research more often than the minimum interval
  // AC2 (issue #140): atomic check-then-set via Lua script in Redis
  const researchClaimed = await atomicClaimResearch(RESEARCH_MIN_INTERVAL_MS);
  if (!researchClaimed) {
    const lastMs = await getLastResearchAtMs();
    const remaining = lastMs ? Math.round((RESEARCH_MIN_INTERVAL_MS - (Date.now() - lastMs)) / 60_000) : 0;
    console.log(`[Scheduler] Queue low (${queueLen}) but research throttled — next research in ~${remaining}min`);
    return;
  }

  // Check daily spend cap — refuse to start research if today's budget is exhausted.
  // Reason: the Codex weekly quota caught us on 2026-04-02/08. See kanban-scope
  // decision + Spending dashboard.
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
    } catch (err: any) {
      console.error(`[Scheduler] Failed to send spend cap notification: ${err.message}`);
    }
    return;
  }

  console.log(`[Scheduler] Queue has ${queueLen} items (threshold: ${RESEARCH_QUEUE_THRESHOLD}) — running research cycle (daily spend: $${spend.usd.toFixed(2)} of $${DAILY_COST_CAP_USD.toFixed(2)})`);
  try {
    const research = await runResearchLoop(eventBus);
    state.researchCyclesRun++;
    // AC2: lastResearchAt already set atomically by atomicClaimResearch() above
    state.lastResearchAt = new Date().toISOString();
    await recordResearchEvent();
    // research-architect counter removed
    await saveSchedulerState();

    // Track research spend against the daily cap.
    // @ts-expect-error — migrate to proper types
    const researchCost = research?.cost?.totalUsd || 0;
    if (researchCost > 0) {
      const updated = await recordSpend(researchCost);
      if (updated) {
        console.log(`[Scheduler] Daily research spend: $${updated.usd.toFixed(2)} of $${DAILY_COST_CAP_USD.toFixed(2)}`);
      }
    }
    // @ts-expect-error — migrate to proper types
    console.log(`[Scheduler] Research complete — ${research.autoQueued || 0} items auto-queued`);
    // Priorities refresh is handled inside the research loop by the
    // research-strategist (Step 5.5) — it has the richest context.
    // Research architect removed — methodology files are frozen at current state.
  } catch (err: any) {
    console.error(`[Scheduler] Research cycle failed: ${err.message}`);
  }
}

// Generate actionable unblock commands based on the blocked reason.
function generateUnblockCommands(blockedReason: string, title: string): string[] {
  const commands: string[] = [];
  if (/api[_ ]?key|credentials|secret.*missing|token.*expired|env.*not set|missing.*env/i.test(blockedReason)) {
    const envVar = blockedReason.match(/\b([A-Z][A-Z_]{2,})\b/)?.[1] || "THE_MISSING_KEY";
    commands.push(`echo '${envVar}=<value>' >> ~/${getTargetName()}/.env.local`);
  }
  if (/DATABASE_URL|ECONNREFUSED.*5432|connection.*refused/i.test(blockedReason)) {
    commands.push(`cd ~/hydra && docker compose up -d postgres`);
  }
  // Always include the re-queue command
  const escaped = title.replace(/"/g, '\\"').slice(0, 80);
  commands.push(`curl -X POST http://localhost:4000/api/queue -H 'content-type:application/json' -d '{"reference":"${escaped}","reason":"Unblocked by operator","source":"operator"}'`);
  return commands;
}

// Check for blocked items that need re-escalation (every 12h per item).
const BLOCKED_REESCALATE_MS = 12 * 60 * 60 * 1000;
const BLOCKED_COOLDOWN_KEY = redisKeys.blockedLastEscalation();

async function checkBlockedEscalation(eventBus) {
  try {
    const { _admin: backlogAdmin } = await import("./backlog.ts");
    const lanes = await backlogAdmin.loadBacklog() as Record<string, any[]>;
    // AC5 (issue #140): freeze snapshot so iteration doesn't see mutations
    const blocked = [...(lanes.blocked || [])];
    if (blocked.length === 0) return;

    const now = Date.now();

    for (const item of blocked) {
      const blockedAt = item.meta?.blockedAt ? new Date(item.meta.blockedAt).getTime() : 0;
      if (!blockedAt) continue;
      const age = now - blockedAt;
      if (age < BLOCKED_REESCALATE_MS) continue;

      const lastEsc = await hashGet(BLOCKED_COOLDOWN_KEY, item.id);
      if (lastEsc && now - parseInt(lastEsc) < BLOCKED_REESCALATE_MS) continue;

      await hashSetField(BLOCKED_COOLDOWN_KEY, item.id, now.toString());
      const ageDays = Math.round(age / (24 * 60 * 60 * 1000));

      const { STREAMS } = await import("./event-bus.ts");
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "cycle:operator_blocked",
        source: "scheduler",
        correlationId: `blocked-reescalate-${item.id}`,
        payload: {
          taskId: item.id,
          title: item.title,
          blockedReason: item.meta?.blockedReason || item.description?.slice(0, 100) || "unknown",
          blockedDays: ageDays,
          unblockCommands: generateUnblockCommands(item.meta?.blockedReason || "", item.title),
          reescalation: true,
        },
      });
      console.log(`[Scheduler] Re-escalated blocked item ${item.id} (${ageDays} days)`);
    }
  } catch (err: any) {
    console.error(`[Scheduler] Blocked escalation check failed: ${err.message}`);
  }
}

async function runScheduledCycle(eventBus) {
  if (!state.running) return;

  // Check blocked items for re-escalation
  try {
    await checkBlockedEscalation(eventBus);
  } catch (err: any) {
    console.error(`[Scheduler] Blocked escalation check failed in scheduled cycle: ${err.message}`);
  }

  // Weekly summary — send once per week
  try {
    const WEEKLY_KEY = redisKeys.digestLastWeekly();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const lastWeekly = await getString(WEEKLY_KEY);
    if (!lastWeekly || Date.now() - parseInt(lastWeekly) >= WEEK_MS) {
      const { buildWeeklySummary } = await import("./digest.ts");
      const summary = await buildWeeklySummary();
      if (summary) {
        const { sendToTelegram } = await import("./notify.ts");
        await sendToTelegram(summary);
        await setString(WEEKLY_KEY, Date.now().toString());
        console.log("[Scheduler] Sent weekly summary");
      }
    }
  } catch (err: any) {
    console.error(`[Scheduler] Weekly summary failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `Weekly summary failed: ${err.message}`, level: "error" });
  }

  // Daily memory consolidation — prune stale patterns
  try {
    const MEMORY_CONSOLIDATION_KEY = redisKeys.memoryLastConsolidation();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const lastConsolidation = await getString(MEMORY_CONSOLIDATION_KEY);
    if (!lastConsolidation || Date.now() - parseInt(lastConsolidation) >= DAY_MS) {
      const { consolidate } = await import("./learning.ts");
      await consolidate();
      await setString(MEMORY_CONSOLIDATION_KEY, Date.now().toString());
    }
  } catch (err: any) {
    console.error(`[Scheduler] Memory consolidation failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `Memory consolidation failed: ${err.message}`, level: "error" });
  }

  // Check if research is needed (throttled)
  try {
    await maybeRunResearch(eventBus);
  } catch (err: any) {
    console.error(`[Scheduler] maybeRunResearch failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `maybeRunResearch failed: ${err.message}`, level: "error" });
  }

  // Anchor selection in the control loop already prioritizes failing tests
  // (priority #4) — no need to pre-check here. Removing the redundant
  // groundProject() call saves ~49s per cycle.
  let cycleOpts: Record<string, any> = {};

  // Reframe interleaving (issue #57): every Nth cycle, force a reframe anchor
  // if the queue is non-empty. This ensures reframe items get scheduled more
  // frequently instead of starving behind higher-priority sources.
  try {
    const reframeLen = await listLen(REFRAME_QUEUE);
    if (reframeLen > 0 && state.cyclesRun > 0 && state.cyclesRun % REFRAME_INTERLEAVE_INTERVAL === 0) {
      const raw = await listLPop(REFRAME_QUEUE);
      if (raw) {
        const item = JSON.parse(raw);
        cycleOpts.anchor = {
          type: "reframe",
          reference: item.originalTitle,
          whyNow: `Reframe interleave: queue has ${reframeLen} items, forcing drain every ${REFRAME_INTERLEAVE_INTERVAL} cycles`,
          context: item,
        };
        console.log(`[Scheduler] Reframe interleave: forcing reframe anchor "${item.originalTitle}" (queue: ${reframeLen}, cycle: ${state.cyclesRun})`);
      }
    }
  } catch (err: any) {
    console.error(`[Scheduler] Reframe interleave check failed: ${err.message}`);
  }

  let result = null;
  try {
    console.log(`[Scheduler] Starting scheduled cycle #${state.cyclesRun + 1}${cycleOpts.anchor ? ` (test-fix priority)` : ""}`);
    result = await startCycle(eventBus, cycleOpts);

    state.cyclesRun = await incrSchedulerCyclesRun(); // AC1: atomic Redis INCR
    state.lastCycleAt = new Date().toISOString();
    state.consecutiveErrors = 0;
    try { await recordBuildEvent(); } catch { /* intentional: non-critical ratio tracking */ }

    // Codex usage-limit — alert + backoff, auto-resume after 10 minutes
    if (result.__usageLimitHit || result.result?.__usageLimitHit) {
      const pauseMs = 10 * 60 * 1000;
      console.error(`[Scheduler] Codex usage limit hit — backing off for 10 minutes, then retrying`);
      state.lastError = "Codex usage limit — retrying at " + new Date(Date.now() + pauseMs).toISOString();
      await sendNotification({
        type: "scheduler:usage_limit_alert",
        payload: { pauseMs, resumeAt: new Date(Date.now() + pauseMs).toISOString() },
      });
      state.timer = setTimeout(() => runScheduledCycle(eventBus).catch((err: any) => console.error(`[Scheduler] Scheduled cycle failed: ${err.message}`)), pauseMs);
      return;
    }

    if (result.error) {
      state.cyclesFailed = await incrSchedulerCyclesFailed(); // issue #208: atomic Redis INCR
      state.lastError = result.error;
      state.consecutiveNonMerges++;
      console.log(`[Scheduler] Cycle returned error: ${result.error}`);
    } else {
      const merged = result.tasks?.some(t => t.finalState === "merged") ||
                     result.task?.finalState === "merged";
      // Issue #222: detect no-op merges (verification.filesChanged empty
      // but planner had scope). post-merge.ts records `noOpMerge: true` on
      // the cycle report when this happens. A no-op merge is NOT counted
      // as a merge for stall detection — it's worse than a non-merge,
      // because it produced a commit and burned tokens for no output.
      const noOpMerge = result.noOpMerge === true ||
                        result.task?.finalState === "verified-no-diff";
      if (merged) {
        state.cyclesMerged = await incrSchedulerCyclesMerged(); // issue #208: atomic Redis INCR
        state.consecutiveNonMerges = 0;
        state.consecutiveNoOpMerges = 0;
      } else {
        state.consecutiveNonMerges++;
        if (noOpMerge) {
          state.consecutiveNoOpMerges++;
        } else {
          state.consecutiveNoOpMerges = 0;
        }
      }
      state.lastError = null;

      // Issue #222: hard-stop when consecutive no-op merges hit the threshold.
      // This fires before the generic zero-output breaker because no-op
      // merges are unambiguous evidence the system is broken (commit
      // recorded, zero files changed).
      if (state.consecutiveNoOpMerges >= NO_OP_MERGE_HALT_THRESHOLD) {
        console.error(`[Scheduler] NO-OP MERGE HALT: ${state.consecutiveNoOpMerges} consecutive cycles produced commits with zero files changed — pausing scheduler`);
        state.haltedForNoOpMerges = true;
        await sendNotification({
          type: "scheduler:no_op_merge_halt",
          payload: {
            reason: `${state.consecutiveNoOpMerges} consecutive cycles reported merges but wrote zero files. The verification or merge-extraction logic is broken. Running more cycles burns money for no output.`,
            consecutiveNoOpMerges: state.consecutiveNoOpMerges,
            cyclesRun: state.cyclesRun,
            severity: "critical",
            suggestion: "Inspect post-merge.ts (verification.filesChanged extraction) and merge.ts (worktree handling). Restart scheduler via POST /scheduler/start once the underlying issue is resolved.",
          },
        });
        state.running = false;
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        console.log(`[Scheduler] Paused after ${state.cyclesRun} cycles (${state.cyclesMerged} merged, ${state.consecutiveNoOpMerges} consecutive no-op). Restart via POST /scheduler/start`);
        return;
      }

      // Zero-output stall detection (issue #24): hard-stop when the system has
      // churned for too long without producing a merge.
      if (state.consecutiveNonMerges >= ZERO_OUTPUT_THRESHOLD) {
        console.error(`[Scheduler] ZERO-OUTPUT CIRCUIT BREAKER: ${state.consecutiveNonMerges} consecutive cycles without a merge — pausing scheduler`);
        await sendNotification({
          type: "scheduler:zero_output_breaker",
          payload: {
            reason: `${state.consecutiveNonMerges} consecutive cycles produced no merge. System may be stuck.`,
            consecutiveNonMerges: state.consecutiveNonMerges,
            cyclesRun: state.cyclesRun,
            lastCycleReason: result.reason || "unknown",
            suggestion: "Check work queue items, planner output, and executor behavior. Restart with POST /scheduler/start when resolved.",
          },
        });
        // Pause but don't fully stop — allow operator to restart via API
        state.running = false;
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        console.log(`[Scheduler] Paused after ${state.cyclesRun} cycles (${state.cyclesMerged} merged). Restart via POST /scheduler/start`);
        return;
      }

      // Zero-output stall alert (issue #24): early warning with exponential
      // backoff before the hard-stop threshold. Gives the operator time to
      // intervene while slowing token burn.
      if (state.consecutiveNonMerges >= STALL_ALERT_THRESHOLD) {
        const stallBackoffMs = computeStallBackoffMs(state.consecutiveNonMerges);

        console.log(`[Scheduler] STALL ALERT: ${state.consecutiveNonMerges} consecutive non-merge cycles — backing off ${formatDuration(stallBackoffMs)}`);

        // Only send notification on the first hit (threshold) and every 5 after
        if (shouldSendStallAlert(state.consecutiveNonMerges)) {
          await sendNotification({
            type: "scheduler:stall_alert",
            payload: {
              reason: `${state.consecutiveNonMerges} consecutive cycles produced no merge. Applying exponential backoff.`,
              consecutiveNonMerges: state.consecutiveNonMerges,
              cyclesRun: state.cyclesRun,
              backoffMs: stallBackoffMs,
              hardStopAt: ZERO_OUTPUT_THRESHOLD,
              suggestion: "System may be stuck on work beyond executor capability. Check queue and planner output.",
            },
          });
        }

        state.timer = setTimeout(() => runScheduledCycle(eventBus).catch((err: any) => console.error(`[Scheduler] Scheduled cycle failed: ${err.message}`)), stallBackoffMs);
        return;
      }

      // Check for repetitive work pattern — alert + research, don't stop
      if (await detectRepetition(eventBus)) {
        // Add extended delay after repetition detection to let research results populate
        state.timer = setTimeout(() => runScheduledCycle(eventBus).catch((err: any) => console.error(`[Scheduler] Scheduled cycle failed: ${err.message}`)), state.intervalMs * 2);
        return;
      }
    }
  } catch (err: any) {
    state.cyclesRun = await incrSchedulerCyclesRun(); // AC1: atomic Redis INCR
    state.cyclesFailed = await incrSchedulerCyclesFailed(); // issue #208: atomic Redis INCR
    state.consecutiveErrors++;
    state.consecutiveNonMerges++;
    state.lastError = err.message;
    state.lastCycleAt = new Date().toISOString();
    console.error(`[Scheduler] Cycle error (${state.consecutiveErrors} consecutive):`, err.message);

    // Alert on repeated errors but keep running with extended backoff
    if (state.consecutiveErrors >= 5 && state.consecutiveErrors % 5 === 0) {
      console.error(`[Scheduler] ${state.consecutiveErrors} consecutive errors — alerting operator, continuing with extended backoff`);
      await sendNotification({
        type: "scheduler:error_alert",
        payload: {
          reason: `${state.consecutiveErrors} consecutive errors. Last: ${err.message}`,
          cyclesRun: state.cyclesRun,
          backoffMs: COOLDOWN_ON_ERROR_MS * state.consecutiveErrors,
          suggestion: "Check journalctl --user -u hydra-orchestrator.service for root cause",
        },
      });
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
      const queueLen = await getWorkQueueLen().catch(() => 0);
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
    state.timer = setTimeout(() => runScheduledCycle(eventBus).catch((err: any) => console.error(`[Scheduler] Scheduled cycle failed: ${err.message}`)), delay);
  }
}

async function start(eventBus,  opts: Record<string, any> = {}) {
  if (state.running) {
    return { error: "Scheduler is already running" };
  }

  // Hydrate throttle state from Redis so restarts don't trigger an
  // unwanted research cycle by losing lastResearchAt.
  await loadSchedulerState();

  // Issue #222: if the scheduler is halted for consecutive no-op merges,
  // refuse to start until the operator explicitly clears it. The watchdog
  // and the dashboard read this state from /api/scheduler/status — auto-
  // restart is suppressed here so silent rot does not resume.
  if (state.haltedForNoOpMerges && !opts.forceClearNoOpHalt) {
    return {
      error: `Scheduler halted for ${state.consecutiveNoOpMerges} consecutive no-op merges. ` +
        `Investigate post-merge.ts / merge.ts (verification.filesChanged extraction), ` +
        `then restart with { forceClearNoOpHalt: true } to acknowledge.`,
      haltedForNoOpMerges: true,
      consecutiveNoOpMerges: state.consecutiveNoOpMerges,
    };
  }

  const intervalMs = opts.intervalMs || state.intervalMs || DEFAULT_INTERVAL_MS;
  if (intervalMs < MIN_INTERVAL_MS) {
    return { error: `Interval must be at least ${MIN_INTERVAL_MS}ms (${MIN_INTERVAL_MS / 1000}s)` };
  }

  state.running = true;
  state.intervalMs = intervalMs;
  state.startedAt = new Date().toISOString();
  state.consecutiveErrors = 0;
  state.consecutiveNonMerges = 0;
  state.consecutiveNoOpMerges = 0;
  state.haltedForNoOpMerges = false;

  console.log(`[Scheduler] Started — cycles every ${intervalMs / 1000}s, research throttle ${RESEARCH_MIN_INTERVAL_MS / 3600_000}h`);

  // Run first cycle immediately (fire-and-forget — errors handled inside runScheduledCycle)
  runScheduledCycle(eventBus).catch((err: any) => console.error(`[Scheduler] First cycle failed: ${err.message}`));

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
  const researchCount24h = await getResearchEventCount24h().catch(() => 0);
  const buildCount24h = await getBuildEventCount24h().catch(() => 0);
  const currentRatio = buildCount24h > 0 ? researchCount24h / buildCount24h : researchCount24h;
  const perCycleCostCapUsd = getPerCycleCostCapUsd();

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

  return {
    running: state.running,
    intervalMs: state.intervalMs,
    intervalHuman: state.intervalMs ? formatDuration(state.intervalMs) : null,
    cyclesRun: state.cyclesRun,
    cyclesMerged: state.cyclesMerged,
    cyclesFailed: state.cyclesFailed,
    // Rolling N-cycle merge rate (default 50) — same source as
    // `hydra metrics --count N`. Operator-visible primary metric.
    mergeRate,
    mergeRateWindow: ROLLING_MERGE_RATE_WINDOW,
    mergeRateCyclesInWindow: rolling.cyclesInWindow,
    // Lifetime counter ratio — kept for audit / debugging only. Do not use
    // for alerts, stall detection, or operator dashboards (see issue #232).
    mergeRateLifetime: lifetimeMergeRate,
    lastCycleAt: state.lastCycleAt,
    lastError: state.lastError,
    startedAt: state.startedAt,
    consecutiveErrors: state.consecutiveErrors,
    consecutiveNonMerges: state.consecutiveNonMerges,
    stallAlertThreshold: STALL_ALERT_THRESHOLD,
    zeroOutputThreshold: ZERO_OUTPUT_THRESHOLD,
    // Issue #222: surface no-op-merge counter so dashboards and operator
    // checklist can display the silent-rot guardrail status.
    consecutiveNoOpMerges: state.consecutiveNoOpMerges,
    noOpMergeHaltThreshold: NO_OP_MERGE_HALT_THRESHOLD,
    haltedForNoOpMerges: state.haltedForNoOpMerges,
    // Issue #209: per-cycle cost cap (separate from daily research cap).
    // null when the cap is Infinity / disabled.
    perCycleCostCapUsd: Number.isFinite(perCycleCostCapUsd) ? perCycleCostCapUsd : null,
    research: {
      queueThreshold: RESEARCH_QUEUE_THRESHOLD,
      buildRatioMax: RESEARCH_BUILD_RATIO_MAX,
      currentRatio: Math.round(currentRatio * 10) / 10,
      researchCount24h,
      buildCount24h,
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
    // @ts-expect-error — migrate to proper types
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

/**
 * Determine whether research should be suppressed based on queue depth and ratio.
 * Pure function — exported for testability (issue #84).
 *
 * Returns { suppressed: true, reason: string } or { suppressed: false }.
 */
function shouldSuppressResearch(
  queueLen: number,
  researchCount24h: number,
  buildCount24h: number,
  opts?: { queueThreshold?: number; ratioMax?: number },
): { suppressed: boolean; reason?: string } {
  const threshold = opts?.queueThreshold ?? RESEARCH_QUEUE_THRESHOLD;
  const ratioMax = opts?.ratioMax ?? RESEARCH_BUILD_RATIO_MAX;

  if (queueLen >= threshold) {
    return {
      suppressed: true,
      reason: `Research suppressed: queue depth ${queueLen} >= threshold ${threshold}`,
    };
  }

  const ratio = buildCount24h > 0 ? researchCount24h / buildCount24h : researchCount24h;
  if (researchCount24h > 0 && ratio > ratioMax) {
    return {
      suppressed: true,
      reason: `Research suppressed: ratio ${ratio.toFixed(1)} exceeds max ${ratioMax} (${researchCount24h} research / ${buildCount24h} builds in 24h)`,
    };
  }

  return { suppressed: false };
}

export {
  start, stop, getStatus, autoStart, getDailySpend, DAILY_COST_CAP_USD,
  RESEARCH_BUILD_RATIO_MAX, RESEARCH_QUEUE_THRESHOLD,
  shouldSuppressResearch,
  // Exported for test coverage (issue #24):
  computeStallBackoffMs, shouldSendStallAlert, classifyStallState, formatDuration,
  // Exported for test coverage (issue #222):
  classifyNoOpMergeState, NO_OP_MERGE_HALT_THRESHOLD,
};
