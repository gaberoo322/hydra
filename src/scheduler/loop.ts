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
import { sendNotification } from "../notify.ts";
import { getMetricsTrend } from "../metrics.ts";
import { getBacklogCounts, loadBacklog } from "../backlog/reads.ts";
import { promoteToQueued, pruneOldDoneItems } from "../backlog/lanes.ts";
import { reapStaleClaims } from "../backlog/reaper.ts";

// Stale-claim reaper threshold (issue #374). Default 2h.
const CLAIM_MAX_AGE_MS = parseInt(process.env.HYDRA_CLAIM_MAX_AGE_MS ?? "") || 2 * 60 * 60 * 1000;
import { runResearchLoop } from "../research-loop.ts";
import { getPerCycleCostCapUsd } from "../cost/cap.ts";
import { redisKeys } from "../redis-keys.ts";
import { getTargetName } from "../target-config.ts";
import {
  getString, setString, delKey, pushToWorkQueue,
  hashGet, hashSetField,
  recordResearchEvent,
  getResearchEventCount24h, getBuildEventCount24h,
  consumeResearchForceOnce,
  getSchedulerCyclesRun,
  getSchedulerCyclesMerged,
  getSchedulerCyclesFailed,
  atomicClaimResearch, getLastResearchAtMs, setLastResearchAt,
  saveSchedulerStateVersioned, getSchedulerStateVersion,
} from "../redis-adapter.ts";
// Issue #457: new call site — import the source-aware live-count helper
// directly from the domain module per CLAUDE.md guidance (post-#269 split,
// redis-adapter.ts is a thin re-export shim and is Tier-0 / operator-only,
// so new helpers should be imported from the domain modules rather than
// re-exported through the shim).
import { countLiveWorkQueueItems } from "../redis/work-queue.ts";
import {
  shouldForceResearchFloor,
  getResearchBuildRatioMin,
  getResearchFloorWindow,
  getResearchFloorSilenceMs,
  getResearchFloorEmptySuppressMs,
  getResearchFloorSuppressedUntilMs,
  setResearchFloorSuppressedUntilMs,
  incrResearchFloorEmptyStreak,
  resetResearchFloorEmptyStreak,
  recordResearchFloorTriggered,
  getResearchFloorStats,
  RESEARCH_FLOOR_EMPTY_STREAK_THRESHOLD,
} from "./research-floor.ts";
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_INTERVAL_MS = 30 * 1000; // 30 seconds minimum

const RESEARCH_QUEUE_THRESHOLD = parseInt(process.env.HYDRA_RESEARCH_QUEUE_THRESHOLD) || 6;
const RESEARCH_BUILD_RATIO_MAX = parseFloat(process.env.HYDRA_RESEARCH_BUILD_RATIO_MAX) || 3;
const RESEARCH_MIN_INTERVAL_MS = parseInt(process.env.HYDRA_RESEARCH_MIN_INTERVAL_MS) || 2 * 60 * 60 * 1000; // 2 hours
const DAILY_COST_CAP_USD = parseFloat(process.env.HYDRA_DAILY_COST_CAP_USD) || Infinity;

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
// memory consolidation, maybeRunResearch). There is no codex cycle to gate;
// the flag is gone. Reaching this comment in a debug session = grep for
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

let state = {
  running: false,
  intervalMs: parseInt(process.env.HYDRA_AUTO_CYCLE_INTERVAL_MS) || 0,
  timer: null,
  cyclesRun: 0,
  cyclesMerged: 0,
  cyclesFailed: 0,
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

    // Issue #388: rehydrate the deliberate-stop marker. If a marker exists in
    // Redis the operator stopped the scheduler before the restart — we keep
    // running=false (loadSchedulerState doesn't auto-start) and surface the
    // reason so the watchdog still refuses to restart after a service bounce.
    try {
      const rawDeliberateStop = await getString(redisKeys.schedulerDeliberateStop());
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
      console.error(`[Scheduler] Failed to load deliberate-stop marker: ${err.message}`);
    }

    console.log(`[Scheduler] Loaded persisted state — lastResearchAt=${state.lastResearchAt}, cyclesRun=${state.cyclesRun}, cyclesMerged=${state.cyclesMerged}, cyclesFailed=${state.cyclesFailed}, version=${state._stateVersion}, stopReason=${state.stopReason ?? "none"}`);
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

  // Check queue depth + ratio caps. Both are *soft* gates that the research
  // capacity floor (#327) can override when the realised research:build ratio
  // is starving research below the configured minimum.
  //
  // Issue #457: gate on the *live* queue depth, not the raw LLEN. Items with
  // a source whose producer no longer exists (`code-reviewer`,
  // `adversarial-validation`; both deleted in PR-3 / issue #383) are orphans
  // that anchor-selection drains slowly as `user-request` work. They should
  // not permanently throttle research — the throttle's purpose is to gauge
  // live work pressure, and orphan items represent frozen pre-cutover work,
  // not live demand.
  const liveCounts = await countLiveWorkQueueItems();
  const queueLen = liveCounts.live;
  const queueLenTotal = liveCounts.total;
  const orphanLen = liveCounts.orphan;
  const orphanAnnotation = orphanLen > 0
    ? ` (${orphanLen} orphan items excluded; total LLEN=${queueLenTotal})`
    : "";
  const researchCount24h = await getResearchEventCount24h();
  const buildCount24h = await getBuildEventCount24h();
  const ratio = buildCount24h > 0 ? researchCount24h / buildCount24h : researchCount24h;

  // Compute the floor decision once so the soft-gate overrides and the
  // post-throttle logging both reference the same value.
  //
  // Issue #457: feed the wall-clock since last research into the floor
  // predicate so the silence-based override can fire even when build volume
  // is below `floorWindow`. Without this, a queue full of orphan items can
  // suppress queue-depth gating for >24h while the floor sits inert because
  // `buildCount24h < floorWindow`.
  const floorSuppressedUntilMs = await getResearchFloorSuppressedUntilMs();
  const lastResearchAtMs = await getLastResearchAtMs();
  const floor = shouldForceResearchFloor({
    researchCount24h,
    buildCount24h,
    ratioMin: getResearchBuildRatioMin(),
    floorWindow: getResearchFloorWindow(),
    suppressedUntilMs: floorSuppressedUntilMs,
    lastResearchAtMs,
    silenceMs: getResearchFloorSilenceMs(),
  });

  if (queueLen >= RESEARCH_QUEUE_THRESHOLD) {
    if (!floor.shouldFire) {
      console.log(`[Scheduler] Research suppressed: queue depth ${queueLen} >= threshold ${RESEARCH_QUEUE_THRESHOLD}${orphanAnnotation}`);
      return;
    }
    console.log(`[Scheduler] research floor fired: ${floor.reason} — overriding queue depth ${queueLen} >= ${RESEARCH_QUEUE_THRESHOLD}${orphanAnnotation}`);
  }

  if (researchCount24h > 0 && ratio > RESEARCH_BUILD_RATIO_MAX) {
    if (!floor.shouldFire) {
      console.log(`[Scheduler] Research suppressed: ratio ${ratio.toFixed(1)} exceeds max ${RESEARCH_BUILD_RATIO_MAX} (${researchCount24h} research / ${buildCount24h} builds in 24h)`);
      return;
    }
    console.log(`[Scheduler] research floor fired: ${floor.reason} — overriding ratio ceiling`);
  }

  // Ratio throttle: if queue still has items, prefer building over researching.
  // Research should only run when the queue is nearly empty (< 3 items) —
  // unless the floor is firing, in which case the starvation override wins.
  const RESEARCH_QUEUE_LOW_WATERMARK = Math.min(3, Math.floor(RESEARCH_QUEUE_THRESHOLD / 2));
  if (queueLen >= RESEARCH_QUEUE_LOW_WATERMARK) {
    if (!floor.shouldFire) {
      console.log(`[Scheduler] Queue has ${queueLen} items (>= ${RESEARCH_QUEUE_LOW_WATERMARK}) — prefer building over researching${orphanAnnotation}`);
      return;
    }
    console.log(`[Scheduler] research floor fired: ${floor.reason} — overriding low-watermark ${RESEARCH_QUEUE_LOW_WATERMARK}`);
  }

  // If queue is low but backlog has items, promote from backlog first.
  // Skip this branch when the floor is firing — the whole point of the floor
  // is to run research even when there's plenty of buildable work.
  try {
    const counts = await getBacklogCounts();
    if (!floor.shouldFire && counts.backlog > 0) {
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

  if (floor.shouldFire) {
    // Per-cycle telemetry counter (issue #327 acceptance: "researchFloorTriggered: boolean").
    // Recorded BEFORE runResearchLoop so a crashing research call still leaves
    // a fingerprint in the metrics — otherwise the floor-fired evidence would
    // disappear with the error.
    await recordResearchFloorTriggered();
    console.log(`[Scheduler] Queue has ${queueLen} items, but research floor fired (${floor.reason}) — running research cycle (daily spend: $${spend.usd.toFixed(2)} of $${DAILY_COST_CAP_USD.toFixed(2)})`);
  } else {
    console.log(`[Scheduler] Queue has ${queueLen} items (threshold: ${RESEARCH_QUEUE_THRESHOLD}) — running research cycle (daily spend: $${spend.usd.toFixed(2)} of $${DAILY_COST_CAP_USD.toFixed(2)})`);
  }
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
    const autoQueued = research?.autoQueued || 0;
    console.log(`[Scheduler] Research complete — ${autoQueued} items auto-queued`);

    // Floor-specific accounting (issue #327): if the cycle was forced by the
    // capacity floor and returned 0 new opportunities, bump the empty-streak
    // counter. When two consecutive forced cycles come up empty, suppress the
    // floor for 24h and alert the operator — otherwise the system pays for
    // research it can't use.
    if (floor.shouldFire) {
      if (autoQueued === 0) {
        const streak = await incrResearchFloorEmptyStreak();
        if (streak >= RESEARCH_FLOOR_EMPTY_STREAK_THRESHOLD) {
          const suppressMs = getResearchFloorEmptySuppressMs();
          const deadlineMs = Date.now() + suppressMs;
          await setResearchFloorSuppressedUntilMs(deadlineMs);
          await resetResearchFloorEmptyStreak();
          console.warn(`[Scheduler] research floor suppressed for ${Math.round(suppressMs / 3600_000)}h — ${streak} consecutive forced cycles returned no new opportunities`);
          try {
            await sendNotification({
              type: "scheduler:research_floor_empty_suppression",
              payload: {
                reason: `${streak} consecutive forced research cycles returned no new opportunities. Floor suppressed until ${new Date(deadlineMs).toISOString()}.`,
                suppressedUntil: new Date(deadlineMs).toISOString(),
                streak,
              },
            });
          } catch (notifyErr: any) {
            console.error(`[Scheduler] research floor suppression notification failed: ${notifyErr.message}`);
          }
        } else {
          console.log(`[Scheduler] research floor empty result (streak=${streak}/${RESEARCH_FLOOR_EMPTY_STREAK_THRESHOLD})`);
        }
      } else {
        await resetResearchFloorEmptyStreak();
      }
    }
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
    const lanes = await loadBacklog();
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

      const { STREAMS } = await import("../event-bus.ts");
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

  // Stale-claim reaper (issue #374) — release inProgress slots whose claimant
  // is dead so the WIP cap stays drainable. Runs once per scheduler tick,
  // before any work selection. Never throws; failures are logged.
  try {
    const reaperResult = await reapStaleClaims({ maxAgeMs: CLAIM_MAX_AGE_MS });
    if (reaperResult.reaped.length > 0) {
      console.log(
        `[Scheduler] Stale-claim reaper released ${reaperResult.reaped.length} inProgress slot(s) (threshold ${CLAIM_MAX_AGE_MS}ms)`,
      );
    }
    if (reaperResult.skippedOpenPr && reaperResult.skippedOpenPr.length > 0) {
      // issue #490: items with an open implementing PR in the target repo
      // are intentionally preserved rather than re-queued (which would
      // trigger a duplicate dev_target dispatch).
      console.log(
        `[Scheduler] Stale-claim reaper preserved ${reaperResult.skippedOpenPr.length} item(s) with open target PRs: ${reaperResult.skippedOpenPr.map(s => s.id).join(", ")}`,
      );
    }
  } catch (err: any) {
    console.error(`[Scheduler] reapStaleClaims failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `reapStaleClaims failed: ${err.message}`, level: "error" });
  }

  // Weekly summary — send once per week
  try {
    const WEEKLY_KEY = redisKeys.digestLastWeekly();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const lastWeekly = await getString(WEEKLY_KEY);
    if (!lastWeekly || Date.now() - parseInt(lastWeekly) >= WEEK_MS) {
      const { buildWeeklySummary } = await import("../digest.ts");
      const summary = await buildWeeklySummary();
      if (summary) {
        const { sendToTelegram } = await import("../notify.ts");
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
      const { consolidate } = await import("../learning.ts");
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

  // Issue #383 (codex cut-over PR-3): the in-process control loop is gone.
  // `runScheduledCycle` now exists solely as a heartbeat for the housekeeping
  // tasks above (stale-claim reaper, weekly digest, memory consolidation,
  // maybeRunResearch).
  //
  // Issue #397: the heartbeat moves to `lastTickAt` so liveness probes can
  // tell "housekeeping is running" apart from "the control loop ran". The
  // legacy `lastCycleAt` field is left null on purpose — under PR-3 there is
  // no `runControlLoop` invocation to point at, so reporting a stale codex
  // timestamp here misleads the dashboard and the watchdog. Operators that
  // want liveness must read `lastTickAt`.
  state.lastTickAt = new Date().toISOString();
  if (state.running) {
    const delay = state.intervalMs || DEFAULT_INTERVAL_MS;
    state.timer = setTimeout(
      () => runScheduledCycle(eventBus).catch((err: any) =>
        console.error(`[Scheduler] Scheduled cycle failed: ${err.message}`),
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
    await delKey(redisKeys.schedulerDeliberateStop());
  } catch (err: any) {
    console.error(`[Scheduler] Failed to clear deliberate-stop marker: ${err.message}`);
  }

  console.log(`[Scheduler] Started — cycles every ${intervalMs / 1000}s, research throttle ${RESEARCH_MIN_INTERVAL_MS / 3600_000}h`);

  // Run first cycle immediately (fire-and-forget — errors handled inside runScheduledCycle)
  runScheduledCycle(eventBus).catch((err: any) => console.error(`[Scheduler] First cycle failed: ${err.message}`));

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
      await setString(
        redisKeys.schedulerDeliberateStop(),
        JSON.stringify({ reason: "deliberate", stoppedAt }),
        DELIBERATE_STOP_TTL_SECONDS,
      );
    } catch (err: any) {
      console.error(`[Scheduler] Failed to persist deliberate-stop marker: ${err.message}`);
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

  console.log(`[Scheduler] Stopped after ${state.cyclesRun} cycles (reason=${reason})`);

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
  const spend = await getDailySpend();
  const researchCount24h = await getResearchEventCount24h().catch(() => 0);
  const buildCount24h = await getBuildEventCount24h().catch(() => 0);
  const currentRatio = buildCount24h > 0 ? researchCount24h / buildCount24h : researchCount24h;
  const perCycleCostCapUsd = getPerCycleCostCapUsd();
  const floorStats = await getResearchFloorStats().catch((err: any) => {
    console.error(`[Scheduler] getResearchFloorStats failed: ${err.message}`);
    return null;
  });
  // Issue #457: surface live vs orphan queue depth so the dashboard can
  // explain why the throttle isn't firing when LLEN is high.
  const liveCounts = await countLiveWorkQueueItems().catch((err: any) => {
    console.error(`[Scheduler] countLiveWorkQueueItems failed: ${err.message}`);
    return { live: 0, total: 0, orphan: 0 };
  });

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
    // Issue #209: per-cycle cost cap (separate from daily research cap).
    // null when the cap is Infinity / disabled.
    perCycleCostCapUsd: Number.isFinite(perCycleCostCapUsd) ? perCycleCostCapUsd : null,
    research: {
      queueThreshold: RESEARCH_QUEUE_THRESHOLD,
      buildRatioMax: RESEARCH_BUILD_RATIO_MAX,
      // Issue #327: symmetric floor companion to buildRatioMax. The floor
      // is the *minimum* acceptable research:build ratio over the rolling
      // 24h window — when the realised ratio dips below this, the scheduler
      // forces a research cycle (subject to min-interval + cost cap).
      buildRatioMin: floorStats?.ratioMin ?? getResearchBuildRatioMin(),
      currentRatio: Math.round(currentRatio * 10) / 10,
      researchCount24h,
      buildCount24h,
      // Issue #457: live vs total queue depth. The throttle gates on `live`,
      // not `total` — items from deleted producers (orphan source) do not
      // represent live demand and should not permanently suppress research.
      queueDepthLive: liveCounts.live,
      queueDepthTotal: liveCounts.total,
      queueDepthOrphan: liveCounts.orphan,
      minIntervalHuman: formatDuration(RESEARCH_MIN_INTERVAL_MS),
      cyclesRun: state.researchCyclesRun,
      lastResearchAt: state.lastResearchAt,
      dailyCostCapUsd: DAILY_COST_CAP_USD,
      dailySpendUsd: spend.usd,
      dailySpendDate: spend.date,
      // Issue #327: floor telemetry — surfaces how often the capacity-floor
      // override has fired and whether it's currently suppressed because of
      // back-to-back empty forced cycles.
      floor: floorStats
        ? {
            window: floorStats.floorWindow,
            triggered: floorStats.triggered,
            lastTriggeredAt: floorStats.lastTriggeredAt,
            emptyStreak: floorStats.emptyStreak,
            suppressedUntil: floorStats.suppressedUntilMs
              ? new Date(floorStats.suppressedUntilMs).toISOString()
              : null,
          }
        : null,
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
  formatDuration,
  // Exported for test coverage (issue #381 / #383):
  runScheduledCycle,
};
