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
  getCleanupLastDaily, setCleanupLastDaily,
} from "../redis/scheduler.ts";
import {
  getReviewPickupNotified,
  setReviewPickupNotified,
  clearReviewPickupNotified,
} from "../redis/review.ts";
import { getReviewPickupSet } from "../review-pickup.ts";
import {
  pruneMetricsIndex,
  getMetricsIndexSize,
  trimMetricsIndex,
} from "../redis/cycle-metrics.ts";
import {
  scanKeys,
  getKeyTTL,
  getKeyType,
  hashGet,
  deleteKeysBatch,
} from "../redis/utility.ts";
import {
  getBacklogLaneWithScores,
  getBacklogItem,
  moveBacklogItem,
} from "../redis/backlog.ts";

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

// ---------------------------------------------------------------------------
// Stale-Redis-key sweep + stale-inProgress return (issue #1876)
// ---------------------------------------------------------------------------
//
// Folded out of the cleanup.ts module-level 24h `setInterval` into two
// housekeeping chores so all periodic maintenance lives behind the one
// idempotent `POST /api/maintenance/housekeeping` Seam. The work bodies are
// unchanged from cleanup.ts; only the dispatch path moved. `pruneStaleRedisKeys`
// gets a daily Redis time-guard (`getCleanupLastDaily`/`setCleanupLastDaily`)
// because housekeeping runs hourly; `returnStaleInProgressItems` is naturally
// idempotent (it re-checks each item's age every call) so it has no guard.

// Prefix shapes used by the stale-key sweep. Kept inline (rather than importing
// from redis/keys.ts) because this is a housekeeping sweep, not a domain owner —
// these strings describe what to scan for, not how to use the keys.
const CYCLE_KEY_PREFIX = "hydra:cycle:";
const TASK_KEY_PREFIX = "hydra:task:";
const METRICS_KEY_PREFIX = "hydra:metrics:";
const CYCLE_ACTIVE_KEY = "hydra:cycle:active";
const CYCLE_LAST_KEY = "hydra:cycle:last";

const STALE_KEY_RETENTION_DAYS = 7;
const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const METRICS_INDEX_MAX_ENTRIES = 500;

/**
 * Prune stale cycle/task/metrics Redis keys older than 7 days with no TTL.
 * Exported for unit coverage — the same body that ran on the cleanup.ts timer.
 */
async function pruneStaleRedisKeys(): Promise<void> {
  const cutoffMs = Date.now() - STALE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let totalPruned = 0;

  // Prune old metrics from sorted index, then delete orphaned metric keys
  try {
    const removed = await pruneMetricsIndex(cutoffMs);
    if (removed > 0) {
      totalPruned += removed;
      console.log(`[Housekeeping] Pruned ${removed} old metrics index entries`);
    }
    // Trim to max entries as a safety cap
    const indexSize = await getMetricsIndexSize();
    if (indexSize > METRICS_INDEX_MAX_ENTRIES) {
      const excess = indexSize - METRICS_INDEX_MAX_ENTRIES;
      await trimMetricsIndex(excess);
      console.log(`[Housekeeping] Trimmed metrics index by ${excess} (cap: ${METRICS_INDEX_MAX_ENTRIES})`);
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Metrics index prune failed: ${err.message}`);
  }

  // Prune old cycle/task/metrics keys by scanning and checking timestamps.
  // Keys come in two forms:
  //   1. Parent hashes (hydra:cycle:cycle-2026-04-03-1447) — have startedAt field
  //   2. Sub-keys (hydra:cycle:cycle-2026-04-03-1447:tasks, :agents, :costs) — set/list/hash without timestamp
  //   3. Task evidence (hydra:task:task-cycle-2026-04-03-1447-1:evidence:merged) — string type
  // For non-hash keys and hashes without a timestamp field, extract the date from
  // the key name pattern (YYYY-MM-DD) and use that as the age indicator.
  const dateInKeyPattern = /(\d{4}-\d{2}-\d{2})/;
  for (const prefix of [CYCLE_KEY_PREFIX, TASK_KEY_PREFIX, METRICS_KEY_PREFIX]) {
    try {
      const keys = await scanKeys(`${prefix}*`);
      const toDelete: string[] = [];

      for (const key of keys) {
        // Skip index/counter keys and active/last pointers
        if (key.endsWith(":index") || key.endsWith(":counter") || key === CYCLE_ACTIVE_KEY || key === CYCLE_LAST_KEY) continue;
        const ttl = await getKeyTTL(key);
        if (ttl !== -1) continue; // Already has TTL, skip

        let keyTime: number | null = null;

        // Try hash timestamp fields first (original logic)
        const type = await getKeyType(key);
        if (type === "hash") {
          const ts = await hashGet(key, "startedAt") || await hashGet(key, "createdAt") || await hashGet(key, "timestamp");
          if (ts) {
            const parsed = new Date(ts).getTime();
            if (Number.isFinite(parsed)) keyTime = parsed;
          }
        }

        // Fallback: extract date from key name (handles sub-keys, strings, sets, lists)
        if (keyTime === null) {
          const match = key.match(dateInKeyPattern);
          if (match) {
            const parsed = new Date(match[1] + "T00:00:00Z").getTime();
            if (Number.isFinite(parsed)) keyTime = parsed;
          }
        }

        if (keyTime !== null && keyTime < cutoffMs) {
          toDelete.push(key);
        }
      }

      if (toDelete.length > 0) {
        await deleteKeysBatch(toDelete);
        totalPruned += toDelete.length;
        console.log(`[Housekeeping] Pruned ${toDelete.length} stale ${prefix}* keys`);
      }
    } catch (err: any) {
      console.error(`[Housekeeping] ${prefix}* prune failed: ${err.message}`);
    }
  }

  if (totalPruned > 0) {
    console.log(`[Housekeeping] Total stale Redis keys pruned: ${totalPruned}`);
  }
}

/**
 * Return backlog items stuck in the `inProgress` lane for > 24h back to
 * `queued`. Exported for unit coverage — the same body that ran on the
 * cleanup.ts timer. Naturally idempotent: each invocation re-checks item age.
 */
async function returnStaleInProgressItems(): Promise<void> {
  try {
    const ids = await getBacklogLaneWithScores("inProgress");
    const now = Date.now();
    let returned = 0;

    // ids is [id1, score1, id2, score2, ...]
    for (let i = 0; i < ids.length; i += 2) {
      const id = ids[i];
      const score = Number(ids[i + 1]);
      if (now - score > STALE_IN_PROGRESS_MS) {
        const raw = await getBacklogItem(id);
        if (!raw) continue;
        const item = JSON.parse(raw);
        item.lane = "queued";
        item.meta = { ...item.meta, returnedReason: "stale_in_progress", returnedAt: new Date().toISOString() };
        await moveBacklogItem(id, JSON.stringify(item), "inProgress", "queued");
        returned++;
        console.log(`[Housekeeping] Returned stale inProgress item ${id} ("${item.title?.slice(0, 60)}") to queued`);
      }
    }

    if (returned > 0) {
      console.log(`[Housekeeping] Returned ${returned} stale inProgress items to queued`);
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Stale inProgress check failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Chore runner (issue #1864)
// ---------------------------------------------------------------------------
//
// Every housekeeping chore repeats the same 5-part shape: optional time-guard
// → work → success bookkeeping (`ran.push`) → error log + Sentry breadcrumb →
// failure bookkeeping (`skipped.push`). Spelling that shape inline 9 times let
// the parts drift — two chores (blocked-escalation, review-pickup-notify) were
// missing their Sentry breadcrumb, and a chore author could silently mis-report
// a chore as skipped by forgetting `ran.push`.
//
// `runChore` encapsulates the pattern so each chore becomes a thin declaration
// (name, optional guard, work) and inherits the error log, the Sentry
// breadcrumb, and the ran/skipped bookkeeping uniformly. A new chore added to
// the registry gets all of that operational hygiene for free.

/**
 * A single housekeeping chore declaration.
 *
 * - `guard` (optional) is the time-window / cadence check. It returns `false`
 *   when the chore should be skipped without running its work (the
 *   weekly/daily idempotency window has not elapsed). A chore with no `guard`
 *   always proceeds to `work` (its idempotency lives inside `work`, e.g. a
 *   per-item Redis stamp).
 * - `work` performs the chore. Returning `false` signals the chore decided at
 *   runtime not to do anything (e.g. the design-concept snapshot whose stored
 *   value is already up to date) — the runner routes that to `skipped` exactly
 *   as a `guard` miss would. Returning `void`/`true` counts as `ran`.
 */
interface Chore {
  name: string;
  guard?: () => Promise<boolean>;
  work: () => Promise<boolean | void>;
}

/**
 * Run one chore through the uniform guard → work → bookkeeping → error-log
 * pattern, appending its name to `ran` or `skipped` accordingly.
 *
 * Never throws: a chore that throws is logged (`console.error`), recorded as a
 * Sentry breadcrumb, and routed to `skipped` so one failure doesn't abort the
 * remaining chores. This is the single place the error format + Sentry
 * breadcrumb live, so a change applies to all chores at once.
 *
 * Exported for unit coverage — a test can inject a failing `work` thunk and
 * assert the runner logs + skips without aborting, with no Redis or HTTP
 * endpoint stood up.
 */
async function runChore(
  chore: Chore,
  ran: string[],
  skipped: string[],
): Promise<void> {
  try {
    if (chore.guard && !(await chore.guard())) {
      skipped.push(chore.name);
      return;
    }
    const result = await chore.work();
    if (result === false) {
      skipped.push(chore.name);
      return;
    }
    ran.push(chore.name);
  } catch (err: any) {
    console.error(`[Housekeeping] ${chore.name} failed: ${err.message}`);
    Sentry.addBreadcrumb({
      category: "scheduler",
      message: `${chore.name} failed: ${err.message}`,
      level: "error",
    });
    skipped.push(chore.name);
  }
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
 * Issue #1864: the 9 bespoke try/catch blocks were collapsed to 9 `Chore`
 * declarations driven by `runChore`, so the guard → work → bookkeeping →
 * error-log + Sentry-breadcrumb pattern lives in exactly one place. Sentry
 * breadcrumb coverage is now uniform (blocked-escalation and
 * review-pickup-notify gained it). Each chore KEEPS its own internal
 * time-guard semantics (weekly/daily/per-day/per-item idempotency), now
 * expressed as a `guard` thunk (or, for the conditional design-concept
 * snapshot, a `work` thunk that returns `false` when no write is needed), so
 * hourly invocation stays safe — a second immediate call skips the guarded
 * chores.
 *
 * Returns a `{ ran, skipped }` summary so callers (the endpoint, tests) can
 * see which chores did work this invocation vs. which were skipped by their
 * time-guard. Never throws — each chore is independently run through
 * `runChore`, which try/catches so one failure doesn't abort the rest.
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

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // The 9 chores as declarations. Each carries an optional `guard` (the
  // cadence window) and a `work` thunk; `runChore` applies the uniform
  // guard → work → bookkeeping → error-log + Sentry-breadcrumb pattern. A
  // chore whose `work` returns `false` is routed to `skipped` (the
  // design-concept snapshot's conditional-write case). Order is preserved
  // verbatim from the pre-#1864 sequential blocks.
  const chores: Chore[] = [
    // Check blocked items for re-escalation. The per-item 12h guard lives
    // inside checkBlockedEscalation (BLOCKED_REESCALATE_MS), so this is safe to
    // call hourly. Always counted as "ran" — it iterates the blocked lane and
    // applies its own per-item guard internally.
    {
      name: "blocked-escalation",
      work: () => checkBlockedEscalation(eventBus),
    },

    // Issue #745: /hydra-review pickup-set phone-notify hook. The edge-trigger
    // armed-state (Redis `hydra:review:pickup-armed`) is the idempotency guard —
    // it only FIRES on an empty -> non-empty transition, so calling this hourly
    // is safe (a steady non-empty set is suppressed). Counts as "ran" when it
    // either sampled cleanly or fired; "skipped" only on an unexpected throw.
    {
      name: "review-pickup-notify",
      work: async () => {
        await checkReviewPickupNotify(eventBus);
      },
    },

    // Prune old done-lane items from the backlog. Lives at the tick level
    // rather than wedged inside `maybeRunResearch` so it still runs when the
    // research path early-exits on any of its skip gates.
    {
      name: "prune-done",
      work: () => pruneOldDoneItems(),
    },

    // Weekly summary — send once per week
    {
      name: "weekly-summary",
      guard: async () => {
        const lastWeekly = await getDigestLastWeekly();
        return !lastWeekly || Date.now() - parseInt(lastWeekly) >= WEEK_MS;
      },
      work: async () => {
        const { buildWeeklySummary } = await import("../digest.ts");
        const summary = await buildWeeklySummary();
        if (summary) {
          const { sendToTelegram } = await import("../notify.ts");
          await sendToTelegram(summary);
          await setDigestLastWeekly(Date.now().toString());
          console.log("[Housekeeping] Sent weekly summary");
        }
      },
    },

    // Daily memory consolidation — prune stale patterns
    {
      name: "memory-consolidation",
      guard: async () => {
        const lastConsolidation = await getMemoryLastConsolidation();
        return !lastConsolidation || Date.now() - parseInt(lastConsolidation) >= DAY_MS;
      },
      work: async () => {
        const { consolidate } = await import("../learning.ts");
        await consolidate();
        await setMemoryLastConsolidation(Date.now().toString());
      },
    },

    // Daily design-concept snapshot (issue #628; metric revised in #736) —
    // record today's *production count* (how many concepts were created
    // today) so the green-light criterion measures the gate WORKING rather
    // than "an artifact happens to be alive". PR #567 retired the
    // heavyweight B-4 telemetry endpoint; this is the lightweight
    // replacement (one hash field per day, 14-day bounded). Pre-#736 this
    // wrote `ZCARD` of the TTL-decaying index, so a quiet day reset the
    // streak — that is the bug being fixed.
    //
    // Idempotent + monotone (the #736 invariant): a same-day re-run only
    // WRITES when the freshly-sampled production count is higher than what's
    // already stored for today (a concept produced later today). A no-change
    // re-run returns `false` so the runner records it as "skipped", keeping
    // hourly housekeeping idempotent.
    {
      name: "design-concept-snapshot",
      work: async () => {
        const {
          getDesignConceptProductionCountForDate,
          writeDailySnapshot,
          readDailySnapshots,
        } = await import("../redis/design-concept.ts");
        const today = new Date().toISOString().slice(0, 10);
        const count = await getDesignConceptProductionCountForDate(today);
        const existing = await readDailySnapshots();
        const stored = existing.find((s) => s.date === today)?.count;
        if (stored === undefined || count > stored) {
          await writeDailySnapshot(today, count);
          return true;
        }
        return false;
      },
    },

    // Work-queue hygiene (issue #1690) — reconcile `hydra:anchors:work-queue`
    // entries against resolved state: entries that are merged work (the #882
    // token scan) or reference orchestrator issues that are ALL closed get
    // LREM'd, so anchors resolved out-of-band stop resurfacing at work-queue
    // tier and burning dev_target dispatches on no-op verify+LREM. The engine
    // is fail-open + idempotent (a second run finds nothing to remove) and its
    // `gh` cost is bounded by an internal per-run cap, so no Redis time-guard is
    // needed; "skipped" only on an unexpected throw.
    {
      name: "work-queue-hygiene",
      work: async () => {
        const { reconcileWorkQueue } = await import("../backlog/work-queue-hygiene.ts");
        const wq = await reconcileWorkQueue();
        if (wq.removed > 0) {
          console.log(
            `[Housekeeping] Work-queue hygiene: removed ${wq.removed} resolved entr${wq.removed === 1 ? "y" : "ies"} (scanned ${wq.scanned})`,
          );
        }
      },
    },

    // Merge→done reconciler (issue #1715) — sweeps recently merged target PRs
    // and default-branch merge commits for `item-NNN` references and moves any
    // referenced item still in a non-done lane to `done` with audit stamps
    // (`reconciledAt`/`reconciledFrom`). Generalises the reaper's merged-PR
    // guard (#1714), which only covers stale inProgress claims. Fail-closed +
    // idempotent (done items aren't scanned; a `gh` outage is a guaranteed
    // no-op) and its `gh` cost is two bounded list calls, so no Redis
    // time-guard is needed; "skipped" only on an unexpected throw.
    {
      name: "merged-item-reconciler",
      work: async () => {
        const { reconcileMergedItems } = await import("../backlog/reconciler.ts");
        const rec = await reconcileMergedItems();
        if (rec.reconciled.length > 0) {
          console.log(
            `[Housekeeping] Merge→done reconciler: closed ${rec.reconciled.length} item${rec.reconciled.length === 1 ? "" : "s"} (scanned ${rec.scanned}): ${rec.reconciled.map((r) => `${r.id}←${r.ref}`).join(", ")}`,
          );
        }
      },
    },

    // Forecast-calibration-brier leading-outcome producer (issue #1657) —
    // samples the target's aggregate Brier score (hydra-betting
    // GET /api/calibration/forecast-metrics) and publishes it to
    // metrics/forecast-calibration-brier.txt for the outcomes file adapter.
    // The producer itself never throws and never writes on failure (target
    // unreachable / malformed / null brierScore — stale mtime is the staleness
    // signal), so "ran" here means "sampled", not necessarily "wrote". Hourly
    // re-publish of the same current value is idempotent, so no Redis
    // time-guard is needed; "skipped" only on an unexpected throw.
    {
      name: "forecast-calibration-brier",
      work: async () => {
        const publishBrier = deps.publishBrierMetric
          ?? (await import("../metrics/publish.ts")).publishForecastCalibrationBrierMetric;
        await publishBrier();
      },
    },

    // Stale-Redis-key sweep (issue #1876) — folded out of the cleanup.ts 24h
    // in-process setInterval. Daily idempotency: housekeeping runs hourly, so a
    // Redis-stamped daily guard runs the sweep at most once per day (same shape
    // as weekly-summary / memory-consolidation). The sweep itself is internally
    // defensive (per-prefix try/catch), so "ran" means "the guard let it run".
    {
      name: "stale-key-prune",
      guard: async () => {
        const lastDaily = await getCleanupLastDaily();
        return !lastDaily || Date.now() - parseInt(lastDaily) >= DAY_MS;
      },
      work: async () => {
        await pruneStaleRedisKeys();
        await setCleanupLastDaily(Date.now().toString());
      },
    },

    // Stale-inProgress return (issue #1876) — folded out of the cleanup.ts 24h
    // timer. Returns backlog items stuck in `inProgress` for > 24h to `queued`.
    // No Redis time-guard: the work re-checks each item's age every invocation,
    // so hourly calls are naturally idempotent (an item not yet 24h stale is
    // left alone; once it crosses 24h the next call returns it exactly once,
    // after which it is no longer in the inProgress lane).
    {
      name: "stale-inprogress-return",
      work: () => returnStaleInProgressItems(),
    },
  ];

  for (const chore of chores) {
    await runChore(chore, ran, skipped);
  }

  return { ran, skipped };
}

export {
  runHousekeeping,
  // Issue #745: edge-triggered /hydra-review pickup-set notify hook, exported
  // for test coverage (injectable pickup-set + armed-state deps).
  checkReviewPickupNotify,
  // Issue #1864: the extracted guarded-chore runner, exported so a unit test
  // can inject a failing / guard-skipping / work-skipping chore thunk and
  // assert the uniform guard → work → bookkeeping → error-log + Sentry
  // pattern without standing up the maintenance endpoint or Redis.
  runChore,
  // Issue #1876: the two cleanup chores folded out of the cleanup.ts in-process
  // timer, exported so they are exercisable without an HTTP server or a live
  // setInterval (the testability benefit called out in the issue).
  pruneStaleRedisKeys,
  returnStaleInProgressItems,
};
