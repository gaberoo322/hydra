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
 * ## What one pass does
 *
 * {@link runAttributionRecord} is the chore runner (registered in
 * `src/scheduler/housekeeping.ts`). Each pass:
 *
 *   1. OPEN — for every pending-enroll PR whose merge has LANDED and that has
 *      not already been window-opened, snapshot the leading outcomes as the
 *      per-metric BASELINE and open one {@link AttributionWindow} per live
 *      metric (each with its own configured `closesAt`). Persisted in Redis so
 *      an open window survives a restart. Landed-but-window-opened PRs are left
 *      for `holdback-merge-watch` to drop from the pending registry (this chore
 *      never removes pending entries — that is the merge-watch's job).
 *
 *   2. CLOSE — for every OPEN window whose `closesAt` has elapsed, re-sample the
 *      leading outcomes and append ONE observation row via the #2629 recorder
 *      (`recordWindow`), then remove the window. Each metric closes on its own
 *      duration (fast metric ≠ slow metric).
 *
 *   3. VOID — drain the reverted-merge registry (`hydra:attribution:reverted`,
 *      written by Outcome Holdback when it reverts a merge): for each entry,
 *      APPEND a compensating void tombstone naming the reverted PR/commit (the
 *      append-only ledger forbids delete, so a void is an append the #2630
 *      estimator honors by excluding the matching rows), then remove the entry.
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
  recordWindow,
  type WindowContext,
} from "./recorder.ts";
import {
  redisAttributionLedger,
  openWindow,
  listOpenWindows,
  closeWindow,
  listRevertedMerges,
  removeRevertedMerge,
  type AttributionLedger,
  type AttributionWindow,
  type VoidMarker,
  type RevertedMerge,
} from "../redis/attribution.ts";
import {
  pendingEnrollList,
  type PendingEnrollEntry,
} from "../redis/holdback.ts";
import { viewPr } from "../github/issues.ts";
import {
  buildWindowsForMerge,
  dueWindows,
  selectMergesToOpen,
  type MergeWindowContext,
  type MergeStatus,
} from "./windows.ts";

// Re-exported so existing importers of the coordinator's `MergeStatus` (and the
// injectable `fetchMergeStatus` dep signature) keep the same public surface —
// the type now lives with the pure OPEN predicate in windows.ts.
export type { MergeStatus };

// ---------------------------------------------------------------------------
// Producer-class derivation (PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the producer class from a dispatch `cycleId`. Autopilot cycle ids end
 * with the signal class token (e.g. `worktree-agent-<uuid>-t8-dev_orch` →
 * `dev_orch`). We take the trailing `_orch` / `_target` token; anything we can't
 * parse maps to `"unknown"` so a merge is still counted (never dropped). PURE.
 *
 * `classCounts` stays RAW — one merge contributes one count to its class; there
 * is NO write-time credit split (the epic assigns credit later via regression).
 */
export function producerClassFromCycleId(cycleId: string | null | undefined): string {
  if (!cycleId) return "unknown";
  const m = cycleId.match(/([a-z0-9]+_(?:orch|target))\s*$/i);
  return m ? m[1].toLowerCase() : "unknown";
}

// ---------------------------------------------------------------------------
// Merge-landing status (mirrors holdback-merge-watch's fetch)
// ---------------------------------------------------------------------------

interface RawPrView {
  state?: string | null;
  mergeCommit?: { oid?: string | null } | null;
}

/**
 * Default merge-status fetch — `gh pr view <n> --json state,mergeCommit` over
 * the GraphQL transport (mergeCommit is not on the REST inline-field map, same
 * as holdback-merge-watch). Runs only over the small pending set at the
 * housekeeping cadence. `viewPr` returns null on any failure and never throws.
 */
async function fetchMergeStatusViaGh(prNumber: number): Promise<MergeStatus | null> {
  const view = await viewPr<RawPrView>(prNumber, "state,mergeCommit", {
    transport: "graphql",
  });
  if (view == null) return null;
  const oid = view.mergeCommit?.oid;
  return {
    state: typeof view.state === "string" ? view.state : null,
    mergeCommitSha: typeof oid === "string" && oid.length > 0 ? oid : null,
  };
}

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
// Phase-context contracts (named seams — issue #2845)
// ---------------------------------------------------------------------------
//
// Each of the three phase functions accepts a NAMED slice of the resolved
// `AttributionRecordDeps` plus the shared `result` accumulator, rather than an
// anonymous inline struct. `runAttributionRecord` is the single place these are
// assembled from the resolved deps, so adding a field to a phase context surfaces
// a compile error at that assembly point. The per-item helper contexts are
// derived (`Pick`) from their phase context so their field lists are never
// re-spelled. These are exported so the test suite can construct a phase context
// directly (the minimum fields for that phase) without building a full
// `AttributionRecordDeps`; the phase functions themselves stay private.

/** Context for the OPEN phase ({@link openWindowsForLandedMerges}). */
export interface OpenWindowsCtx {
  listPending: typeof pendingEnrollList;
  fetchMergeStatus: (prNumber: number) => Promise<MergeStatus | null>;
  snapshot: (filePath?: string) => Promise<LeadingOutcomeSample[]>;
  loadOutcomesFn: typeof loadOutcomes;
  openWindowFn: typeof openWindow;
  listWindowsFn: typeof listOpenWindows;
  outcomesFile: string;
  nowMs: number;
  result: AttributionRecordResult;
}

/** Per-merge slice of {@link OpenWindowsCtx} used by {@link openWindowsForOneMerge}. */
export type OpenOneMergeCtx = Pick<
  OpenWindowsCtx,
  "snapshot" | "openWindowFn" | "outcomesFile" | "nowMs" | "result"
>;

/** Context for the CLOSE phase ({@link closeDueWindows}). */
export interface CloseWindowsCtx {
  ledger: AttributionLedger;
  snapshot: (filePath?: string) => Promise<LeadingOutcomeSample[]>;
  listWindowsFn: typeof listOpenWindows;
  closeWindowFn: typeof closeWindow;
  outcomesFile: string;
  nowMs: number;
  result: AttributionRecordResult;
}

/** Per-window slice of {@link CloseWindowsCtx} used by {@link closeOneWindow}. */
export type CloseOneWindowCtx = Pick<
  CloseWindowsCtx,
  "ledger" | "closeWindowFn" | "nowMs" | "result"
>;

/** Context for the VOID phase ({@link voidRevertedMerges}). */
export interface VoidRevertsCtx {
  ledger: AttributionLedger;
  listRevertedFn: typeof listRevertedMerges;
  removeRevertedFn: typeof removeRevertedMerge;
  nowMs: number;
  result: AttributionRecordResult;
}

/** Per-revert slice of {@link VoidRevertsCtx} used by {@link voidOneRevert}. */
export type VoidOneRevertCtx = Pick<
  VoidRevertsCtx,
  "ledger" | "removeRevertedFn" | "nowMs" | "result"
>;

// ---------------------------------------------------------------------------
// Chore runner
// ---------------------------------------------------------------------------

/**
 * Run one attribution-record pass: open windows for newly-landed merges, close
 * due windows (appending observations), and void reverted merges. Returns a
 * summary; never throws (fail-loud: every failure is `console.error`'d with the
 * `[attribution]` prefix and counted in `result.errors`).
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

// ---------------------------------------------------------------------------
// Phase 1: open windows for newly-landed merges
// ---------------------------------------------------------------------------

async function openWindowsForLandedMerges(ctx: OpenWindowsCtx): Promise<void> {
  const listed = await ctx.listPending();
  if (listed.ok === false) {
    console.error(`[attribution] record: pendingEnrollList failed: ${listed.error}`);
    ctx.result.errors += 1;
    return;
  }
  if (listed.entries.length === 0) return;

  // Read which merges already have windows open so we don't re-open (and don't
  // re-snapshot a fresh baseline over an in-flight window). A failed read fails
  // loud and skips the open phase (close/void still run).
  const openListed = await ctx.listWindowsFn();
  if (openListed.ok === false) {
    console.error(`[attribution] record: listOpenWindows failed (open phase): ${openListed.error}`);
    ctx.result.errors += 1;
    return;
  }
  const commitsWithWindows = new Set<string>();
  for (const w of openListed.windows) {
    if (w.sourceCommitSha) commitsWithWindows.add(w.sourceCommitSha);
  }

  // Per-metric window-duration map from outcomes.yaml (optional field). A load
  // failure logs and falls back to an empty map ⇒ every metric uses the default.
  const metricWindowMs = await loadMetricWindowMs(ctx.loadOutcomesFn, ctx.outcomesFile, ctx.result);

  // Fetch each pending PR's merge status. This is the I/O + fail-loud concern
  // (a null return logs with the [attribution] prefix and counts an error), so
  // it stays in the coordinator; the map it builds feeds the PURE OPEN predicate
  // (`selectMergesToOpen` in windows.ts), which owns the landed-AND-not-opened
  // decision and is unit-tested without a gh/Redis fixture.
  const statusByPr = new Map<number, MergeStatus>();
  for (const entry of listed.entries) {
    const status = await ctx.fetchMergeStatus(entry.prNumber);
    if (status == null) {
      console.error(
        `[attribution] record: mergeStatus fetch failed for pr ${entry.prNumber}; retrying next tick`,
      );
      ctx.result.errors += 1;
      continue;
    }
    statusByPr.set(entry.prNumber, status);
  }

  for (const { entry, mergeCommitSha } of selectMergesToOpen(
    listed.entries,
    statusByPr,
    commitsWithWindows,
  )) {
    await openWindowsForOneMerge(entry, mergeCommitSha, metricWindowMs, ctx);
  }
}

async function openWindowsForOneMerge(
  entry: PendingEnrollEntry,
  mergeCommitSha: string,
  metricWindowMs: Map<string, number | undefined>,
  ctx: OpenOneMergeCtx,
): Promise<void> {
  let leading: LeadingOutcomeSample[];
  try {
    leading = await ctx.snapshot(ctx.outcomesFile);
  } catch (err: any) {
    console.error(
      `[attribution] record: snapshot (baseline) threw for pr ${entry.prNumber}: ${err?.message || String(err)}`,
    );
    ctx.result.errors += 1;
    return;
  }
  if (leading.length === 0) return; // no leading outcomes declared — nothing to watch

  const mergeCtx: MergeWindowContext = {
    sourcePrNumbers: [entry.prNumber],
    sourceCommitSha: mergeCommitSha,
    classCounts: { [producerClassFromCycleId(entry.cycleId)]: 1 },
    scopeTouched: "orch",
    tier: entry.tier,
  };

  const windows = buildWindowsForMerge(leading, metricWindowMs, mergeCtx, ctx.nowMs);
  for (const window of windows) {
    const res = await ctx.openWindowFn(window);
    if (res.ok === false) {
      console.error(`[attribution] record: openWindow failed for ${window.id}: ${res.error}`);
      ctx.result.errors += 1;
      continue;
    }
    ctx.result.windowsOpened += 1;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: close due windows → append observations
// ---------------------------------------------------------------------------

async function closeDueWindows(ctx: CloseWindowsCtx): Promise<void> {
  const openListed = await ctx.listWindowsFn();
  if (openListed.ok === false) {
    console.error(`[attribution] record: listOpenWindows failed (close phase): ${openListed.error}`);
    ctx.result.errors += 1;
    return;
  }

  const { due } = dueWindows(openListed.windows, ctx.nowMs);
  if (due.length === 0) return;

  // Re-sample once for this pass — all due windows close against the same
  // current snapshot (each compares to its OWN persisted baseline).
  let current: LeadingOutcomeSample[];
  try {
    current = await ctx.snapshot(ctx.outcomesFile);
  } catch (err: any) {
    console.error(
      `[attribution] record: snapshot (current) threw during close: ${err?.message || String(err)}`,
    );
    ctx.result.errors += 1;
    return;
  }
  const currentByName = new Map(current.map((c) => [c.name, c.value]));

  for (const window of due) {
    await closeOneWindow(window, currentByName, ctx);
  }
}

async function closeOneWindow(
  window: AttributionWindow,
  currentByName: Map<string, number | null>,
  ctx: CloseOneWindowCtx,
): Promise<void> {
  const curValue = currentByName.has(window.metric)
    ? currentByName.get(window.metric)!
    : null;

  // Reuse the #2629 recorder policy: it derives the raw row (dark-metric skip,
  // raw delta, no write-time split). We pass a single-metric baseline/current
  // pair so recordWindow handles exactly this window's metric. Attach the
  // merge-identity so a later revert can void this row.
  const baselineSample: LeadingOutcomeSample = {
    name: window.metric,
    // direction/noiseEpsilon are unused by recordWindow (it derives a raw delta,
    // not a regression decision) — carry safe defaults.
    direction: "up",
    noiseEpsilon: 0,
    value: window.baselineValue,
  };
  const winCtx: WindowContext = {
    classCounts: window.classCounts,
    scopeTouched: window.scopeTouched,
    tier: window.tier,
  };

  const rec = await recordWindow(
    ledgerWithIdentity(ctx.ledger, window),
    [baselineSample],
    [{ name: window.metric, value: curValue }],
    winCtx,
    ctx.nowMs,
  );

  if (rec.errors.length > 0) {
    for (const e of rec.errors) console.error(`[attribution] record: append failed for ${window.id}: ${e}`);
    ctx.result.errors += rec.errors.length;
    // Leave the window open so a later tick retries the append (idempotency is
    // by merge-identity at the estimator; a rare double-append is tolerable and
    // preferable to silently losing the row).
    return;
  }

  ctx.result.rowsAppended += rec.appended.length;
  ctx.result.windowsClosed += 1;
  await ctx.closeWindowFn(window.id);
}

/**
 * Wrap a ledger so each observation it appends carries this window's
 * merge-identity (`sourcePrNumbers`/`sourceCommitSha`). Keeps the #2629
 * `recordWindow` signature untouched — it appends whatever `WindowContext`
 * produces, and this wrapper enriches the row on the way through.
 */
function ledgerWithIdentity(ledger: AttributionLedger, window: AttributionWindow): AttributionLedger {
  return {
    getObservations: ledger.getObservations.bind(ledger),
    appendVoidMarker: ledger.appendVoidMarker.bind(ledger),
    appendObservation: (obs) =>
      ledger.appendObservation({
        ...obs,
        sourcePrNumbers: [...window.sourcePrNumbers],
        sourceCommitSha: window.sourceCommitSha,
      }),
  };
}

// ---------------------------------------------------------------------------
// Phase 3: void reverted merges
// ---------------------------------------------------------------------------

async function voidRevertedMerges(ctx: VoidRevertsCtx): Promise<void> {
  const listed = await ctx.listRevertedFn();
  if (listed.ok === false) {
    console.error(`[attribution] record: listRevertedMerges failed: ${listed.error}`);
    ctx.result.errors += 1;
    return;
  }
  if (listed.reverts.length === 0) return;

  for (const revert of listed.reverts) {
    await voidOneRevert(revert, ctx);
  }
}

async function voidOneRevert(
  revert: RevertedMerge,
  ctx: VoidOneRevertCtx,
): Promise<void> {
  const marker: VoidMarker = {
    kind: "void",
    voidedPrNumber: revert.prNumber,
    voidedCommitSha: revert.commitSha,
    reason: "holdback-revert",
    recordedAt: ctx.nowMs,
  };
  const res = await ctx.ledger.appendVoidMarker(marker);
  if (res.ok === false) {
    console.error(
      `[attribution] record: appendVoidMarker failed for pr=${revert.prNumber} sha=${revert.commitSha}: ${res.error}`,
    );
    ctx.result.errors += 1;
    return; // leave the entry to retry next tick
  }
  ctx.result.voidsAppended += 1;
  await ctx.removeRevertedFn({ commitSha: revert.commitSha, prNumber: revert.prNumber });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the metric → optional `attribution_window_ms` map from outcomes.yaml.
 * Only `kind: leading` outcomes are windowed. A load failure logs and returns an
 * empty map (⇒ every metric uses the default duration) so a bad config never
 * blocks recording.
 */
async function loadMetricWindowMs(
  loadOutcomesFn: typeof loadOutcomes,
  outcomesFile: string,
  result: AttributionRecordResult,
): Promise<Map<string, number | undefined>> {
  const map = new Map<string, number | undefined>();
  const loaded = await loadOutcomesFn(outcomesFile);
  if (loaded.ok === false) {
    console.error(`[attribution] record: loadOutcomes failed: ${loaded.errors.join("; ")}`);
    result.errors += 1;
    return map;
  }
  for (const o of loaded.outcomes) {
    if (o.kind === "leading") map.set(o.name, o.attribution_window_ms);
  }
  return map;
}
