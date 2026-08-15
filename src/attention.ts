/**
 * Attention feed composer (issue #4007, ADR-0034 §4).
 *
 * One heterogeneous "needs attention" list on the Today page, ranked by
 * **threshold-crossing**, not by score. An item surfaces because it crossed a
 * stated line and renders that line as its own explanation
 * (`observedValue` + `threshold` + `thresholdLabel`) — the ADR-0034 §5.3
 * rule that a derived value must decompose into its inputs.
 *
 * Three signals (see `AttentionSignalSchema` for the closed vocabulary):
 *
 *   - blocked-on-human — `blocked` ≥ blockedDays (2) and `needs-info` ≥
 *     needsInfoDays (1), from `getStuckItems()`'s `blockedOver2d` /
 *     `needsInfoWaiting` buckets.
 *   - breakage         — open PRs with failing checks, from
 *     `getStuckItems()`'s `prsWithFailedCi` bucket (the PR's own crossing
 *     line is "≥ 1 failed check").
 *   - repetition       — friction patterns with `hitCount` ≥
 *     `PROMOTION_THRESHOLD` (3), from `getFrictionPatterns()`.
 *
 * **Deviation is deliberately excluded** (ADR-0034 §4): no spend, quota,
 * usage or duration signal exists here. Import discipline is the guard — this
 * module imports only the blocked/breakage fields of `getStuckItems()` and
 * the repetition rows of `getFrictionPatterns()`, never `src/cost/*` or any
 * usage-tracker output, and `test/attention.test.mts` regression-locks the
 * response shape against cost-shaped keys.
 *
 * No NEW thresholds are invented: every `threshold` echoes the constants
 * already in production (`DEFAULT_THRESHOLDS` via the stuck snapshot's own
 * echo; `PROMOTION_THRESHOLD` from pattern-memory).
 *
 * # Design contract
 *
 * - **Never throws** (getAttentionFeed): both aggregator sub-fetches run
 *   under `Promise.allSettled` + `settledOr` fallbacks, matching the
 *   aggregator convention in stuck-items.ts / friction-patterns.ts /
 *   decision-queue.ts. A failed sub-fetch degrades to that signal's empty
 *   bucket and flips `sourcesOk` false.
 * - **Asserted emptiness** (ADR-0034 §5.2): the result carries `scanned` +
 *   `sourcesOk` (mirroring #4006's `DecisionQueueResult`) so a genuine
 *   zero-crossed-items day renders all-clear and an unproven one renders
 *   UNKNOWN — never a hollow all-clear.
 * - **Dismissals are durable and counted per line.** Items whose id is in
 *   the per-signal dismissed ledger (30-day snooze) are filtered out of the
 *   feed; the surfaced/dismissed counters are keyed by SIGNAL, not by item,
 *   so the calibration count survives across individual items.
 */

import {
  DEFAULT_THRESHOLDS,
  getStuckItems,
  type StuckItems,
  type StuckItemsDeps,
} from "./aggregators/stuck-items.ts";
import {
  getFrictionPatterns,
  type FrictionPatternsDeps,
  type FrictionPatternsSnapshot,
  type FrictionPatternRow,
} from "./aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD } from "./pattern-memory/index.ts";
import { settledOr, settledOrEmpty } from "./settled-fold.ts";
import {
  loadDismissedIds,
  recordSurfacedItems,
} from "./redis/attention.ts";
import type {
  AttentionFeedItem,
  AttentionSignal,
} from "./schemas/attention.ts";
import { logger } from "./logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The composer result — same asserted-emptiness contract as #4006's
 * `DecisionQueueResult`: `scanned` proves the threshold lookups ran;
 * `sourcesOk` is the emptiness assertion (every sub-fetch fulfilled).
 */
export interface AttentionFeedResult {
  items: AttentionFeedItem[];
  /** Pre-filter raw row count from the fulfilled sub-fetches (proof the lookup ran). */
  scanned: number;
  /** True iff every underlying sub-fetch settled fulfilled (the emptiness assertion). */
  sourcesOk: boolean;
}

export interface AttentionFeedDeps {
  /** Wall-clock anchor — defaults to `new Date()`; forwarded to both aggregators. */
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /** Override the stuck-items aggregator. Tests inject a stub. */
  getStuckItems?: (deps?: StuckItemsDeps) => Promise<StuckItems>;
  /** Override the friction-patterns aggregator. Tests inject a stub. */
  getFrictionPatterns?: (deps?: FrictionPatternsDeps) => Promise<FrictionPatternsSnapshot>;
  /** Override the dismissal-ledger read. Tests inject a stub. */
  loadDismissedIds?: (signal: AttentionSignal) => Promise<string[]>;
  /** Override the surfaced-counter write. Tests inject a stub. */
  recordSurfaced?: (items: readonly AttentionFeedItem[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getAttentionFeed(
  deps: AttentionFeedDeps = {},
): Promise<AttentionFeedResult> {
  const stuckFn = deps.getStuckItems ?? getStuckItems;
  const frictionFn = deps.getFrictionPatterns ?? getFrictionPatterns;
  const loadDismissed = deps.loadDismissedIds ?? loadDismissedIds;
  const recordSurfaced = deps.recordSurfaced ?? recordSurfacedItems;

  const aggregatorDeps = { now: deps.now, githubRepo: deps.githubRepo };

  // INV-1: never throws — each signal source degrades independently via
  // Promise.allSettled + settledOr fallbacks (the aggregator convention).
  const [stuckResult, frictionResult] = await Promise.allSettled([
    stuckFn(aggregatorDeps),
    frictionFn(aggregatorDeps),
  ]);

  const emptyStuck = (): StuckItems => ({
    blockedOver2d: [],
    needsInfoWaiting: [],
    prsWithFailedCi: [],
    thresholds: DEFAULT_THRESHOLDS,
    generatedAt: (deps.now ?? new Date()).toISOString(),
    scanned: 0,
    sourcesOk: false,
  });
  const emptyFriction = (): FrictionPatternsSnapshot => ({
    bySkill: [],
    thresholdCandidates: [],
    recentMetaFrictionIssues: [],
    promotionThreshold: PROMOTION_THRESHOLD,
    candidateWindow: 1,
    windowHours: 168,
    generatedAt: (deps.now ?? new Date()).toISOString(),
    scanned: 0,
    sourcesOk: false,
  });

  const stuck = settledOr(stuckResult, emptyStuck(), "attention/stuck-items");
  const friction = settledOr(
    frictionResult,
    emptyFriction(),
    "attention/friction-patterns",
  );

  // INV-3: asserted-emptiness evidence, mirroring DecisionQueueResult (#4006).
  const scanned = stuck.scanned + friction.scanned;
  const sourcesOk = stuck.sourcesOk && friction.sourcesOk;

  // The common item shape — observedValue/threshold are ALWAYS the literal
  // numbers the underlying source already computed against the SAME
  // production threshold constants (INV-4). No new thresholds are invented.
  const items: AttentionFeedItem[] = [
    ...stuck.blockedOver2d.map((issue): AttentionFeedItem => ({
      id: `blocked-issue-${issue.number}`,
      signal: "blocked-on-human",
      title: issue.title,
      url: issue.url,
      observedValue: issue.ageDays,
      threshold: stuck.thresholds.blockedDays,
      thresholdLabel: `blocked ≥ ${stuck.thresholds.blockedDays}d`,
      crossedAt: crossedAtFrom(issue.createdAt, stuck.thresholds.blockedDays),
      dismissed: false,
    })),
    ...stuck.needsInfoWaiting.map((issue): AttentionFeedItem => ({
      id: `needs-info-issue-${issue.number}`,
      signal: "blocked-on-human",
      title: issue.title,
      url: issue.url,
      observedValue: issue.ageDays,
      threshold: stuck.thresholds.needsInfoDays,
      thresholdLabel: `needs-info ≥ ${stuck.thresholds.needsInfoDays}d`,
      crossedAt: crossedAtFrom(issue.createdAt, stuck.thresholds.needsInfoDays),
      dismissed: false,
    })),
    ...stuck.prsWithFailedCi.map((pr): AttentionFeedItem => ({
      id: `pr-failed-ci-${pr.number}`,
      signal: "breakage",
      title: pr.title,
      url: pr.url,
      // The PR's own crossing line: at least one failed check.
      observedValue: pr.failedChecks.length,
      threshold: 1,
      thresholdLabel: "≥ 1 failed check",
      crossedAt: pr.updatedAt,
      dismissed: false,
    })),
    ...repetitionItems(friction),
  ];

  // Dismissal filter: durable per item id, read per signal. A failed
  // ledger read degrades to "no suppressions" (fail-open) and logs — a
  // Redis blip resurfacing an already-dismissed item is recoverable noise;
  // blanking the feed over it is not.
  const [dismissedBlocked, dismissedBreakage, dismissedRepetition] =
    await Promise.allSettled([
      loadDismissed("blocked-on-human"),
      loadDismissed("breakage"),
      loadDismissed("repetition"),
    ]);
  const dismissedBySignal = new Map<AttentionSignal, Set<string>>([
    ["blocked-on-human", new Set(settledOrEmpty(dismissedBlocked, "attention/dismissed-blocked"))],
    ["breakage", new Set(settledOrEmpty(dismissedBreakage, "attention/dismissed-breakage"))],
    ["repetition", new Set(settledOrEmpty(dismissedRepetition, "attention/dismissed-repetition"))],
  ]);
  const visible = items.filter(
    (item) => !dismissedBySignal.get(item.signal)!.has(item.id),
  );

  // Oldest crossing first — the item that crossed its line earliest has been
  // waiting longest.
  visible.sort((a, b) => {
    const aMs = Date.parse(a.crossedAt);
    const bMs = Date.parse(b.crossedAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
    if (Number.isFinite(aMs)) return -1;
    if (Number.isFinite(bMs)) return 1;
    return a.id.localeCompare(b.id);
  });

  // Per-line surfaced counters — counted ONCE per item id by the ledger, so
  // the 30s poll cadence cannot inflate the calibration signal. Best-effort:
  // a counter failure degrades to a log line, never a failed feed read.
  try {
    await recordSurfaced(visible);
  } catch (err) {
    logger.error(
      { err },
      "[attention] surfaced-counter update failed (non-fatal)",
    );
  }

  return { items: visible, scanned, sourcesOk };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Best-effort instant an age-threshold crossing happened: creation plus the
 * threshold in days. An unparseable createdAt degrades to the raw string —
 * the sort treats it as unknown, never as "just now".
 */
export function crossedAtFrom(createdAt: string, thresholdDays: number): string {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return createdAt;
  return new Date(createdMs + thresholdDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Pure helper — exported for tests. Lifts the repetition rows (hitCount ≥
 * PROMOTION_THRESHOLD) out of a friction snapshot into the common item shape.
 * Deep-links to the escalation's GitHub issue when one has fired, else to the
 * Explore page's Friction tab (the current detail owner for un-escalated
 * patterns; /runs — ADR-0034's future home for this content — has not
 * shipped).
 */
export function repetitionItems(
  snapshot: FrictionPatternsSnapshot,
): AttentionFeedItem[] {
  const out: AttentionFeedItem[] = [];
  for (const group of snapshot.bySkill) {
    for (const pattern of group.patterns) {
      if (pattern.hitCount < PROMOTION_THRESHOLD) continue;
      out.push({
        id: `friction-${encodeURIComponent(group.skill)}-${encodeURIComponent(pattern.cue)}`,
        signal: "repetition",
        title: `${group.skill}: ${pattern.cue}`,
        url: repetitionUrl(pattern),
        observedValue: pattern.hitCount,
        threshold: PROMOTION_THRESHOLD,
        thresholdLabel: `hits ≥ ${PROMOTION_THRESHOLD}`,
        crossedAt: pattern.lastSeen || snapshot.generatedAt,
        dismissed: false,
      });
    }
  }
  return out;
}

function repetitionUrl(pattern: FrictionPatternRow): string {
  if (pattern.lastEscalation?.issueNumber) {
    return `https://github.com/gaberoo322/hydra/issues/${pattern.lastEscalation.issueNumber}`;
  }
  return "/explore/friction";
}
