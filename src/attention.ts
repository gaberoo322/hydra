/**
 * Attention feed composer (issue #4007, ADR-0034 §4; six-bucket drain order
 * issue #4623, ADR-0034 §8.1/§8.2).
 *
 * One heterogeneous "needs attention" list on the Today page, ranked by
 * **threshold-crossing**, not by score. An item surfaces because it crossed a
 * stated line and renders that line as its own explanation
 * (`observedValue` + `threshold` + `thresholdLabel`) — the ADR-0034 §5.3
 * rule that a derived value must decompose into its inputs.
 *
 * # Six fixed-order buckets (ADR-0034 §8.1, issue #4623)
 *
 * Every item lands in exactly one bucket (`BUCKETS` in
 * src/schemas/operator-actions.ts) and carries its `<bucket>:<line>`
 * admission-line `key`. The feed drains rank 0 → 5; age (crossedAt ascending,
 * then id) orders items WITHIN a bucket only — never across buckets.
 *
 *   0 machine-stopped  — ONE aggregate row over the active lines `paused`,
 *                        `session-blocked`, `scheduler-deliberate`,
 *                        `sha-drift` (deployed SHA ≠ origin/master for
 *                        ≥ DEPLOY_DRIFT_GRACE_SECONDS).
 *   1 prs-not-landing  — `conflicted` / `failed-required` / `unshepherded`
 *                        ← src/aggregators/stalled-prs.ts (issue #4624): one
 *                        item per open non-draft PR, REQUIRED checks only.
 *                        The feed makes exactly ONE `gh pr list` call — the
 *                        stuck-items PR lister is stubbed empty here.
 *   2 waiting-on-you   — `ready-for-human`, `stale-blocked`, `needs-info`,
 *                        `blocked-live` ← src/aggregators/issues-waiting.ts
 *                        (issue #4625): one line per issue, by precedence.
 *   3 target-items     — the same aggregator pointed at the ONE configured
 *                        Target repo (`getTargetGithubRepo()`, never a
 *                        literal) plus `reframe`. An archived/unset Target
 *                        renders one `archived` aggregate row, never an
 *                        empty bucket (issue #4625).
 *   4 repetition       — `hits` ← friction patterns ≥ the cue's bar.
 *   5 parked-over-cap  — `cap` ← the hitl-grill lane (issue #4626): ONE
 *                        aggregate row once the open lane holds >=
 *                        HITL_GRILL_CAP rows (same projection as
 *                        GET /autopilot/hitl-grill).
 *
 * Each item also carries its resolved `action` — the operator-action REGISTRY
 * entry for its key (ADR-0034 §8.2) with `{repo}` / `{number}` / `{kind}`
 * templates substituted server-side.
 *
 * **Deviation is deliberately excluded** (ADR-0034 §4): no spend, quota,
 * usage or duration signal exists here. Import discipline is the guard — this
 * module never imports `src/cost/*` or any usage-tracker output (and reads
 * pause / session-block through the Redis adapters directly, NOT through
 * usage-eligibility, which pulls cost/ in and fails SAFE to "not paused");
 * `test/attention.test.mts` regression-locks it.
 *
 * # Module layout (issue #5615)
 *
 * This file is the composer + public facade. Each bucket's line builders and
 * readers live in `src/attention/<bucket>.ts` and return a uniform
 * `BucketRead`; the composer keeps ordering, evidence accounting, registry
 * action resolution, the §8.4 ledger reconcile and the dismissal filter.
 * `AttentionFeedDeps` is the intersection of the per-bucket deps interfaces,
 * so callers still inject one flat object.
 *
 * # Design contract
 *
 * - **Never throws** (getAttentionFeed): every sub-read runs under
 *   `Promise.allSettled`. A failed sub-read degrades its bucket to
 *   `sourcesOk:false` with a named `sourceErrors` entry.
 * - **Asserted emptiness per bucket** (ADR-0034 §5.2): each bucket reports
 *   `scanned` / `sourcesOk` / `sourceErrors`. A failed rank-0 read NEVER
 *   degrades to "not stopped" — the bucket renders UNKNOWN. Top-level
 *   `sourcesOk` ANDs all six buckets; top-level `scanned` sums them all.
 * - **Dismissals are durable and counted per signal.** Items whose id is in
 *   the per-signal dismissed ledger (30-day snooze) are filtered out of the
 *   feed; the surfaced/dismissed counters are keyed by SIGNAL, not by item.
 */

import { logger } from "./logger.ts";
import {
  loadDismissed as loadDismissedLedger,
  reconcileLedgers as reconcileLedgersDefault,
  type AdmittedLine,
} from "./redis/attention.ts";
import { REGISTRY } from "./operator-actions/registry.ts";
import {
  ADMISSION_LINE_KEYS,
  BUCKETS,
  type Bucket,
  type OperatorActionEntry,
} from "./schemas/operator-actions.ts";
import type {
  AttentionBucketSummary,
  AttentionFeedItem,
  MachineStoppedSubLine,
} from "./schemas/attention.ts";
import { resolveAction } from "./attention/actions.ts";
import { bucketOf, settle, type BucketRead, type Draft } from "./attention/draft.ts";
import { readMachineStopped, type MachineStoppedDeps } from "./attention/machine-stopped.ts";
import { readStalledPrs, type StalledPrsBucketDeps } from "./attention/stalled-prs.ts";
import {
  readInvalidState,
  readWaiting,
  type WaitingBucketDeps,
} from "./attention/waiting.ts";
import { readTargetItems, type TargetBucketDeps } from "./attention/target.ts";
import { readRepetition, repetitionItems, type RepetitionBucketDeps } from "./attention/repetition.ts";
import { readParked, type ParkedBucketDeps } from "./attention/parked.ts";

// Facade: every symbol this module exported before the #5615 split.
export { resolveAction, type ActionContext } from "./attention/actions.ts";
export { crossedAtFrom, INVALID_STATE_REPORT_MAX_AGE_MS, type InvalidStateRead } from "./attention/waiting.ts";
export { repetitionItems };
export type { SchedulerStopRead } from "./attention/machine-stopped.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The composer result — asserted-emptiness contract per bucket (ADR-0034
 * §5.2). `items` is the flat drain-ordered list; `buckets` summarises each of
 * the six buckets without duplicating items.
 */
export interface AttentionFeedResult {
  items: AttentionFeedItem[];
  /** Six summaries, in BUCKETS drain order. */
  buckets: AttentionBucketSummary[];
  /** Sum of per-bucket `scanned` (proof the lookups ran). */
  scanned: number;
  /** AND of `sourcesOk` over the WIRED buckets (the emptiness assertion). */
  sourcesOk: boolean;
}

/** The composer's own injection slice (everything not owned by one bucket). */
export interface ComposerDeps {
  /** Wall-clock anchor — defaults to `new Date()`; forwarded to both aggregators. */
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /** Override the per-line dismissed-episode ledger read. Tests inject a stub. */
  loadDismissed?: (now?: Date) => Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * Override the per-line episode reconcile (surfaced recording + prune on
   * absence from a healthy source — ADR-0034 §8.4). Tests inject a stub.
   */
  reconcileLedgers?: (
    admittedByLine: ReadonlyMap<string, AdmittedLine>,
    now?: Date,
  ) => Promise<void>;
  /** Override the operator-action registry (tests only). */
  registry?: readonly OperatorActionEntry[];
}

/**
 * The single public injection surface: the intersection of each bucket
 * module's deps slice plus the composer's own. Field names and signatures are
 * unchanged by the split.
 */
export type AttentionFeedDeps = ComposerDeps &
  MachineStoppedDeps &
  StalledPrsBucketDeps &
  WaitingBucketDeps &
  TargetBucketDeps &
  RepetitionBucketDeps &
  ParkedBucketDeps;

const DEFAULT_REPO = "gaberoo322/hydra";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getAttentionFeed(
  deps: AttentionFeedDeps = {},
): Promise<AttentionFeedResult> {
  const loadDismissed = deps.loadDismissed ?? loadDismissedLedger;
  const reconcile = deps.reconcileLedgers ?? reconcileLedgersDefault;
  const registry = deps.registry ?? REGISTRY;
  const repo = deps.githubRepo ?? DEFAULT_REPO;
  const nowDate = deps.now ?? new Date();

  const aggregatorDeps = { now: deps.now, githubRepo: deps.githubRepo };

  // Issue #4624 / #4625: rank 1 reads PRs through stalled-prs (ONE
  // `gh pr list`), and ranks 2-3 read issues through issues-waiting;
  // getStuckItems is no longer called from the feed (its /api/v2/today/stuck
  // response shape is unchanged).

  // Never throws — every source degrades independently (each bucket read
  // settles its own sources and names its own failures).
  const [waiting, invalid, target, stalled, repetition, machineStopped, parked] =
    await Promise.all([
      readWaiting(deps, { repo, now: nowDate, githubRepo: deps.githubRepo }),
      readInvalidState(deps, repo, nowDate),
      readTargetItems(deps, nowDate),
      readStalledPrs(deps, repo),
      readRepetition(deps, aggregatorDeps, nowDate),
      readMachineStopped(deps, nowDate),
      readParked(deps, repo, nowDate),
    ]);

  // Per-bucket evidence accumulators.
  const evidence = new Map<Bucket, { scanned: number; errors: string[] }>(
    BUCKETS.map((b) => [b, { scanned: 0, errors: [] }]),
  );
  const fold = (bucket: Bucket, read: BucketRead) => {
    const e = evidence.get(bucket)!;
    e.scanned += read.scanned;
    for (const error of read.sourceErrors) {
      if (!e.errors.includes(error)) e.errors.push(error);
    }
  };
  const note = (bucket: Bucket, error: string) => {
    const e = evidence.get(bucket)!;
    if (!e.errors.includes(error)) e.errors.push(error);
  };

  // Rank 2's `scanned` is the sum of the issues-waiting + hold-exit reads
  // (already summed inside readWaiting).
  fold("machine-stopped", machineStopped);
  fold("prs-not-landing", stalled);
  fold("waiting-on-you", waiting);
  fold("target-items", target);
  fold("repetition", repetition);
  fold("parked-over-cap", parked);

  // Resolve each draft's registry action; a missing entry / unresolved
  // placeholder drops the item and marks its bucket UNKNOWN (never an
  // action-less item, never an asserted zero).
  const drafts: Draft[] = [
    ...machineStopped.drafts,
    ...stalled.drafts,
    ...waiting.drafts,
    ...invalid.drafts,
    ...target.drafts,
    ...repetition.drafts,
    ...parked.drafts,
  ];

  const items: AttentionFeedItem[] = [];
  for (const draft of drafts) {
    const bucket = bucketOf(draft.key);
    const action = resolveAction(draft.key, undefined, draft.context, registry);
    if (action === null) {
      logger.error(
        { key: draft.key, id: draft.base.id },
        "[attention] no resolvable registry action for item — dropped; bucket marked UNKNOWN",
      );
      note(bucket, `registry:${draft.key}`);
      continue;
    }
    let subLines: MachineStoppedSubLine[] | undefined;
    if (draft.subLines) {
      subLines = [];
      let dropped = false;
      for (const sub of draft.subLines) {
        const subAction = resolveAction(sub.key, undefined, {}, registry);
        if (subAction === null) {
          logger.error(
            { key: sub.key },
            "[attention] no resolvable registry action for machine-stopped line — dropped; bucket marked UNKNOWN",
          );
          note(bucket, `registry:${sub.key}`);
          dropped = true;
          break;
        }
        subLines.push({ key: sub.key, line: sub.line, detail: sub.detail, action: subAction });
      }
      if (dropped) continue;
    }
    items.push({
      ...draft.base,
      bucket,
      rank: BUCKETS.indexOf(bucket),
      key: draft.key,
      action,
      ...(subLines ? { subLines } : {}),
      ...(draft.context.kind === "issue" && typeof draft.context.number === "number"
        ? { issue: draft.context.number }
        : {}),
    });
  }

  // ADR-0034 §8.4 episode reconciliation, per admission line. `admitted` is
  // the composer's PRE-dismissal-filter id set (a dismissed item is still
  // crossing, just hidden); `healthy` is the line's bucket evidence map —
  // the only per-source signal the composer has — and gates the prune: an
  // id absent from an unhealthy source proved nothing. Every registry line
  // is present so a line that went quiet still clears its stale episodes.
  // This runs BEFORE the dismissed-ledger read below, so a pruned dismissal
  // can never hide the new episode of a re-crossing. Best-effort: a
  // reconcile failure degrades to one log line, never a failed feed read.
  const admittedByLine = new Map<string, { admitted: Set<string>; healthy: boolean }>(
    ADMISSION_LINE_KEYS.map((key) => [key, { admitted: new Set<string>(), healthy: false }]),
  );
  for (const item of items) {
    admittedByLine.get(item.key)!.admitted.add(item.id);
  }
  for (const key of admittedByLine.keys()) {
    admittedByLine.get(key)!.healthy = evidence.get(bucketOf(key))!.errors.length === 0;
  }
  // The invalid-state line is healthy iff the persisted report exists and is fresh.
  admittedByLine.get("waiting-on-you:invalid-state")!.healthy =
    admittedByLine.get("waiting-on-you:invalid-state")!.healthy && invalid.fresh;
  try {
    await reconcile(admittedByLine, nowDate);
  } catch (err) {
    logger.error(
      { err },
      "[attention] calibration ledger reconcile failed (non-fatal)",
    );
  }

  // Dismissal filter: durable per episode, read per line. A failed ledger
  // read degrades to "no suppressions" (fail-open) and logs — a Redis blip
  // resurfacing an already-dismissed item is recoverable noise; blanking the
  // feed over it is not.
  let dismissedByLine: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  try {
    dismissedByLine = await loadDismissed(nowDate);
  } catch (err) {
    logger.error(
      { err },
      "[attention] dismissed-ledger read failed — degrading to no suppressions",
    );
  }
  const visible = items.filter(
    (item) => !dismissedByLine.get(item.key)?.has(item.id),
  );

  visible.sort(compareDrainOrder);

  const buckets: AttentionBucketSummary[] = BUCKETS.map((bucket, rank) => {
    const e = evidence.get(bucket)!;
    return {
      rank,
      bucket,
      wired: true,
      count: visible.filter((item) => item.bucket === bucket).length,
      scanned: e.scanned,
      sourcesOk: e.errors.length === 0,
      sourceErrors: [...e.errors],
    };
  });

  const scanned = buckets.reduce((sum, b) => sum + b.scanned, 0);
  const sourcesOk = buckets.every((b) => b.sourcesOk);

  return { items: visible, buckets, scanned, sourcesOk };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Drain-order comparator (ADR-0034 §8.1): rank ascending; within a rank,
 * crossedAt ascending with an unparseable crossedAt last; then id. An item
 * in rank N always precedes every item in rank N+1 regardless of age.
 */
export function compareDrainOrder(
  a: Pick<AttentionFeedItem, "rank" | "crossedAt" | "id">,
  b: Pick<AttentionFeedItem, "rank" | "crossedAt" | "id">,
): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const aMs = Date.parse(a.crossedAt);
  const bMs = Date.parse(b.crossedAt);
  const aOk = Number.isFinite(aMs);
  const bOk = Number.isFinite(bMs);
  if (aOk && bOk && aMs !== bMs) return aMs - bMs;
  if (aOk && !bOk) return -1;
  if (!aOk && bOk) return 1;
  return a.id.localeCompare(b.id);
}
