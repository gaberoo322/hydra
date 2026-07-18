/**
 * Outcome-attribution recorder — live merge-landing subscription (issue #2632,
 * epic #2628). The slice that turns the callable #2629 recorder into an
 * AUTONOMOUS producer of ledger rows.
 *
 * ## Why a Housekeeping chore, not an EventBus consumer
 *
 * The issue asks to "subscribe the recorder to the hydra:* merge event stream."
 * The central DESIGN DECISION (design-concept issue-2632) is to satisfy that by
 * reacting to merge LANDINGS at the Housekeeping cadence — NOT with a long-lived
 * `EventBus.consume()` loop or a `setInterval`. A long-lived in-process recorder
 * is exactly the orphaned-recorder failure mode ADR-0010 retired (the stuckness
 * detector reported all-zero state after ADR-0006 orphaned it) and violates
 * ADR-0012 (the Scheduler makes no policy decisions; the autopilot is the single
 * brain). The shipped precedent for "a merge landed → do the merge-coupled
 * follow-up" is the `holdback-merge-watch` chore (#2623), which drains the
 * pending-enroll registry (`hydra:holdback:pending-enroll`) rather than
 * subscribing to a raw stream. This recorder reacts off the SAME merge-landing
 * substrate.
 *
 * ## Coordinator + phase leafs (issue #3001)
 *
 * This module is the thin coordinator: it resolves the injectable deps, seeds
 * the shared {@link AttributionRecordResult} accumulator, and sequences the three
 * structurally-independent phases — each of which lives in its own focused leaf
 * so a bug fix or a new phase navigates to the concept name, not 587 lines of
 * mixed phase code:
 *
 *   1. OPEN  — {@link openWindowsForLandedMerges} in `phase-open.ts`: for every
 *      pending-enroll PR whose merge has LANDED and that has not already been
 *      window-opened, snapshot the leading outcomes as the per-metric BASELINE
 *      and open one {@link AttributionWindow} per live metric. Persisted in Redis
 *      so an open window survives a restart. Landed-but-window-opened PRs are
 *      left for `holdback-merge-watch` to drop from the pending registry.
 *
 *   2. CLOSE — {@link closeDueWindows} in `phase-close.ts`: for every OPEN window
 *      whose `closesAt` has elapsed, re-sample the leading outcomes and append
 *      ONE observation row via the #2629 recorder (`recordWindow`), then remove
 *      the window. Each metric closes on its own duration.
 *
 *   3. VOID  — {@link voidRevertedMerges} in `phase-void.ts`: drain the
 *      reverted-merge registry (`hydra:attribution:reverted`, written by Outcome
 *      Holdback when it reverts a merge): for each entry, APPEND a compensating
 *      void tombstone naming the reverted PR/commit (the append-only ledger
 *      forbids delete, so a void is an append the #2630 estimator honors by
 *      excluding the matching rows), then remove the entry.
 *
 * ## Invariants (design-concept issue-2632)
 *
 *   - OBSERVE-ONLY: the recorder dispatches nothing and reverts nothing —
 *     Outcome Holdback remains the sole revert authority.
 *   - Dark metric (null baseline OR null current) ⇒ NO row (never a synthetic
 *     zero); empty (zero-merge) windows still record a null-model row. These are
 *     carried by the #2629 `recordWindow` this chore delegates to.
 *   - Append-only ledger: a void is an APPEND, never a delete/trim.
 *   - FAIL LOUD: every failure logs `console.error` with an `[attribution]`
 *     context prefix; the chore never throws (returns a structured summary).
 *
 * Every external touchpoint is injectable so the whole pass is unit-testable
 * without gh or a live Redis.
 */

import {
  snapshotLeadingOutcomes,
  type LeadingOutcomeSample,
} from "../outcome-regression.ts";
import { loadOutcomes, DEFAULT_OUTCOMES_FILE } from "../outcomes.ts";
import {
  redisAttributionLedger,
  type AttributionLedger,
} from "../redis/attribution-ledger.ts";
import {
  openWindow,
  listOpenWindows,
  closeWindow,
} from "../redis/attribution-windows.ts";
import {
  listRevertedMerges,
  removeRevertedMerge,
} from "../redis/attribution-reverted.ts";
import {
  pendingEnrollList,
} from "../redis/holdback-merge-watch.ts";
import { type MergeStatus } from "./windows.ts";
import { openWindowsForLandedMerges, fetchMergeStatusViaGh } from "./phase-open.ts";
import { closeDueWindows } from "./phase-close.ts";
import { voidRevertedMerges } from "./phase-void.ts";

// Re-exported so existing importers of the coordinator's `MergeStatus` (and the
// injectable `fetchMergeStatus` dep signature) keep the same public surface —
// the type now lives with the pure OPEN predicate in windows.ts.
export type { MergeStatus };

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** External touchpoints of the recorder chore (all injectable for tests). */
export interface AttributionRecordDeps {
  /** The append-only ledger seam. Defaults to `redisAttributionLedger`. */
  ledger?: AttributionLedger;
  /** List armed-but-not-landed pending entries. Defaults to `pendingEnrollList`. */
  listPending?: typeof pendingEnrollList;
  /** Fetch a PR's merge-landing status. Defaults to a `gh pr view` call. */
  fetchMergeStatus?: (prNumber: number) => Promise<MergeStatus | null>;
  /** Snapshot the leading outcomes. Defaults to `snapshotLeadingOutcomes`. */
  snapshot?: (filePath?: string) => Promise<LeadingOutcomeSample[]>;
  /** Load the outcomes config (for per-metric window durations). */
  loadOutcomesFn?: typeof loadOutcomes;
  /** Persist an opened window. Defaults to `openWindow`. */
  openWindowFn?: typeof openWindow;
  /** List open windows. Defaults to `listOpenWindows`. */
  listWindowsFn?: typeof listOpenWindows;
  /** Remove a closed window. Defaults to `closeWindow`. */
  closeWindowFn?: typeof closeWindow;
  /** List pending reverted merges. Defaults to `listRevertedMerges`. */
  listRevertedFn?: typeof listRevertedMerges;
  /** Remove a drained reverted-merge entry. Defaults to `removeRevertedMerge`. */
  removeRevertedFn?: typeof removeRevertedMerge;
  /** Test seam — explicit outcomes.yaml path. */
  outcomesFile?: string;
  /** Test seam — override "now" (epoch ms). Defaults to `Date.now()`. */
  nowMs?: number;
}

/** Per-run summary the chore returns (never throws). */
export interface AttributionRecordResult {
  /** Windows opened this run (across all newly-landed PRs). */
  windowsOpened: number;
  /** Windows closed (observation rows appended) this run. */
  windowsClosed: number;
  /** Observation rows appended this run (dark metrics excluded). */
  rowsAppended: number;
  /** Void tombstones appended this run (reverted merges). */
  voidsAppended: number;
  /** Non-fatal failures logged this run (each also console.error'd). */
  errors: number;
}

// ---------------------------------------------------------------------------
// Chore runner
// ---------------------------------------------------------------------------

/**
 * Run one attribution-record pass: open windows for newly-landed merges, close
 * due windows (appending observations), and void reverted merges. Returns a
 * summary; never throws (fail-loud: every failure is `console.error`'d with the
 * `[attribution]` prefix and counted in `result.errors`).
 *
 * The three phases are assembled here from the resolved deps as named per-phase
 * slices (the `*Ctx` shapes live with their phase leafs), so adding a field to a
 * phase context surfaces a compile error at exactly this assembly point.
 */
export async function runAttributionRecord(
  deps: AttributionRecordDeps = {},
): Promise<AttributionRecordResult> {
  const ledger = deps.ledger ?? redisAttributionLedger;
  const listPending = deps.listPending ?? pendingEnrollList;
  const fetchMergeStatus = deps.fetchMergeStatus ?? fetchMergeStatusViaGh;
  const snapshot = deps.snapshot ?? snapshotLeadingOutcomes;
  const loadOutcomesFn = deps.loadOutcomesFn ?? loadOutcomes;
  const openWindowFn = deps.openWindowFn ?? openWindow;
  const listWindowsFn = deps.listWindowsFn ?? listOpenWindows;
  const closeWindowFn = deps.closeWindowFn ?? closeWindow;
  const listRevertedFn = deps.listRevertedFn ?? listRevertedMerges;
  const removeRevertedFn = deps.removeRevertedFn ?? removeRevertedMerge;
  const outcomesFile = deps.outcomesFile ?? DEFAULT_OUTCOMES_FILE;
  const nowMs = deps.nowMs ?? Date.now();

  const result: AttributionRecordResult = {
    windowsOpened: 0,
    windowsClosed: 0,
    rowsAppended: 0,
    voidsAppended: 0,
    errors: 0,
  };

  await openWindowsForLandedMerges({
    listPending,
    fetchMergeStatus,
    snapshot,
    loadOutcomesFn,
    openWindowFn,
    listWindowsFn,
    outcomesFile,
    nowMs,
    result,
  });

  await closeDueWindows({
    ledger,
    snapshot,
    listWindowsFn,
    closeWindowFn,
    outcomesFile,
    nowMs,
    result,
  });

  await voidRevertedMerges({
    ledger,
    listRevertedFn,
    removeRevertedFn,
    nowMs,
    result,
  });

  if (result.windowsOpened > 0 || result.windowsClosed > 0 || result.voidsAppended > 0) {
    console.log(
      `[attribution] record: opened=${result.windowsOpened} closed=${result.windowsClosed} rows=${result.rowsAppended} voids=${result.voidsAppended} errors=${result.errors}`,
    );
  }

  return result;
}
