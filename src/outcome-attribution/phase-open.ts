/**
 * Outcome-attribution OPEN phase (issue #3001, epic #2628). Extracted from the
 * former monolithic `subscribe.ts` chore coordinator as a focused single-concept
 * leaf.
 *
 * ## What this phase does
 *
 * OPEN — for every pending-enroll PR whose merge has LANDED and that has not
 * already been window-opened, snapshot the leading outcomes as the per-metric
 * BASELINE and open one {@link AttributionWindow} per live metric (each with its
 * own configured `closesAt`). Persisted in Redis so an open window survives a
 * restart. Landed-but-window-opened PRs are left for `holdback-merge-watch` to
 * drop from the pending registry (this phase never removes pending entries —
 * that is the merge-watch's job).
 *
 * The default merge-status fetch (`gh pr view <n> --json state,mergeCommit`) is
 * the I/O + fail-loud concern; it lives here next to the phase that consumes it.
 * The pure landed-AND-not-opened decision stays in `windows.ts`
 * (`selectMergesToOpen`), which this phase drives.
 */

import {
  snapshotLeadingOutcomes,
  type LeadingOutcomeSample,
} from "../outcome-regression.ts";
import { loadOutcomes } from "../outcomes.ts";
import {
  openWindow,
  listOpenWindows,
} from "../redis/attribution-windows.ts";
import {
  pendingEnrollList,
  type PendingEnrollEntry,
} from "../redis/holdback-merge-watch.ts";
import { viewPr } from "../github/issues.ts";
import {
  buildWindowsForMerge,
  selectMergesToOpen,
  type MergeWindowContext,
  type MergeStatus,
} from "./windows.ts";
import { producerClassFromCycleId } from "../taxonomy/classes.ts";
import type { AttributionRecordResult } from "./subscribe.ts";

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
export async function fetchMergeStatusViaGh(prNumber: number): Promise<MergeStatus | null> {
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
type OpenOneMergeCtx = Pick<
  OpenWindowsCtx,
  "snapshot" | "openWindowFn" | "outcomesFile" | "nowMs" | "result"
>;

export async function openWindowsForLandedMerges(ctx: OpenWindowsCtx): Promise<void> {
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
  // it stays in this phase; the map it builds feeds the PURE OPEN predicate
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
