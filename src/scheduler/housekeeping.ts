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
 * forecast-calibration-brier producer added in #1657, plus the two cleanup
 * chores folded out of cleanup.ts (#1876) and the lane-index reconciler (#2056):
 *   - blocked-item re-escalation (+ its operator unblock-command builder),
 *   - the `/hydra-review` pickup-set edge-triggered phone-notify,
 *   - done-lane pruning,
 *   - the weekly Telegram digest,
 *   - daily memory consolidation,
 *   - the daily design-concept snapshot,
 *   - work-queue hygiene,
 *   - the merge→done reconciler,
 *   - the forecast-calibration-brier leading-outcome producer (#1657),
 *   - the stale-Redis-key sweep + stale-inProgress return (#1876),
 *   - the lane-index reconciler (#2056).
 *
 * Each chore carries its own Redis time-guard (per-item / daily / weekly), so
 * an hourly invocation is idempotent — a chore whose window has not elapsed is
 * skipped. The Module's Interface is the `{ ran, skipped }` summary: a single
 * Seam reporting which chores did work this invocation.
 *
 * Issue #2067: each chore is now a *named exported function* accepting only its
 * own deps subset (the external touchpoints it reaches — Redis accessors,
 * sibling modules, the event bus), each defaulting to the real implementation.
 * `runHousekeeping` stays the composition owner: it sequences the chores in the
 * same order, applies the same Redis time-guards, and reports `{ ran, skipped }`
 * — behaviour-neutral. Testing one chore no longer requires constructing a deps
 * object for all of them; a unit test stubs only that chore's deps.
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
} from "../redis/housekeeping.ts";
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
import type { PublishableBus } from "../api/event-bus-types.ts";

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

// ---------------------------------------------------------------------------
// Blocked-item re-escalation (every 12h per item)
// ---------------------------------------------------------------------------

const BLOCKED_REESCALATE_MS = 12 * 60 * 60 * 1000;

/**
 * External touchpoints of the blocked-escalation chore. Each defaults to the
 * real implementation, so callers (incl. `runHousekeeping`) need only pass the
 * `eventBus`; a unit test stubs just these to exercise the chore in isolation.
 */
export interface BlockedItemEscalationDeps {
  loadBacklog?: typeof loadBacklog;
  getLastEscalation?: typeof getBlockedLastEscalation;
  setLastEscalation?: typeof setBlockedLastEscalation;
  now?: () => number;
}

/**
 * Check for blocked items that need re-escalation. The per-item 12h guard lives
 * inside this body (`BLOCKED_REESCALATE_MS`), so it is safe to call hourly:
 * it iterates the blocked lane and applies its own per-item guard internally.
 */
export async function runBlockedItemEscalation(
  eventBus: PublishableBus,
  deps: BlockedItemEscalationDeps = {},
): Promise<void> {
  const loadBacklogFn = deps.loadBacklog ?? loadBacklog;
  const getLastEscalation = deps.getLastEscalation ?? getBlockedLastEscalation;
  const setLastEscalation = deps.setLastEscalation ?? setBlockedLastEscalation;
  const nowFn = deps.now ?? Date.now;
  try {
    const lanes = await loadBacklogFn();
    // AC5 (issue #140): freeze snapshot so iteration doesn't see mutations
    const blocked = [...(lanes.blocked || [])];
    if (blocked.length === 0) return;

    const now = nowFn();

    for (const item of blocked) {
      const blockedAt = item.meta?.blockedAt ? new Date(item.meta.blockedAt).getTime() : 0;
      if (!blockedAt) continue;
      const age = now - blockedAt;
      if (age < BLOCKED_REESCALATE_MS) continue;

      const lastEsc = await getLastEscalation(item.id);
      if (lastEsc && now - parseInt(lastEsc) < BLOCKED_REESCALATE_MS) continue;

      await setLastEscalation(item.id, now.toString());
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
 * External touchpoints of the review-pickup-notify chore. `deps` is injectable
 * so the test suite can stub the pickup-set fetch and the armed-state accessors
 * without a live Redis / `gh`.
 */
export interface ReviewPickupNotifyDeps {
  getPickupSet?: typeof getReviewPickupSet;
  getNotified?: typeof getReviewPickupNotified;
  setNotified?: typeof setReviewPickupNotified;
  clearNotified?: typeof clearReviewPickupNotified;
}

/**
 * Sample the pickup set and fire/suppress the edge-triggered notification.
 *
 * Returns a small summary `{ fired, count, transitioned }` so the housekeeping
 * caller and tests can see what happened. `transitioned` is true on either
 * edge (empty->non-empty fires; non-empty->empty re-arms).
 */
export async function runReviewPickupNotify(
  eventBus: PublishableBus,
  deps: ReviewPickupNotifyDeps = {},
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

// Issue #745 / #938: legacy name kept as an alias so any out-of-tree caller or
// older test that imported `checkReviewPickupNotify` keeps working. #2067
// renamed it `runReviewPickupNotify` for naming symmetry across the chore set.
export const checkReviewPickupNotify = runReviewPickupNotify;

// ---------------------------------------------------------------------------
// Done-lane pruning
// ---------------------------------------------------------------------------

/** External touchpoints of the done-lane prune chore. */
export interface DoneLanePruneDeps {
  pruneOldDoneItems?: typeof pruneOldDoneItems;
}

/**
 * Prune old done-lane items from the backlog. Lives at the tick level rather
 * than wedged inside `maybeRunResearch` so it still runs when the research path
 * early-exits on any of its skip gates.
 */
export async function runDoneLanePrune(deps: DoneLanePruneDeps = {}): Promise<void> {
  const pruneFn = deps.pruneOldDoneItems ?? pruneOldDoneItems;
  await pruneFn();
}

// ---------------------------------------------------------------------------
// Weekly Telegram digest
// ---------------------------------------------------------------------------

/** External touchpoints of the weekly-digest chore. */
export interface WeeklyDigestDeps {
  buildWeeklySummary?: () => Promise<string | null>;
  sendToTelegram?: (message: string) => Promise<void> | void;
  setLastWeekly?: typeof setDigestLastWeekly;
}

/**
 * Build and send the weekly Telegram summary, stamping the weekly guard key on
 * success. The weekly cadence guard is applied by `runHousekeeping` before this
 * runs; this body sends at most one summary per call.
 */
export async function runWeeklyDigest(deps: WeeklyDigestDeps = {}): Promise<void> {
  const buildWeeklySummary =
    deps.buildWeeklySummary ?? (await import("../digest.ts")).buildWeeklySummary;
  const setLastWeekly = deps.setLastWeekly ?? setDigestLastWeekly;
  const summary = await buildWeeklySummary();
  if (summary) {
    const sendToTelegram =
      deps.sendToTelegram ?? (await import("../notify.ts")).sendToTelegram;
    await sendToTelegram(summary);
    await setLastWeekly(Date.now().toString());
    console.log("[Housekeeping] Sent weekly summary");
  }
}

// ---------------------------------------------------------------------------
// Daily memory consolidation
// ---------------------------------------------------------------------------

/** External touchpoints of the memory-consolidation chore. */
export interface MemoryConsolidationDeps {
  consolidate?: () => Promise<unknown>;
  setLastConsolidation?: typeof setMemoryLastConsolidation;
}

/**
 * Daily memory consolidation — prune stale patterns, then stamp the daily
 * guard key. The daily cadence guard is applied by `runHousekeeping`.
 */
export async function runMemoryConsolidation(deps: MemoryConsolidationDeps = {}): Promise<void> {
  const consolidate =
    deps.consolidate ?? (await import("../learning-lifecycle.ts")).consolidate;
  const setLastConsolidation = deps.setLastConsolidation ?? setMemoryLastConsolidation;
  await consolidate();
  await setLastConsolidation(Date.now().toString());
}

// ---------------------------------------------------------------------------
// Daily design-concept snapshot (issue #628; metric revised in #736)
// ---------------------------------------------------------------------------

interface DesignConceptSnapshotModule {
  getDesignConceptProductionCountForDate: (date: string) => Promise<number>;
  writeDailySnapshot: (date: string, count: number) => Promise<unknown>;
  readDailySnapshots: () => Promise<Array<{ date: string; count: number }>>;
}

/** External touchpoints of the design-concept-snapshot chore. */
export interface DesignConceptSnapshotDeps {
  module?: DesignConceptSnapshotModule;
  today?: () => string;
}

/**
 * Daily design-concept snapshot (issue #628; metric revised in #736) — record
 * today's *production count* (how many concepts were created today) so the
 * green-light criterion measures the gate WORKING rather than "an artifact
 * happens to be alive".
 *
 * Idempotent + monotone (the #736 invariant): a same-day re-run only WRITES
 * when the freshly-sampled production count is higher than what's already
 * stored for today. A no-change re-run returns `false` so the runner records it
 * as "skipped", keeping hourly housekeeping idempotent.
 */
export async function runDesignConceptSnapshot(
  deps: DesignConceptSnapshotDeps = {},
): Promise<boolean> {
  const mod = deps.module ?? (await import("../redis/design-concept.ts"));
  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const count = await mod.getDesignConceptProductionCountForDate(today);
  const existing = await mod.readDailySnapshots();
  const stored = existing.find((s) => s.date === today)?.count;
  if (stored === undefined || count > stored) {
    await mod.writeDailySnapshot(today, count);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Work-queue hygiene (issue #1690)
// ---------------------------------------------------------------------------

/** External touchpoints of the work-queue-hygiene chore. */
interface WorkQueueHygieneDeps {
  reconcileWorkQueue?: () => Promise<{ removed: number; scanned: number }>;
}

/**
 * Work-queue hygiene (issue #1690) — reconcile `hydra:anchors:work-queue`
 * entries against resolved state. The engine is fail-open + idempotent (a
 * second run finds nothing to remove) and its `gh` cost is bounded by an
 * internal per-run cap, so no Redis time-guard is needed.
 */
async function runWorkQueueHygiene(deps: WorkQueueHygieneDeps = {}): Promise<void> {
  const reconcileWorkQueue =
    deps.reconcileWorkQueue ?? (await import("../backlog/work-queue-hygiene.ts")).reconcileWorkQueue;
  const wq = await reconcileWorkQueue();
  if (wq.removed > 0) {
    console.log(
      `[Housekeeping] Work-queue hygiene: removed ${wq.removed} resolved entr${wq.removed === 1 ? "y" : "ies"} (scanned ${wq.scanned})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Merge→done reconciler (issue #1715)
// ---------------------------------------------------------------------------

/** Per-feed liveness + batch metrics shape returned by the reconciler (#2057). */
interface ReconcilerRunResult {
  reconciled: Array<{ id: string; ref: string }>;
  escalated?: Array<{ id: string; reason: string }>;
  scanned: number;
  feed?: {
    prs: { examined: number; failed?: string };
    commits: { examined: number; failed?: string };
  };
  metrics?: { referencesFound: number; movesFailed: number; durationMs: number };
  alert?: { code: string; message: string };
}

/** External touchpoints of the merged-item-reconciler chore. */
interface MergedItemReconcilerDeps {
  reconcileMergedItems?: () => Promise<ReconcilerRunResult>;
  /** Persist the last-run health snapshot (issue #2057). Injected for tests. */
  setReconcilerHealth?: (record: import("../redis/reconciler.ts").ReconcilerHealthRecord) => Promise<void>;
}

/**
 * Merge→done reconciler (issue #1715) — sweeps recently merged target PRs and
 * default-branch merge commits for `item-NNN` references and moves any
 * referenced item still in a non-done lane to `done` with audit stamps.
 * Fail-closed + idempotent, so no Redis time-guard is needed.
 *
 * Also runs the stale-claim escalation pass (issue #2031): items that are
 * unconfirmable-but-probably-shipped (far past a generous age, or claimed by a
 * retired claimant) are routed to `blocked` (operator-visible) — never silently
 * to `done` — so the claim path stops re-serving shipped/obsolete work.
 *
 * Observability (issue #2057): after every run it persists a structured
 * last-run health snapshot (feed liveness + batch metrics) so the
 * scheduler-status endpoint can surface reconciler liveness without re-running
 * the sweep. The persist is best-effort — a Redis write failure is logged but
 * never aborts the chore (the reconciler's own alert path already fired).
 */
async function runMergedItemReconciler(deps: MergedItemReconcilerDeps = {}): Promise<void> {
  const reconcileMergedItems =
    deps.reconcileMergedItems ?? (await import("../backlog/reconciler.ts")).reconcileMergedItems;
  const setHealth =
    deps.setReconcilerHealth ?? (await import("../redis/reconciler.ts")).setReconcilerHealth;
  const rec = await reconcileMergedItems();
  if (rec.reconciled.length > 0) {
    console.log(
      `[Housekeeping] Merge→done reconciler: closed ${rec.reconciled.length} item${rec.reconciled.length === 1 ? "" : "s"} (scanned ${rec.scanned}): ${rec.reconciled.map((r) => `${r.id}←${r.ref}`).join(", ")}`,
    );
  }
  const esc = rec.escalated ?? [];
  if (esc.length > 0) {
    console.log(
      `[Housekeeping] Stale-claim escalation: routed ${esc.length} unconfirmable item${esc.length === 1 ? "" : "s"} to blocked (operator-attention): ${esc.map((e) => e.id).join(", ")}`,
    );
  }

  // Issue #2057: log batch metrics every run (even an empty one) so a stalled
  // reconciler is diagnosable from the journal, and persist the health snapshot
  // for the status endpoint. Fail-soft on the Redis write.
  const feed = rec.feed ?? { prs: { examined: 0 }, commits: { examined: 0 } };
  const metrics = rec.metrics ?? { referencesFound: 0, movesFailed: 0, durationMs: 0 };
  console.log(
    `[Housekeeping] Merge→done reconciler metrics: prs=${feed.prs.examined}${feed.prs.failed ? "(failed)" : ""} commits=${feed.commits.examined}${feed.commits.failed ? "(failed)" : ""} refs=${metrics.referencesFound} movesFailed=${metrics.movesFailed} duration=${metrics.durationMs}ms${rec.alert ? ` ALERT=${rec.alert.code}` : ""}`,
  );
  try {
    await setHealth({
      ranAt: new Date().toISOString(),
      feed,
      metrics: {
        referencesFound: metrics.referencesFound,
        movesFailed: metrics.movesFailed,
        itemsReconciled: rec.reconciled.length,
        itemsEscalated: esc.length,
        scanned: rec.scanned,
        durationMs: metrics.durationMs,
      },
      ...(rec.alert ? { alert: rec.alert } : {}),
    });
  } catch (err: any) {
    console.error(`[Housekeeping] Merge→done reconciler health persist failed: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Forecast-calibration-brier leading-outcome producer (issue #1657)
// ---------------------------------------------------------------------------

/** External touchpoints of the forecast-calibration-brier chore. */
export interface ForecastCalibrationBrierDeps {
  publishBrierMetric?: () => Promise<{ ok: boolean }>;
}

/**
 * Forecast-calibration-brier leading-outcome producer (issue #1657) — samples
 * the target's aggregate Brier score and publishes it to
 * metrics/forecast-calibration-brier.txt for the outcomes file adapter. The
 * producer itself never throws and never writes on failure, so "ran" here means
 * "sampled", not necessarily "wrote". Hourly re-publish of the same current
 * value is idempotent, so no Redis time-guard is needed.
 */
export async function runForecastCalibrationBrier(
  deps: ForecastCalibrationBrierDeps = {},
): Promise<void> {
  const publishBrier =
    deps.publishBrierMetric ?? (await import("../metrics/publish.ts")).publishForecastCalibrationBrierMetric;
  await publishBrier();
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

/** External touchpoints of the stale-Redis-key sweep chore. */
export interface PruneStaleRedisKeysDeps {
  pruneMetricsIndex?: typeof pruneMetricsIndex;
  getMetricsIndexSize?: typeof getMetricsIndexSize;
  trimMetricsIndex?: typeof trimMetricsIndex;
  scanKeys?: typeof scanKeys;
  getKeyTTL?: typeof getKeyTTL;
  getKeyType?: typeof getKeyType;
  hashGet?: typeof hashGet;
  deleteKeysBatch?: typeof deleteKeysBatch;
  now?: () => number;
}

/**
 * Prune stale cycle/task/metrics Redis keys older than 7 days with no TTL.
 * The same body that ran on the cleanup.ts timer; deps are injectable so it is
 * exercisable without standing up real Redis.
 */
export async function pruneStaleRedisKeys(deps: PruneStaleRedisKeysDeps = {}): Promise<void> {
  const pruneMetricsIndexFn = deps.pruneMetricsIndex ?? pruneMetricsIndex;
  const getMetricsIndexSizeFn = deps.getMetricsIndexSize ?? getMetricsIndexSize;
  const trimMetricsIndexFn = deps.trimMetricsIndex ?? trimMetricsIndex;
  const scanKeysFn = deps.scanKeys ?? scanKeys;
  const getKeyTTLFn = deps.getKeyTTL ?? getKeyTTL;
  const getKeyTypeFn = deps.getKeyType ?? getKeyType;
  const hashGetFn = deps.hashGet ?? hashGet;
  const deleteKeysBatchFn = deps.deleteKeysBatch ?? deleteKeysBatch;
  const nowFn = deps.now ?? Date.now;

  const cutoffMs = nowFn() - STALE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let totalPruned = 0;

  // Prune old metrics from sorted index, then delete orphaned metric keys
  try {
    const removed = await pruneMetricsIndexFn(cutoffMs);
    if (removed > 0) {
      totalPruned += removed;
      console.log(`[Housekeeping] Pruned ${removed} old metrics index entries`);
    }
    // Trim to max entries as a safety cap
    const indexSize = await getMetricsIndexSizeFn();
    if (indexSize > METRICS_INDEX_MAX_ENTRIES) {
      const excess = indexSize - METRICS_INDEX_MAX_ENTRIES;
      await trimMetricsIndexFn(excess);
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
      const keys = await scanKeysFn(`${prefix}*`);
      const toDelete: string[] = [];

      for (const key of keys) {
        // Skip index/counter keys and active/last pointers
        if (key.endsWith(":index") || key.endsWith(":counter") || key === CYCLE_ACTIVE_KEY || key === CYCLE_LAST_KEY) continue;
        const ttl = await getKeyTTLFn(key);
        if (ttl !== -1) continue; // Already has TTL, skip

        let keyTime: number | null = null;

        // Try hash timestamp fields first (original logic)
        const type = await getKeyTypeFn(key);
        if (type === "hash") {
          const ts = await hashGetFn(key, "startedAt") || await hashGetFn(key, "createdAt") || await hashGetFn(key, "timestamp");
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
        await deleteKeysBatchFn(toDelete);
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

/** External touchpoints of the stale-inProgress return chore. */
export interface ReturnStaleInProgressItemsDeps {
  getBacklogLaneWithScores?: typeof getBacklogLaneWithScores;
  getBacklogItem?: typeof getBacklogItem;
  moveBacklogItem?: typeof moveBacklogItem;
  now?: () => number;
}

/**
 * Return backlog items stuck in the `inProgress` lane for > 24h back to
 * `queued`. The same body that ran on the cleanup.ts timer. Naturally
 * idempotent: each invocation re-checks item age.
 */
export async function returnStaleInProgressItems(
  deps: ReturnStaleInProgressItemsDeps = {},
): Promise<void> {
  const getBacklogLaneWithScoresFn = deps.getBacklogLaneWithScores ?? getBacklogLaneWithScores;
  const getBacklogItemFn = deps.getBacklogItem ?? getBacklogItem;
  const moveBacklogItemFn = deps.moveBacklogItem ?? moveBacklogItem;
  const nowFn = deps.now ?? Date.now;
  try {
    const ids = await getBacklogLaneWithScoresFn("inProgress");
    const now = nowFn();
    let returned = 0;

    // ids is [id1, score1, id2, score2, ...]
    for (let i = 0; i < ids.length; i += 2) {
      const id = ids[i];
      const score = Number(ids[i + 1]);
      if (now - score > STALE_IN_PROGRESS_MS) {
        const raw = await getBacklogItemFn(id);
        if (!raw) continue;
        const item = JSON.parse(raw);
        item.lane = "queued";
        item.meta = { ...item.meta, returnedReason: "stale_in_progress", returnedAt: new Date().toISOString() };
        await moveBacklogItemFn(id, JSON.stringify(item), "inProgress", "queued");
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
// Lane-index reconciler (issue #2056)
// ---------------------------------------------------------------------------

/** External touchpoints of the lane-index-reconcile chore. */
interface LaneIndexReconcileDeps {
  reconcileLaneIndices?: () => Promise<unknown>;
}

/**
 * Lane-index reconciler (issue #2056) — repairs the lane sorted-set indices
 * FROM the canonical items hash. Self-heals the #1990 restart desync. No Redis
 * time-guard: it is intrinsically idempotent (a healthy board is a guaranteed
 * no-op).
 */
async function runLaneIndexReconcile(deps: LaneIndexReconcileDeps = {}): Promise<void> {
  const reconcileLaneIndices =
    deps.reconcileLaneIndices ?? (await import("../backlog/index-reconciler.ts")).reconcileLaneIndices;
  await reconcileLaneIndices();
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
 * Issue #1864: the bespoke try/catch blocks were collapsed to `Chore`
 * declarations driven by `runChore`, so the guard → work → bookkeeping →
 * error-log + Sentry-breadcrumb pattern lives in exactly one place.
 *
 * Issue #2067: each chore's *work* is now a named exported function accepting
 * only its own deps subset (see the `run*` exports above). `runHousekeeping`
 * stays the composition owner — it sequences the chores in the same order,
 * applies the same Redis time-guards (still read here at the composition
 * level), and wraps each through `runChore`. Behaviour is unchanged; the chore
 * bodies are now independently injectable + unit-testable without standing up a
 * deps object covering all of them.
 *
 * Returns a `{ ran, skipped }` summary so callers (the endpoint, tests) can
 * see which chores did work this invocation vs. which were skipped by their
 * time-guard. Never throws — each chore is independently run through
 * `runChore`, which try/catches so one failure doesn't abort the rest.
 */
async function runHousekeeping(
  eventBus: PublishableBus,
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

  // The chores as declarations. Each carries an optional `guard` (the cadence
  // window, read at the composition level) and a `work` thunk that delegates to
  // the chore's named exported runner. `runChore` applies the uniform guard →
  // work → bookkeeping → error-log + Sentry-breadcrumb pattern. Order is
  // preserved verbatim from the pre-#2067 sequence.
  const chores: Chore[] = [
    {
      name: "blocked-escalation",
      work: () => runBlockedItemEscalation(eventBus),
    },

    {
      name: "review-pickup-notify",
      work: async () => {
        await runReviewPickupNotify(eventBus);
      },
    },

    {
      name: "prune-done",
      work: () => runDoneLanePrune(),
    },

    {
      name: "weekly-summary",
      guard: async () => {
        const lastWeekly = await getDigestLastWeekly();
        return !lastWeekly || Date.now() - parseInt(lastWeekly) >= WEEK_MS;
      },
      work: () => runWeeklyDigest(),
    },

    {
      name: "memory-consolidation",
      guard: async () => {
        const lastConsolidation = await getMemoryLastConsolidation();
        return !lastConsolidation || Date.now() - parseInt(lastConsolidation) >= DAY_MS;
      },
      work: () => runMemoryConsolidation(),
    },

    {
      name: "design-concept-snapshot",
      work: () => runDesignConceptSnapshot(),
    },

    {
      name: "work-queue-hygiene",
      work: () => runWorkQueueHygiene(),
    },

    {
      name: "merged-item-reconciler",
      work: () => runMergedItemReconciler(),
    },

    {
      name: "forecast-calibration-brier",
      work: () => runForecastCalibrationBrier({ publishBrierMetric: deps.publishBrierMetric }),
    },

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

    {
      name: "stale-inprogress-return",
      work: () => returnStaleInProgressItems(),
    },

    {
      name: "lane-index-reconcile",
      work: () => runLaneIndexReconcile(),
    },
  ];

  for (const chore of chores) {
    await runChore(chore, ran, skipped);
  }

  return { ran, skipped };
}

export {
  runHousekeeping,
  // Issue #1864: the extracted guarded-chore runner, exported so a unit test
  // can inject a failing / guard-skipping / work-skipping chore thunk and
  // assert the uniform guard → work → bookkeeping → error-log + Sentry
  // pattern without standing up the maintenance endpoint or Redis.
  runChore,
  // Issue #2057: exported so a unit test can inject the reconciler result + a
  // fake `setReconcilerHealth` and assert the last-run health snapshot is
  // persisted (feed liveness + batch metrics) without standing up Redis.
  runMergedItemReconciler,
};
