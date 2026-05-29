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
import { getTargetName } from "../target-config.ts";
import {
  getSchedulerCyclesRun,
  getSchedulerCyclesMerged,
  getSchedulerCyclesFailed,
  getLastResearchAtMs,
  saveSchedulerStateVersioned, getSchedulerStateVersion,
  getSchedulerStateRaw,
  getSchedulerDeliberateStop, setSchedulerDeliberateStop, clearSchedulerDeliberateStop,
  getBlockedLastEscalation, setBlockedLastEscalation,
  getDigestLastWeekly, setDigestLastWeekly,
  getMemoryLastConsolidation, setMemoryLastConsolidation,
} from "../redis/scheduler.ts";
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_INTERVAL_MS = 30 * 1000; // 30 seconds minimum

// Note: the in-process scheduler research-decision plane (queue-depth /
// ratio-cap / capacity-floor throttling that fed the `runResearchLoop`
// no-op shim) was deleted in #706 (scheduler fold PR-1/4). The research-force
// policy now lives in the autopilot brain (`scripts/autopilot/decide.py`
// `_research_force_allowed`). The `HYDRA_RESEARCH_QUEUE_THRESHOLD`,
// `HYDRA_RESEARCH_BUILD_RATIO_MAX`, and `HYDRA_RESEARCH_MIN_INTERVAL_MS`
// env vars are inert if still set.

// Note: the legacy `HYDRA_DAILY_COST_CAP_USD` env var, the dollar-based
// daily-spend cap, and the `recordSpend`/`getDailySpend` helpers were
// retired in the Subscription Usage Tracker B-series PRs. Quota gating
// is now done by the autopilot via `/api/usage/eligibility` (PR B1),
// using real Anthropic-quota numbers from `~/.claude/projects/*.jsonl`
// instead of a HYDRA_TOKEN_USD_RATE × token estimate. The env var is
// inert if still set.

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
// memory consolidation, design-concept snapshot). There is no codex cycle to
// gate; the flag is gone. Reaching this comment in a debug session = grep for
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
// Daily-spend cap retired (Subscription Usage Tracker B-series). The
// historical context: between 2026-04-02 and 2026-04-04 the codex weekly
// quota was exhausted in ~3 days of unconstrained research, and every
// subsequent research cycle failed silently until the quota reset on
// 2026-04-08. The dollar-based cap (HYDRA_DAILY_COST_CAP_USD) was the
// fix for that.
//
// Post-codex (ADR-0006), `HYDRA_TOKEN_USD_RATE` was never set in
// production, so the surrogate-converted dollar spend was always $0 and
// the cap never fired. The Subscription Usage Tracker
// (src/cost/usage-tracker.ts) replaces this entirely: it reads real
// Anthropic-quota percentages from the JSONL transcripts and exposes
// `/api/usage/eligibility` for autopilot dispatch gating (PR B1). The
// scheduler itself doesn't dispatch Claude Code subagents — research is
// driven by the /hydra-target-research skill under the autopilot, so the
// autopilot's eligibility gate covers it.

// The in-process research-decision plane (loadResearchSnapshot /
// orphanAnnotation / executeResearchAction / maybeRunResearch) was deleted
// in #706 (scheduler fold PR-1/4). It fed the `runResearchLoop` no-op shim
// and did nothing in production. The research-force policy now lives in the
// autopilot brain (`scripts/autopilot/decide.py` `_research_force_allowed`).

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

  // Stale-claim reaper moved to the autopilot's Phase 2 reap (issue #721,
  // scheduler fold PR-2/4). Per ADR-0012 the autopilot is the single brain,
  // and stale `inProgress` claims only matter when the autopilot wants to
  // dispatch into those slots — so the reaper now runs once-per-Phase-2
  // (before each dispatch decision) via `scripts/autopilot/reap.py`'s
  // `run_hardcap()` POSTing to `/api/backlog/stale-claims/reap`, rather than
  // on every 2-minute scheduler tick. `reapStaleClaims` itself stays in
  // `src/backlog/reaper.ts`, still serving that endpoint + the
  // operator-triggered route.

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

  // Daily design-concept snapshot (issue #628) — record today's index
  // size so we can compute "≥7 consecutive non-zero days" as the
  // green-light criterion for Phase C of #437. PR #567 retired the
  // heavyweight B-4 telemetry endpoint; this is the lightweight
  // replacement (one hash field per day, 14-day bounded).
  try {
    const {
      getDesignConceptIndexSize,
      writeDailySnapshot,
      readDailySnapshots,
    } = await import("../redis/design-concept.ts");
    const today = new Date().toISOString().slice(0, 10);
    const existing = await readDailySnapshots();
    // Idempotent on today's date — only write if today's slot is empty.
    // (A second writer landing later in the day SHOULD see a higher
    // count, but the 7-day green-light criterion only checks for
    // `count > 0`, so we keep the first sample of the day.)
    const alreadyWritten = existing.some((s) => s.date === today);
    if (!alreadyWritten) {
      const count = await getDesignConceptIndexSize();
      await writeDailySnapshot(today, count);
    }
  } catch (err: any) {
    console.error(`[Scheduler] Design-concept daily snapshot failed: ${err.message}`);
    Sentry.addBreadcrumb({
      category: "scheduler",
      message: `Design-concept daily snapshot failed: ${err.message}`,
      level: "error",
    });
  }

  // Issue #383 (codex cut-over PR-3): the in-process control loop is gone.
  // #706 (scheduler fold PR-1/4) additionally removed the research-decision
  // plane that used to run here. `runScheduledCycle` now exists solely as a
  // heartbeat for the housekeeping tasks above (stale-claim reaper, weekly
  // digest, memory consolidation, design-concept snapshot).
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

  console.log(`[Scheduler] Started — housekeeping cycles every ${intervalMs / 1000}s`);

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
    // Issue #576: per-cycle cost cap (the codex-era circuit breaker) was
    // retired with `src/cost/cap.ts`. Quota gating now lives in the
    // Subscription Usage Tracker (`/api/usage`, `/api/usage/eligibility`).
    //
    // #706 (scheduler fold PR-1/4): the `research` sub-object (queueThreshold,
    // buildRatioMax/Min, currentRatio, queueDepth*, floor telemetry,
    // lastResearchDecision) was removed along with the in-process
    // research-decision plane. No dashboard reader consumed it. The
    // research-force policy now lives in the autopilot brain
    // (`scripts/autopilot/decide.py` `_research_force_allowed`).
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
  start, stop, getStatus, autoStart,
  formatDuration,
  // Exported for test coverage (issue #381 / #383):
  runScheduledCycle,
};
