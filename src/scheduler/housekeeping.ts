/**
 * Housekeeping
 *
 * The periodic, non-decisional maintenance chores that run hourly in the
 * orchestrator process, surfaced by `POST /api/maintenance/housekeeping` which
 * the host-local `hydra-housekeeping.timer` triggers. This Module is a SIBLING
 * of the **Observability Heartbeat** (`src/scheduler/heartbeat.ts`), not part
 * of it: the Heartbeat records *what happened* (counters, liveness,
 * merge-rate); Housekeeping *performs* periodic maintenance.
 *
 * Both are non-decisional — the **Autopilot Run** (`scripts/autopilot/decide.py`)
 * owns all decisions about *what to do* (ADR-0012: "scheduler is bookkeeping;
 * autopilot is decisions"). Splitting the chores out of `heartbeat.ts`
 * (issue #938) keeps each Module's name a true description of its body: the
 * Heartbeat's "strictly observability-and-counters only" contract is no longer
 * contradicted by chore code sharing the same file.
 *
 * The set is the six chores moved off the 5-minute tick in #723, plus the
 * forecast-calibration-brier producer added in #1657:
 *   - blocked-item re-escalation (+ its operator unblock-command builder),
 *   - the `/hydra-review` pickup-set edge-triggered phone-notify,
 *   - done-lane pruning,
 *   - the weekly Telegram digest,
 *   - daily memory consolidation,
 *   - the daily design-concept snapshot,
 *   - the forecast-calibration-brier leading-outcome producer (#1657).
 *
 * Each chore carries its own Redis time-guard (per-item / daily / weekly), so
 * an hourly invocation is idempotent — a chore whose window has not elapsed is
 * skipped. The Module's Interface is the `{ ran, skipped }` summary: a single
 * Seam reporting which chores did work this invocation.
 */

import * as Sentry from "@sentry/node";
import { loadBacklog } from "../backlog/reads.ts";
import { pruneOldDoneItems } from "../backlog/lanes.ts";
import { getTargetName } from "../target-config.ts";
import {
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
      console.log(`[Housekeeping] Re-escalated blocked item ${item.id} (${ageDays} days)`);
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Blocked escalation check failed: ${err.message}`);
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
      console.log("[Housekeeping] Review pickup set drained — re-armed notify hook");
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
  console.log(`[Housekeeping] Review pickup set non-empty (${count}) — sent notify`);
  return { fired: true, count, transitioned: true };
}

/**
 * Run the time-boxed housekeeping chores.
 *
 * Issue #723 (scheduler fold PR-3/4): these chores were extracted out of
 * `runScheduledCycle` so they can be driven externally by an hourly
 * `hydra-housekeeping.timer` POSTing to `/api/maintenance/housekeeping`,
 * rather than riding on the 5-minute scheduler heartbeat. They still run
 * IN the orchestrator process (they use the live `eventBus` + dynamic
 * imports), so the endpoint approach reuses the running process rather than
 * reconstructing eventBus/Redis in a standalone job.
 *
 * Issue #938: these chores (and their helpers) were moved out of
 * `heartbeat.ts` into this dedicated **Housekeeping** Module so the
 * **Observability Heartbeat** stays genuinely observability-only.
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
async function runHousekeeping(
  eventBus,
  deps: {
    /**
     * Injectable forecast-calibration-brier producer (issue #1657) so the
     * wiring test runs without a live hydra-betting target. Defaults to the
     * real `publishForecastCalibrationBrierMetric` from `src/metrics/publish.ts`.
     */
    publishBrierMetric?: () => Promise<{ ok: boolean }>;
  } = {},
): Promise<{ ran: string[]; skipped: string[] }> {
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
    console.error(`[Housekeeping] Blocked escalation check failed in housekeeping: ${err.message}`);
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
    console.error(`[Housekeeping] Review pickup notify check failed: ${err.message}`);
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
    console.error(`[Housekeeping] Failed to prune old done items: ${err.message}`);
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
        console.log("[Housekeeping] Sent weekly summary");
      }
      ran.push("weekly-summary");
    } else {
      skipped.push("weekly-summary");
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Weekly summary failed: ${err.message}`);
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
    console.error(`[Housekeeping] Memory consolidation failed: ${err.message}`);
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
    console.error(`[Housekeeping] Design-concept daily snapshot failed: ${err.message}`);
    Sentry.addBreadcrumb({
      category: "scheduler",
      message: `Design-concept daily snapshot failed: ${err.message}`,
      level: "error",
    });
    skipped.push("design-concept-snapshot");
  }

  // Forecast-calibration-brier leading-outcome producer (issue #1657) —
  // samples the target's aggregate Brier score (hydra-betting
  // GET /api/calibration/forecast-metrics) and publishes it to
  // metrics/forecast-calibration-brier.txt for the outcomes file adapter.
  // The producer itself never throws and never writes on failure (target
  // unreachable / malformed / null brierScore — stale mtime is the staleness
  // signal), so "ran" here means "sampled", not necessarily "wrote". Hourly
  // re-publish of the same current value is idempotent, so no Redis
  // time-guard is needed; "skipped" only on an unexpected throw.
  try {
    const publishBrier = deps.publishBrierMetric
      ?? (await import("../metrics/publish.ts")).publishForecastCalibrationBrierMetric;
    await publishBrier();
    ran.push("forecast-calibration-brier");
  } catch (err: any) {
    console.error(`[Housekeeping] forecast-calibration-brier producer failed: ${err.message}`);
    Sentry.addBreadcrumb({
      category: "scheduler",
      message: `forecast-calibration-brier producer failed: ${err.message}`,
      level: "error",
    });
    skipped.push("forecast-calibration-brier");
  }

  return { ran, skipped };
}

export {
  runHousekeeping,
  // Issue #745: edge-triggered /hydra-review pickup-set notify hook, exported
  // for test coverage (injectable pickup-set + armed-state deps).
  checkReviewPickupNotify,
};
