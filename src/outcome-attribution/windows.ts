/**
 * Per-metric attribution WINDOW state machine (issue #2632, epic #2628).
 *
 * The outcome-attribution recorder ({@link ../subscribe.ts}) turns a landed
 * merge into ledger rows by way of per-metric WINDOWS: when a merge lands it
 * OPENS one window per live leading metric (each snapshotting that metric's
 * baseline value at open time), and when a window's own configured duration
 * elapses it CLOSES — re-samples the metric and appends one observation row.
 *
 * This module owns the WINDOW POLICY, deliberately split out from the chore so
 * it is unit-testable in isolation:
 *   - {@link windowDurationMs} — the metric → duration mapping. A metric's
 *     `attribution_window_ms` (optional outcomes.yaml field, #2632) wins;
 *     otherwise a conservative long DEFAULT so an unconfigured metric still
 *     closes eventually. This is keyed on how fast the METRIC moves — a fast
 *     metric (test-count) settles in minutes, a slow one (Brier) needs days —
 *     which is why it is NOT derived from the per-MERGE tier windows
 *     (`windowCyclesForTier`), which are keyed on blast radius.
 *   - {@link buildWindowsForMerge} — PURE: given the live leading metrics + a
 *     landed merge's identity/scope/tier/classCounts + "now", produce the
 *     {@link AttributionWindow} rows to open (one per metric, each with its own
 *     `closesAt`). No I/O.
 *   - {@link dueWindows} — PURE: given the open windows + "now", partition into
 *     those due to close (`closesAt <= now`) and those still open.
 *
 * Window STATE lives in Redis (via the `src/redis/attribution-windows.ts` seam) so an
 * open window survives a housekeeping-process restart — the same durability
 * rationale as the pending-enroll registry. This module never touches Redis
 * directly; the chore passes the seam in.
 *
 * Per CLAUDE.md conventions: the pure helpers never throw.
 */

import type { LeadingOutcomeSample } from "../outcome-regression.ts";
import type { AttributionWindow } from "../redis/attribution-windows.ts";
import type { PendingEnrollEntry } from "../redis/holdback-merge-watch.ts";

// ---------------------------------------------------------------------------
// Tunables (ADR-0005 — named, env-overridable, not magic literals).
// ---------------------------------------------------------------------------

/**
 * DEFAULT window duration for a leading metric with no explicit
 * `attribution_window_ms` in outcomes.yaml.
 *
 * This default trades OFF two forces:
 *   - long enough that the metric has moved enough to attribute (a slow-moving
 *     calibration metric like Brier keeps drifting for a while after a merge),
 *   - short enough that the ledger the reverse-loop consumes (`GET
 *     /api/attribution/impact`, the discovery impact-steering signal) does not
 *     stay structurally DARK for a week.
 *
 * The original 7-day default optimized only the first force, and the effect was
 * that the ledger read `metricCount: 0` for a full week after the spine started
 * opening windows (issue #3404): NO window closed → NO observation row →
 * discovery fell back to the notice-based (cycle-count / merge-rate) signals the
 * spine was built to replace. A 7-day dark period defeats the reverse loop,
 * because discovery runs continuously and needs impact signal on a daily
 * cadence, not a weekly one.
 *
 * 24 hours is the balance: a day is long enough for a metric to settle to a
 * meaningfully attributable delta yet keeps the impact ledger fresh for the
 * continuous discovery loop. A genuinely slower metric can still opt into a
 * LONGER window per-metric via `attribution_window_ms` in outcomes.yaml (that
 * escape hatch is unchanged); this default only governs an UNCONFIGURED metric.
 * Env-overridable via `HYDRA_ATTRIBUTION_DEFAULT_WINDOW_MS`.
 */
export const ATTRIBUTION_DEFAULT_WINDOW_MS = numFromEnv(
  "HYDRA_ATTRIBUTION_DEFAULT_WINDOW_MS",
  24 * 60 * 60 * 1000,
);

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Metric → duration
// ---------------------------------------------------------------------------

/**
 * The window duration (ms) for one leading metric. The metric's
 * `attribution_window_ms` (optional per-metric outcomes.yaml config, #2632)
 * wins when set to a finite positive value; otherwise the conservative
 * {@link ATTRIBUTION_DEFAULT_WINDOW_MS} default applies. PURE.
 */
export function windowDurationMs(attributionWindowMs: number | undefined): number {
  if (
    attributionWindowMs !== undefined &&
    Number.isFinite(attributionWindowMs) &&
    attributionWindowMs > 0
  ) {
    return attributionWindowMs;
  }
  return ATTRIBUTION_DEFAULT_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Window-id
// ---------------------------------------------------------------------------

/**
 * Stable window id: `<metric>@<mergeKey>`, where `mergeKey` is the landing
 * commit SHA when known (globally unique) or `pr-<n>` otherwise. Keying by
 * metric+merge makes {@link openWindow} idempotent — re-observing the same
 * merge landing on a later tick upserts the same window rather than duplicating
 * it. PURE.
 */
export function windowId(
  metric: string,
  sourceCommitSha: string | null,
  representativePr: number | null,
): string {
  const mergeKey =
    sourceCommitSha && sourceCommitSha.length > 0
      ? sourceCommitSha
      : representativePr != null
        ? `pr-${representativePr}`
        : "unknown";
  return `${metric}@${mergeKey}`;
}

// ---------------------------------------------------------------------------
// Open-window construction (PURE)
// ---------------------------------------------------------------------------

/** The merge-landing context a set of windows is opened for. */
export interface MergeWindowContext {
  /** PR numbers whose landing this window batch attributes to. */
  sourcePrNumbers: number[];
  /** Representative landing commit SHA, if known. */
  sourceCommitSha: string | null;
  /** Producer-class → merge count over the window (`{}` = empty window). */
  classCounts: Record<string, number>;
  /** Scope tag of the window's activity (e.g. "orch" | "target"). */
  scopeTouched: string;
  /** Representative tier of the merge(s), or null. */
  tier: number | null;
}

/**
 * Build the {@link AttributionWindow} rows to open for a landed merge — one per
 * live leading metric, each snapshotting that metric's baseline value and
 * closing on its own configured duration. PURE (no I/O): the caller persists
 * the returned rows via the Redis seam.
 *
 * `metricWindowMs` maps a metric name → its optional `attribution_window_ms`
 * (undefined ⇒ default); it is passed in so this stays pure and testable.
 */
export function buildWindowsForMerge(
  leading: LeadingOutcomeSample[],
  metricWindowMs: Map<string, number | undefined>,
  ctx: MergeWindowContext,
  nowMs: number = Date.now(),
): AttributionWindow[] {
  const representativePr =
    ctx.sourcePrNumbers.length > 0 ? ctx.sourcePrNumbers[0] : null;
  return leading.map((l) => {
    const durationMs = windowDurationMs(metricWindowMs.get(l.name));
    return {
      id: windowId(l.name, ctx.sourceCommitSha, representativePr),
      metric: l.name,
      baselineValue: l.value,
      openedAt: nowMs,
      closesAt: nowMs + durationMs,
      classCounts: { ...ctx.classCounts },
      scopeTouched: ctx.scopeTouched,
      tier: ctx.tier,
      sourcePrNumbers: [...ctx.sourcePrNumbers],
      sourceCommitSha: ctx.sourceCommitSha,
    };
  });
}

// ---------------------------------------------------------------------------
// Open selection — the OPEN predicate (PURE)
// ---------------------------------------------------------------------------

/**
 * Normalized merge-landing status for one PR. Owned here (rather than in the
 * coordinator) so the {@link selectMergesToOpen} predicate can consume it
 * without depending on the I/O module. Re-exported from `subscribe.ts` for the
 * coordinator's fetch helper.
 */
export interface MergeStatus {
  state: string | null;
  mergeCommitSha: string | null;
}

/** A pending entry selected to open windows for, with its resolved landing SHA. */
export interface MergeToOpen {
  /** The pending-enroll entry whose merge has landed. */
  entry: PendingEnrollEntry;
  /** The landing commit SHA (never null for a selected entry). */
  mergeCommitSha: string;
}

/**
 * The OPEN predicate — decide which pending-enroll entries should have windows
 * opened this pass. An entry is selected iff its merge has LANDED
 * (`status.mergeCommitSha != null`) AND that commit does not already have a
 * window open (`!commitsWithWindows.has(sha)`). PURE: takes the already-fetched
 * merge statuses (keyed by PR number) + the set of commit SHAs that already
 * have open windows, and returns the entries to open in input order.
 *
 * Entries with no fetched status (a fetch that failed / returned null upstream)
 * are simply absent from `statusByPr` and thus excluded here — the fetch-error
 * fail-loud handling stays in the coordinator, which is why this predicate is
 * pure and independently testable without a `gh`/Redis fixture.
 */
export function selectMergesToOpen(
  entries: PendingEnrollEntry[],
  statusByPr: Map<number, MergeStatus>,
  commitsWithWindows: ReadonlySet<string>,
): MergeToOpen[] {
  const toOpen: MergeToOpen[] = [];
  for (const entry of entries) {
    const status = statusByPr.get(entry.prNumber);
    if (status == null) continue; // no status (not fetched / fetch failed) — skip
    if (!status.mergeCommitSha) continue; // not landed yet — leave for later tick
    if (commitsWithWindows.has(status.mergeCommitSha)) continue; // already opened
    toOpen.push({ entry, mergeCommitSha: status.mergeCommitSha });
  }
  return toOpen;
}

// ---------------------------------------------------------------------------
// Close selection (PURE)
// ---------------------------------------------------------------------------

/** A partition of the open windows into those due to close and those still open. */
export interface DueWindows {
  /** Windows whose duration has elapsed (`closesAt <= now`) — close these. */
  due: AttributionWindow[];
  /** Windows still within their duration — leave for a later tick. */
  stillOpen: AttributionWindow[];
}

/**
 * Partition the open windows into those due to close (`closesAt <= nowMs`) and
 * those still open. Each metric closes independently on its own `closesAt`, so a
 * fast metric's window can close many ticks before a slow one's. PURE.
 */
export function dueWindows(
  windows: AttributionWindow[],
  nowMs: number = Date.now(),
): DueWindows {
  const due: AttributionWindow[] = [];
  const stillOpen: AttributionWindow[] = [];
  for (const w of windows) {
    if (w.closesAt <= nowMs) due.push(w);
    else stillOpen.push(w);
  }
  return { due, stillOpen };
}
