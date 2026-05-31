/**
 * Observability Heartbeat
 *
 * NOT a decisional brain. This module makes no policy decisions, dispatches
 * no work, and mutates no kanban/work-queue state — the autopilot
 * (`scripts/autopilot/decide.py`) is the orchestrator's single decisional
 * brain. This is a dumb liveness heartbeat plus a counter/observability
 * surface:
 *
 *   - stamps `lastTickAt` every tick so the watchdog can tell "alive" from
 *     "wedged" (issue #397);
 *   - computes the rolling merge-rate window for `GET /api/scheduler/status`
 *     (issue #232);
 *   - holds the deliberate-stop marker so the watchdog refuses to
 *     auto-restart an operator stop (issue #388);
 *   - rehydrates lifetime cycle counters from Redis on start so
 *     `/api/scheduler/status` reports stable metrics after a restart.
 *
 * The five time-boxed housekeeping chores were lifted out to the hourly
 * `/api/maintenance/housekeeping` endpoint in #723 (scheduler fold PR-3/4);
 * `runHousekeeping` lives here only because it reuses the live `eventBus` +
 * dynamic imports, and is invoked out-of-band by that endpoint.
 *
 * Renamed from the former `loop.ts` in this directory in #725 (scheduler
 * fold PR-4/4, completes PP-1) to make the "no second brain" identity
 * explicit. The public surface is unchanged:
 * `start`/`stop`/`getStatus`/`autoStart`.
 *
 * Controlled via API: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
 */

import * as Sentry from "@sentry/node";
import { getMetricsTrend } from "../metrics/trend.ts";
import { loadBacklog } from "../backlog/reads.ts";
import { pruneOldDoneItems } from "../backlog/lanes.ts";
import { getTargetName } from "../target-config.ts";
import {
  getSchedulerCyclesRun,
  getSchedulerCyclesMerged,
  getSchedulerCyclesFailed,
  getLastResearchAtMs,
  getSchedulerStateVersion,
  getSchedulerStateRaw,
  getSchedulerDeliberateStop, setSchedulerDeliberateStop, clearSchedulerDeliberateStop,
  getBlockedLastEscalation, setBlockedLastEscalation,
  getDigestLastWeekly, setDigestLastWeekly,
  getMemoryLastConsolidation, setMemoryLastConsolidation,
} from "../redis/scheduler.ts";
import {
  getReviewPickupNotified,
  setReviewPickupNotified,
  clearReviewPickupNotified,
} from "../redis/review.ts";
import { getReviewPickupSet } from "../review-pickup.ts";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (issue #725: slowed from 2min; watchdog staleness threshold is 15min = 3x margin)
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
    console.error(`[Heartbeat] Rolling merge-rate computation failed: ${err?.message || err}`);
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
// Heartbeat state rehydration (read-only)
// ---------------------------------------------------------------------------
//
// The in-memory `state` is reset on every orchestrator restart. On startup,
// loadSchedulerState() merges any persisted values back in before the first
// tick so /api/scheduler/status reports stable metrics immediately.
//
// Historical note: the research-throttle (`lastResearchAt`) and architect
// counter were written back via a `saveSchedulerState()` writer, because a
// reset `lastResearchAt` used to trigger an immediate unwanted research cycle
// (~$3-8 in Codex). That writer was removed in #725 (scheduler fold PR-4/4)
// once the research-decision plane that called it was deleted in #706
// (PR-1/4). The persisted `SCHEDULER_STATE_KEY` value is now read-only here —
// loadSchedulerState() still merges any historical value in, but nothing in
// this heartbeat writes it. The research-force policy lives in the autopilot
// brain (`scripts/autopilot/decide.py`).
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
      console.log("[Heartbeat] No persisted state in Redis — starting fresh");
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
      console.error(`[Heartbeat] Failed to load deliberate-stop marker: ${err.message}`);
    }

    console.log(`[Heartbeat] Loaded persisted state — lastResearchAt=${state.lastResearchAt}, cyclesRun=${state.cyclesRun}, cyclesMerged=${state.cyclesMerged}, cyclesFailed=${state.cyclesFailed}, version=${state._stateVersion}, stopReason=${state.stopReason ?? "none"}`);
  } catch (err: any) {
    console.error(`[Heartbeat] Failed to load persisted state: ${err.message}`);
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
      console.log(`[Heartbeat] Re-escalated blocked item ${item.id} (${ageDays} days)`);
    }
  } catch (err: any) {
    console.error(`[Heartbeat] Blocked escalation check failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// /hydra-review pickup-set phone-notify hook (issue #745)
// ---------------------------------------------------------------------------
//
// Edge-triggered: fires exactly ONE notification when the /hydra-review pickup
// set (operator-decision-queue + ready-for-human + stale-blocked) transitions
// from empty -> non-empty, then suppresses repeats while it stays non-empty,
// and re-arms once it drains to empty. The armed-state flag lives in Redis
// (`hydra:review:pickup-armed`) so the edge survives an orchestrator restart —
// a bounce mid-non-empty must NOT re-fire.
//
// Reuses the existing notifications stream -> Telegram bridge (no new
// transport; secrets via env per ADR-0005). Never throws — a failed fetch is
// treated as "couldn't sample", which leaves the armed-state untouched so the
// next tick re-evaluates. Better a missed alert than a spurious one.

/**
 * Sample the pickup set and fire/suppress the edge-triggered notification.
 *
 * Returns a small summary `{ fired, count, transitioned }` so the housekeeping
 * caller and tests can see what happened. `transitioned` is true on either
 * edge (empty->non-empty fires; non-empty->empty re-arms).
 *
 * `deps` is injectable so the test suite can stub the pickup-set fetch and the
 * armed-state accessors without a live Redis / `gh`.
 */
async function checkReviewPickupNotify(
  eventBus,
  deps: {
    getPickupSet?: typeof getReviewPickupSet;
    getNotified?: typeof getReviewPickupNotified;
    setNotified?: typeof setReviewPickupNotified;
    clearNotified?: typeof clearReviewPickupNotified;
  } = {},
): Promise<{ fired: boolean; count: number; transitioned: boolean }> {
  const getPickupSet = deps.getPickupSet ?? getReviewPickupSet;
  const getNotified = deps.getNotified ?? getReviewPickupNotified;
  const setNotified = deps.setNotified ?? setReviewPickupNotified;
  const clearNotified = deps.clearNotified ?? clearReviewPickupNotified;

  const items = await getPickupSet();
  const count = items.length;
  const alreadyNotified = await getNotified();

  if (count === 0) {
    // Set is empty — re-arm if a prior notification is still suppressing.
    if (alreadyNotified) {
      await clearNotified();
      console.log("[Heartbeat] Review pickup set drained — re-armed notify hook");
      return { fired: false, count: 0, transitioned: true };
    }
    return { fired: false, count: 0, transitioned: false };
  }

  // Set is non-empty.
  if (alreadyNotified) {
    // Already alerted for this non-empty run — suppress.
    return { fired: false, count, transitioned: false };
  }

  // Empty -> non-empty edge: fire exactly one notification, then arm-spent.
  const first = items[0];
  const { STREAMS } = await import("../event-bus.ts");
  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "review:pickup_ready",
    source: "scheduler",
    correlationId: `review-pickup-${first.number}`,
    payload: {
      count,
      firstTitle: first.title,
      firstUrl: first.url,
      firstNumber: first.number,
    },
  });
  await setNotified();
  console.log(`[Heartbeat] Review pickup set non-empty (${count}) — sent notify`);
  return { fired: true, count, transitioned: true };
}

/**
 * Run the time-boxed housekeeping chores.
 *
 * Issue #723 (scheduler fold PR-3/4): these chores were extracted out of
 * `runScheduledCycle` so they can be driven externally by an hourly
 * `hydra-housekeeping.timer` POSTing to `/api/maintenance/housekeeping`,
 * rather than riding on the 2-minute scheduler heartbeat. They still run
 * IN the orchestrator process (they use the live `eventBus` + dynamic
 * imports), so the endpoint approach reuses the running process rather than
 * reconstructing eventBus/Redis in a standalone job.
 *
 * Each chore KEEPS its own internal time-guard verbatim (weekly/daily/
 * per-day/per-item idempotency), so hourly invocation is safe — the guards
 * skip work that has already run within its window. A second immediate call
 * therefore skips the guarded chores.
 *
 * Returns a `{ ran, skipped }` summary so callers (the endpoint, tests) can
 * see which chores did work this invocation vs. which were skipped by their
 * time-guard. Never throws — each chore is independently try/caught so one
 * failure doesn't abort the rest.
 */
async function runHousekeeping(eventBus): Promise<{ ran: string[]; skipped: string[] }> {
  const ran: string[] = [];
  const skipped: string[] = [];

  // Check blocked items for re-escalation. The per-item 12h guard lives
  // inside checkBlockedEscalation (BLOCKED_REESCALATE_MS), so this is safe to
  // call hourly. We always count it as "ran" — it iterates the blocked lane
  // and applies its own per-item guard internally.
  try {
    await checkBlockedEscalation(eventBus);
    ran.push("blocked-escalation");
  } catch (err: any) {
    console.error(`[Heartbeat] Blocked escalation check failed in housekeeping: ${err.message}`);
    skipped.push("blocked-escalation");
  }

  // Issue #745: /hydra-review pickup-set phone-notify hook. The edge-trigger
  // armed-state (Redis `hydra:review:pickup-armed`) is the idempotency guard —
  // it only FIRES on an empty -> non-empty transition, so calling this hourly
  // is safe (a steady non-empty set is suppressed). Counts as "ran" when it
  // either sampled cleanly or fired; "skipped" only on an unexpected throw.
  try {
    await checkReviewPickupNotify(eventBus);
    ran.push("review-pickup-notify");
  } catch (err: any) {
    console.error(`[Heartbeat] Review pickup notify check failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `review-pickup-notify failed: ${err.message}`, level: "error" });
    skipped.push("review-pickup-notify");
  }

  // Prune old done-lane items from the backlog. Lives at the tick level
  // rather than wedged inside `maybeRunResearch` so it still runs when the
  // research path early-exits on any of its skip gates.
  try {
    await pruneOldDoneItems();
    ran.push("prune-done");
  } catch (err: any) {
    console.error(`[Heartbeat] Failed to prune old done items: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `pruneOldDoneItems failed: ${err.message}`, level: "error" });
    skipped.push("prune-done");
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
        console.log("[Heartbeat] Sent weekly summary");
      }
      ran.push("weekly-summary");
    } else {
      skipped.push("weekly-summary");
    }
  } catch (err: any) {
    console.error(`[Heartbeat] Weekly summary failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `Weekly summary failed: ${err.message}`, level: "error" });
    skipped.push("weekly-summary");
  }

  // Daily memory consolidation — prune stale patterns
  try {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const lastConsolidation = await getMemoryLastConsolidation();
    if (!lastConsolidation || Date.now() - parseInt(lastConsolidation) >= DAY_MS) {
      const { consolidate } = await import("../learning.ts");
      await consolidate();
      await setMemoryLastConsolidation(Date.now().toString());
      ran.push("memory-consolidation");
    } else {
      skipped.push("memory-consolidation");
    }
  } catch (err: any) {
    console.error(`[Heartbeat] Memory consolidation failed: ${err.message}`);
    Sentry.addBreadcrumb({ category: "scheduler", message: `Memory consolidation failed: ${err.message}`, level: "error" });
    skipped.push("memory-consolidation");
  }

  // Daily design-concept snapshot (issue #628; metric revised in #736) —
  // record today's *production count* (how many concepts were created
  // today) so the green-light criterion measures the gate WORKING rather
  // than "an artifact happens to be alive". PR #567 retired the
  // heavyweight B-4 telemetry endpoint; this is the lightweight
  // replacement (one hash field per day, 14-day bounded). Pre-#736 this
  // wrote `ZCARD` of the TTL-decaying index, so a quiet day reset the
  // streak — that is the bug being fixed.
  try {
    const {
      getDesignConceptProductionCountForDate,
      writeDailySnapshot,
      readDailySnapshots,
    } = await import("../redis/design-concept.ts");
    const today = new Date().toISOString().slice(0, 10);
    const count = await getDesignConceptProductionCountForDate(today);
    // Idempotent + monotone (the #736 invariant): a same-day re-run only
    // WRITES when the freshly-sampled production count is higher than
    // what's already stored for today (a concept produced later today).
    // A no-change re-run SKIPS, so hourly housekeeping stays idempotent.
    const existing = await readDailySnapshots();
    const stored = existing.find((s) => s.date === today)?.count;
    if (stored === undefined || count > stored) {
      await writeDailySnapshot(today, count);
      ran.push("design-concept-snapshot");
    } else {
      skipped.push("design-concept-snapshot");
    }
  } catch (err: any) {
    console.error(`[Heartbeat] Design-concept daily snapshot failed: ${err.message}`);
    Sentry.addBreadcrumb({
      category: "scheduler",
      message: `Design-concept daily snapshot failed: ${err.message}`,
      level: "error",
    });
    skipped.push("design-concept-snapshot");
  }

  return { ran, skipped };
}

async function runScheduledCycle(eventBus) {
  if (!state.running) return;

  // Issue #383 (codex cut-over PR-3): the in-process control loop is gone.
  // #706 (scheduler fold PR-1/4) additionally removed the research-decision
  // plane that used to run here. #723 (scheduler fold PR-3/4) moved the five
  // time-boxed housekeeping chores (blocked re-escalation, done-lane pruning,
  // weekly digest, memory consolidation, design-concept snapshot) out to an
  // hourly `hydra-housekeeping.timer` that POSTs `/api/maintenance/housekeeping`
  // → `runHousekeeping(eventBus)`. `runScheduledCycle` now exists solely as a
  // heartbeat + rolling-merge-rate observability surface; PR-4 renames/slims it.
  //
  // Issue #397: the heartbeat moves to `lastTickAt` so liveness probes can
  // tell "scheduler is alive" apart from "the control loop ran". The legacy
  // `lastCycleAt` field is left null on purpose — there is no `runControlLoop`
  // invocation to point at, so reporting a stale codex timestamp here misleads
  // the dashboard and the watchdog. Operators that want liveness must read
  // `lastTickAt`. computeRollingMergeRate is exercised here (via getStatus on
  // the status endpoint) — the tick keeps the heartbeat advancing so the
  // watchdog can distinguish alive from wedged.
  state.lastTickAt = new Date().toISOString();
  if (state.running) {
    const delay = state.intervalMs || DEFAULT_INTERVAL_MS;
    state.timer = setTimeout(
      () => runScheduledCycle(eventBus).catch((err: any) =>
        console.error(`[Heartbeat] Scheduled cycle failed: ${err.message}`),
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
    console.error(`[Heartbeat] Failed to clear deliberate-stop marker: ${err.message}`);
  }

  console.log(`[Heartbeat] Started — housekeeping cycles every ${intervalMs / 1000}s`);

  // Run first cycle immediately (fire-and-forget — errors handled inside runScheduledCycle)
  runScheduledCycle(eventBus).catch((err: any) => console.error(`[Heartbeat] First cycle failed: ${err.message}`));

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
      console.error(`[Heartbeat] Failed to persist deliberate-stop marker: ${err.message}`);
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

  console.log(`[Heartbeat] Stopped after ${state.cyclesRun} cycles (reason=${reason})`);

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
    console.log(`[Heartbeat] Auto-starting from HYDRA_AUTO_CYCLE_INTERVAL_MS=${interval}`);
    return await start(eventBus, { intervalMs: interval });
  }
  return null;
}

export {
  start, stop, getStatus, autoStart,
  formatDuration,
  // Exported for test coverage (issue #381 / #383):
  runScheduledCycle,
  // Issue #723 (scheduler fold PR-3/4): the housekeeping chores, callable
  // out-of-band by the `/api/maintenance/housekeeping` endpoint / hourly timer.
  runHousekeeping,
  // Issue #745: edge-triggered /hydra-review pickup-set notify hook, exported
  // for test coverage (injectable pickup-set + armed-state deps).
  checkReviewPickupNotify,
};
