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
import { getMetricsTrend } from "../metrics/trend.ts";
import { getBacklogCounts, loadBacklog } from "../backlog/reads.ts";
import { promoteToQueued, pruneOldDoneItems } from "../backlog/lanes.ts";
import { reapStaleClaims } from "../backlog/reaper.ts";

// Stale-claim reaper threshold (issue #374). Default 2h.
const CLAIM_MAX_AGE_MS = parseInt(process.env.HYDRA_CLAIM_MAX_AGE_MS ?? "") || 2 * 60 * 60 * 1000;
import { runResearchLoop } from "../research-loop.ts";
import {
  getDailyCapUsd,
  getDailySpendSurrogate,
  todayDateString,
  type DailySpendSurrogate,
} from "../cost/index.ts";
import { getTargetName } from "../target-config.ts";
import { pushToWorkQueue } from "../redis/work-queue.ts";
import {
  recordResearchEvent,
  getResearchEventCount24h, getBuildEventCount24h,
  consumeResearchForceOnce,
  getSchedulerCyclesRun,
  getSchedulerCyclesMerged,
  getSchedulerCyclesFailed,
  atomicClaimResearch, getLastResearchAtMs, setLastResearchAt,
  saveSchedulerStateVersioned, getSchedulerStateVersion,
  getSchedulerStateRaw,
  getDailySpendRaw, setDailySpendRaw,
  getSchedulerDeliberateStop, setSchedulerDeliberateStop, clearSchedulerDeliberateStop,
  getBlockedLastEscalation, setBlockedLastEscalation,
  getDigestLastWeekly, setDigestLastWeekly,
  getMemoryLastConsolidation, setMemoryLastConsolidation,
} from "../redis/scheduler.ts";
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
import {
  decideResearchAction,
  type ResearchSnapshot,
  type ResearchAction,
} from "./research-decision.ts";
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
  /**
   * The most recent verdict from `decideResearchAction`. Surfaced via
   * `getStatus()` so operators can see exactly why the scheduler did
   * (or didn't) run research without grepping logs. Reset to `null`
   * on cold start; updated on every tick that runs the research path.
   */
  lastResearchDecision: null as ResearchAction | null,
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

async function loadSchedulerState() {
  try {
    const raw = await getSchedulerStateRaw();
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
      const rawDeliberateStop = await getSchedulerDeliberateStop();
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

function todayLocalDate() {
  // Use local date so the counter resets at local midnight, not UTC midnight.
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Today's spend in USD, with a `source` discriminator that says where
 * the number came from so the spend-cap decision is auditable.
 *
 * Reads through `getDailySpendSurrogate` — the canonical daily-spend
 * aggregator. The surrogate combines two writer streams:
 *
 *   - autopilot subagent tokens × `HYDRA_TOKEN_USD_RATE` (post-cutover real spend)
 *   - the legacy `hydra:scheduler:daily-spend` blob written by `recordSpend()`
 *     (research-loop USD spend; only writer left for that path)
 *
 * `source` ∈ { "autopilot-surrogate" | "codex-recorded" | "mixed" | "none" }.
 * When `none`, the rate isn't configured AND nobody's called recordSpend —
 * the spend gate effectively disables itself, matching the prior behaviour.
 *
 * UTC date scheme matches the surrogate (whose Redis keys are UTC-dated).
 * The pre-canonicalisation code used a *local* date — the local/UTC
 * mismatch is a known operator-facing trade-off and is documented in
 * `surrogate.ts::todayDateString`; we follow the surrogate's convention so
 * the scheduler and `/api/metrics/cost` agree on what "today" means.
 */
async function getDailySpend(): Promise<{ usd: number; date: string; source: DailySpendSurrogate["source"] }> {
  try {
    const s = await getDailySpendSurrogate();
    return { usd: s.costUsd, date: s.date, source: s.source };
  } catch (err: any) {
    /* intentional: fallback to zero spend on Redis failure — non-critical for cycle operation */
    console.error(`[Scheduler] getDailySpend via surrogate failed: ${err.message}`);
    return { usd: 0, date: todayDateString(), source: "none" };
  }
}

/**
 * Increment the legacy `hydra:scheduler:daily-spend` JSON blob — the
 * research-loop's spend channel into the surrogate (`legacyRecordSpendUsd`).
 *
 * Reads `getDailySpendRaw` directly (not `getDailySpend`) on purpose: the
 * canonical reader returns the *combined* surrogate figure, so feeding
 * that back into the legacy blob would double-count autopilot subagent
 * tokens on the next read. This writer owns one stream — the
 * research-loop's USD spend — and adds to that stream alone.
 *
 * Uses local-date rollover so the existing operator intuition ("daily
 * cap resets at local midnight") holds. The reader-side UTC mismatch is
 * documented on `getDailySpend`.
 */
async function recordSpend(amountUsd) {
  try {
    const today = todayLocalDate();
    let priorUsd = 0;
    const raw = await getDailySpendRaw();
    if (raw) {
      try {
        const stored = JSON.parse(raw);
        if (stored.date === today) priorUsd = stored.usd || 0;
      } catch { /* intentional: corrupt blob → start a fresh day */ }
    }
    const updated = {
      date: today,
      usd: priorUsd + (amountUsd || 0),
      updatedAt: new Date().toISOString(),
    };
    await setDailySpendRaw(JSON.stringify(updated));
    return updated;
  } catch (err: any) {
    console.error(`[Scheduler] Failed to record spend: ${err.message}`);
    return null;
  }
}

/**
 * Snapshot the inputs the research-decision function needs. All Redis
 * reads happen here; the decision itself is pure (see
 * scheduler/research-decision.ts).
 *
 * `forced` consumes the operator force-once flag as a side effect —
 * matching the legacy `maybeRunResearch` semantics where reading the
 * flag also clears it. If you snapshot but don't act, the flag is lost.
 * That's the same trade-off the original code made.
 */
async function loadResearchSnapshot(): Promise<ResearchSnapshot> {
  const forced = await consumeResearchForceOnce();
  const liveCounts = await countLiveWorkQueueItems();
  const queueLen = liveCounts.live;
  const queueLenTotal = liveCounts.total;
  const orphanLen = liveCounts.orphan;
  const researchCount24h = await getResearchEventCount24h();
  const buildCount24h = await getBuildEventCount24h();
  const ratio = buildCount24h > 0 ? researchCount24h / buildCount24h : researchCount24h;
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
  // Backlog totals — best-effort. A read failure isn't fatal; treat the
  // backlog as empty so the decision falls through to throttle/spend/run
  // rather than blocking research on a phantom backlog.
  let backlog = { total: 0, queued: 0, inProgress: 0 };
  try {
    const counts = await getBacklogCounts();
    backlog = { total: counts.backlog, queued: counts.queued, inProgress: counts.inProgress };
  } catch (err: any) {
    console.error(`[Scheduler] Backlog count read failed: ${err.message}`);
  }
  const spend = await getDailySpend();
  return {
    forced,
    queueLen,
    queueLenTotal,
    orphanLen,
    researchCount24h,
    buildCount24h,
    ratio,
    floor,
    lastResearchAtMs,
    researchMinIntervalMs: RESEARCH_MIN_INTERVAL_MS,
    nowMs: Date.now(),
    dailySpend: spend,
    dailySpendCap: DAILY_COST_CAP_USD,
    backlog,
    queueThreshold: RESEARCH_QUEUE_THRESHOLD,
    ratioMax: RESEARCH_BUILD_RATIO_MAX,
    lowWatermark: Math.min(3, Math.floor(RESEARCH_QUEUE_THRESHOLD / 2)),
  };
}

function orphanAnnotation(snap: ResearchSnapshot): string {
  return snap.orphanLen > 0
    ? ` (${snap.orphanLen} orphan items excluded; total LLEN=${snap.queueLenTotal})`
    : "";
}

/**
 * Carry out the decision. Side effects only — the policy already ran
 * upstream in `decideResearchAction`.
 *
 * Returns `true` when the caller should treat the tick as "research
 * handled for now" (force/run/promotion/cap/throttle). The only `false`
 * case is `promote-backlog` with 0 items actually promoted, signalling
 * the caller to re-decide with `skipBacklogPromotion: true`.
 */
async function executeResearchAction(
  action: ResearchAction,
  snap: ResearchSnapshot,
  eventBus,
): Promise<boolean> {
  switch (action.kind) {
    case "force-once": {
      console.log(`[Scheduler] Research FORCED by operator — bypassing all throttles`);
      try {
        const research = await runResearchLoop(eventBus);
        state.researchCyclesRun++;
        await setLastResearchAt();
        state.lastResearchAt = new Date().toISOString();
        await recordResearchEvent();
        await saveSchedulerState();
        // @ts-expect-error — migrate to proper types
        console.log(`[Scheduler] Forced research complete — ${research.autoQueued || 0} items auto-queued`);
      } catch (err: any) {
        console.error(`[Scheduler] Forced research cycle failed: ${err.message}`);
      }
      return true;
    }
    case "skip": {
      // Branch on `reason` so each skip case logs in a way operators can
      // recognise from the pre-refactor scheduler.
      switch (action.reason) {
        case "queue-not-low":
          console.log(`[Scheduler] Research suppressed: queue depth ${action.queueLen} >= threshold ${action.threshold}${orphanAnnotation(snap)}`);
          break;
        case "ratio-cap":
          console.log(`[Scheduler] Research suppressed: ratio ${action.ratio.toFixed(1)} exceeds max ${action.max} (${action.researchCount24h} research / ${action.buildCount24h} builds in 24h)`);
          break;
        case "low-watermark":
          console.log(`[Scheduler] Queue has ${action.queueLen} items (>= ${action.watermark}) — prefer building over researching${orphanAnnotation(snap)}`);
          break;
        case "throttled":
          console.log(`[Scheduler] Queue low (${snap.queueLen}) but research throttled — next research in ~${Math.round(action.remainingMs / 60_000)}min`);
          break;
        case "spend-cap":
          console.log(`[Scheduler] Daily spend cap reached — $${action.spentUsd.toFixed(2)} >= $${action.capUsd.toFixed(2)} (source: ${action.source}), skipping research`);
          try {
            await sendNotification({
              type: "scheduler:spend_cap_reached",
              payload: {
                message: `Daily research spend cap reached: $${action.spentUsd.toFixed(2)} of $${action.capUsd.toFixed(2)}. Research paused until local midnight.`,
                date: snap.dailySpend.date,
                spentUsd: action.spentUsd,
                capUsd: action.capUsd,
              },
            });
          } catch (err: any) {
            console.error(`[Scheduler] Failed to send spend cap notification: ${err.message}`);
          }
          break;
      }
      return true;
    }
    case "promote-backlog": {
      try {
        const promoted = await promoteToQueued(action.needed);
        if (promoted.length === 0) {
          // Backlog had items but none were promotable. Signal the caller
          // to re-decide without the promotion option.
          return false;
        }
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
        return true;
      } catch (err: any) {
        console.error(`[Scheduler] Backlog promotion failed: ${err.message}`);
        // Don't recurse on Redis errors — bail out for this tick.
        return true;
      }
    }
    case "run": {
      // Atomic throttle claim — TOCTOU-safe even though the decision
      // already verified the time window. If another scheduler beat us
      // here, treat it as throttled and bail.
      const claimed = await atomicClaimResearch(RESEARCH_MIN_INTERVAL_MS);
      if (!claimed) {
        const lastMs = await getLastResearchAtMs();
        const remaining = lastMs ? Math.round((RESEARCH_MIN_INTERVAL_MS - (Date.now() - lastMs)) / 60_000) : 0;
        console.log(`[Scheduler] Throttle race: research already claimed by a concurrent scheduler — next research in ~${remaining}min`);
        return true;
      }

      if (action.reason === "floor-fire") {
        // Per-cycle telemetry counter (issue #327): record BEFORE
        // runResearchLoop so a crashing research call still leaves a
        // fingerprint in the metrics.
        await recordResearchFloorTriggered();
        console.log(`[Scheduler] Queue has ${action.queueLen} items, but research floor fired (${action.floorReason}) — running research cycle (daily spend: $${snap.dailySpend.usd.toFixed(2)} of $${snap.dailySpendCap.toFixed(2)})`);
      } else {
        console.log(`[Scheduler] Queue has ${action.queueLen} items (threshold: ${snap.queueThreshold}) — running research cycle (daily spend: $${snap.dailySpend.usd.toFixed(2)} of $${snap.dailySpendCap.toFixed(2)})`);
      }

      try {
        const research = await runResearchLoop(eventBus);
        state.researchCyclesRun++;
        state.lastResearchAt = new Date().toISOString();
        await recordResearchEvent();
        await saveSchedulerState();

        // @ts-expect-error — migrate to proper types
        const researchCost = research?.cost?.totalUsd || 0;
        if (researchCost > 0) {
          const updated = await recordSpend(researchCost);
          if (updated) {
            console.log(`[Scheduler] Daily research spend: $${updated.usd.toFixed(2)} of $${snap.dailySpendCap.toFixed(2)}`);
          }
        }
        // @ts-expect-error — migrate to proper types
        const autoQueued = research?.autoQueued || 0;
        console.log(`[Scheduler] Research complete — ${autoQueued} items auto-queued`);

        // Floor-specific empty-streak accounting (issue #327). Observes the
        // outcome of running research; not part of the decision policy.
        if (action.reason === "floor-fire") {
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
      } catch (err: any) {
        console.error(`[Scheduler] Research cycle failed: ${err.message}`);
      }
      return true;
    }
  }
}

async function maybeRunResearch(eventBus) {
  const snap = await loadResearchSnapshot();
  let action = decideResearchAction(snap);
  state.lastResearchDecision = action;
  // Log "backlog and queue both empty" — preserved from the legacy code path.
  if (snap.backlog.total === 0 && snap.backlog.inProgress === 0 && snap.queueLen === 0) {
    console.log(`[Scheduler] Backlog and queue are both empty — will pick from priorities doc`);
  }
  const handled = await executeResearchAction(action, snap, eventBus);
  if (handled) return;
  // promote-backlog returned 0; re-decide without the promotion option so we
  // can fall through to throttle/spend/run gates with the post-promotion
  // snapshot (which is functionally unchanged — promotion mutated state but
  // not the gates the remaining decision branches consult).
  action = decideResearchAction(snap, { skipBacklogPromotion: true });
  state.lastResearchDecision = action;
  await executeResearchAction(action, snap, eventBus);
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

      const lastEsc = await getBlockedLastEscalation(item.id);
      if (lastEsc && now - parseInt(lastEsc) < BLOCKED_REESCALATE_MS) continue;

      await setBlockedLastEscalation(item.id, now.toString());
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

  // Prune old done-lane items from the backlog. Lives at the tick level
  // rather than wedged inside `maybeRunResearch` so it still runs when the
  // research path early-exits on any of its skip gates.
  try {
    await pruneOldDoneItems();
  } catch (err: any) {
    console.error(`[Scheduler] Failed to prune old done items: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `pruneOldDoneItems failed: ${err.message}`, level: "error" });
  }

  // Weekly summary — send once per week
  try {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const lastWeekly = await getDigestLastWeekly();
    if (!lastWeekly || Date.now() - parseInt(lastWeekly) >= WEEK_MS) {
      const { buildWeeklySummary } = await import("../digest.ts");
      const summary = await buildWeeklySummary();
      if (summary) {
        const { sendToTelegram } = await import("../notify.ts");
        await sendToTelegram(summary);
        await setDigestLastWeekly(Date.now().toString());
        console.log("[Scheduler] Sent weekly summary");
      }
    }
  } catch (err: any) {
    console.error(`[Scheduler] Weekly summary failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `Weekly summary failed: ${err.message}`, level: "error" });
  }

  // Daily memory consolidation — prune stale patterns
  try {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const lastConsolidation = await getMemoryLastConsolidation();
    if (!lastConsolidation || Date.now() - parseInt(lastConsolidation) >= DAY_MS) {
      const { consolidate } = await import("../learning.ts");
      await consolidate();
      await setMemoryLastConsolidation(Date.now().toString());
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
    await clearSchedulerDeliberateStop();
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
      await setSchedulerDeliberateStop(
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
  // Issue #576: surface the daily-spend cap the autopilot enforces against
  // (HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD, default $50). The pre-cutover
  // per-cycle codex cap was retired with the cost-cap module; the orchestrator
  // never enforced this one — it only mirrors it for dashboard visibility.
  const dailySpendCapUsd = getDailyCapUsd();
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
    // Issue #576: daily-spend cap the autopilot enforces against
    // (HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD, default $50). null when the cap
    // is `Infinity` (operator opt-out). Renamed from `perCycleCostCapUsd`
    // which surfaced the retired pre-cutover per-cycle codex circuit breaker.
    dailySpendCapUsd: Number.isFinite(dailySpendCapUsd) ? dailySpendCapUsd : null,
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
      /**
       * Most recent verdict from `decideResearchAction`. Operators reading
       * this can answer "what did the scheduler decide last tick, and why?"
       * without grepping logs. `null` on cold start.
       */
      lastResearchDecision: state.lastResearchDecision,
      dailyCostCapUsd: DAILY_COST_CAP_USD,
      dailySpendUsd: spend.usd,
      dailySpendDate: spend.date,
      /** Which accounting stream produced `dailySpendUsd` — let the dashboard
       *  label the number so operators don't have to guess. Matches the
       *  surrogate's `source` discriminator. */
      dailySpendSource: spend.source,
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

export {
  start, stop, getStatus, autoStart, getDailySpend, DAILY_COST_CAP_USD,
  RESEARCH_BUILD_RATIO_MAX, RESEARCH_QUEUE_THRESHOLD,
  formatDuration,
  // Exported for test coverage (issue #381 / #383):
  runScheduledCycle,
};
