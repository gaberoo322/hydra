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
 *   2 waiting-on-you   — `blocked-live` ← stuck.blockedOver2d,
 *                        `needs-info` ← stuck.needsInfoWaiting.
 *   3 target-items     — not wired in this slice (#4625): wired:false.
 *   4 repetition       — `hits` ← friction patterns ≥ the cue's bar.
 *   5 parked-over-cap  — not wired in this slice (#4626): wired:false.
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
 * # Design contract
 *
 * - **Never throws** (getAttentionFeed): every sub-read runs under
 *   `Promise.allSettled`. A failed sub-read degrades its bucket to
 *   `sourcesOk:false` with a named `sourceErrors` entry.
 * - **Asserted emptiness per bucket** (ADR-0034 §5.2): each bucket reports
 *   `scanned` / `sourcesOk` / `sourceErrors`. A failed rank-0 read NEVER
 *   degrades to "not stopped" — the bucket renders UNKNOWN. Top-level
 *   `sourcesOk` ANDs the WIRED buckets; top-level `scanned` sums them all.
 * - **Dismissals are durable and counted per signal.** Items whose id is in
 *   the per-signal dismissed ledger (30-day snooze) are filtered out of the
 *   feed; the surfaced/dismissed counters are keyed by SIGNAL, not by item.
 */

import {
  DEFAULT_THRESHOLDS,
  getStuckItems,
  type StuckItems,
  type StuckItemsDeps,
} from "./aggregators/stuck-items.ts";
import {
  getStalledPrs,
  type StalledPr,
  type StalledPrLine,
  type StalledPrsDeps,
  type StalledPrsResult,
} from "./aggregators/stalled-prs.ts";
import {
  getFrictionPatterns,
  type FrictionPatternsDeps,
  type FrictionPatternsSnapshot,
  type FrictionPatternRow,
} from "./aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD, escalationThresholdForCue } from "./pattern-memory/index.ts";
import { settledOr, settledOrEmpty } from "./settled-fold.ts";
import {
  loadDismissedIds,
  recordSurfacedItems,
} from "./redis/attention.ts";
import { getAutopilotPaused, type AutopilotPauseState } from "./redis/autopilot-pause.ts";
import { getSessionBlockedUntil } from "./redis/session-block.ts";
import { getStatus as getSchedulerStatus } from "./scheduler/heartbeat.ts";
import {
  DEPLOY_DRIFT_GRACE_SECONDS,
  readDeployDrift,
  type DeployDriftReading,
} from "./health/deployed-sha.ts";
import { REGISTRY } from "./operator-actions/registry.ts";
import {
  BUCKETS,
  BUCKET_LINES,
  type Action,
  type Bucket,
  type OperatorActionEntry,
  type Variant,
} from "./schemas/operator-actions.ts";
import type {
  AttentionBucketSummary,
  AttentionFeedItem,
  AttentionSignal,
  MachineStoppedSubLine,
} from "./schemas/attention.ts";
import { logger } from "./logger.ts";

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

export interface AttentionFeedDeps {
  /** Wall-clock anchor — defaults to `new Date()`; forwarded to both aggregators. */
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /** Override the stuck-items aggregator. Tests inject a stub. */
  getStuckItems?: (deps?: StuckItemsDeps) => Promise<StuckItems>;
  /** Override the rank-1 stalled-PRs aggregator (issue #4624). Tests inject a stub. */
  getStalledPrs?: (deps?: StalledPrsDeps) => Promise<StalledPrsResult>;
  /** Override the friction-patterns aggregator. Tests inject a stub. */
  getFrictionPatterns?: (deps?: FrictionPatternsDeps) => Promise<FrictionPatternsSnapshot>;
  /** Override the dismissal-ledger read. Tests inject a stub. */
  loadDismissedIds?: (signal: AttentionSignal) => Promise<string[]>;
  /** Override the surfaced-counter write. Tests inject a stub. */
  recordSurfaced?: (items: readonly AttentionFeedItem[]) => Promise<void>;
  /** Rank-0 `paused` line read. Default: src/redis/autopilot-pause.ts. */
  readPaused?: () => Promise<AutopilotPauseState>;
  /** Rank-0 `session-blocked` line read (epoch ms, null = none). Default: src/redis/session-block.ts. */
  readSessionBlockedUntil?: () => Promise<number | null>;
  /** Rank-0 `scheduler-deliberate` line read. Default: scheduler heartbeat getStatus().stopReason. */
  readSchedulerStopReason?: () => Promise<string | null>;
  /** Rank-0 `sha-drift` line read. Default: src/health/deployed-sha.ts readDeployDrift(). */
  readShaDrift?: () => Promise<DeployDriftReading>;
  /** Override the operator-action registry (tests only). */
  registry?: readonly OperatorActionEntry[];
}

/** Per-item template context (ADR-0034 §8.2 BUCKET_CONTEXT). */
export type ActionContext = Readonly<Record<string, string | number>>;

/** Buckets with no source in this slice (#4625 / #4626 wire them). */
const UNWIRED_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>(["target-items", "parked-over-cap"]);

const DEFAULT_REPO = "gaberoo322/hydra";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getAttentionFeed(
  deps: AttentionFeedDeps = {},
): Promise<AttentionFeedResult> {
  const stuckFn = deps.getStuckItems ?? getStuckItems;
  const stalledFn = deps.getStalledPrs ?? getStalledPrs;
  const frictionFn = deps.getFrictionPatterns ?? getFrictionPatterns;
  const loadDismissed = deps.loadDismissedIds ?? loadDismissedIds;
  const recordSurfaced = deps.recordSurfaced ?? recordSurfacedItems;
  const registry = deps.registry ?? REGISTRY;
  const repo = deps.githubRepo ?? DEFAULT_REPO;
  const nowDate = deps.now ?? new Date();

  const aggregatorDeps = { now: deps.now, githubRepo: deps.githubRepo };

  // Issue #4624: rank 1 reads PRs through stalled-prs, so stuck-items gets an
  // empty PR lister (and no required-contexts read) — exactly ONE gh pr list
  // call per feed read. /api/v2/today/stuck still calls getStuckItems with
  // its real PR lister and is unchanged.
  const stuckDeps: StuckItemsDeps = {
    ...aggregatorDeps,
    listOpenPrsOrEmpty: async () => [],
    listRequiredStatusContextsOrNull: async () => null,
  };

  // Never throws — every source degrades independently.
  const [stuckResult, stalledResult, frictionResult, machineStopped] = await Promise.all([
    settle(() => stuckFn(stuckDeps)),
    settle(() => stalledFn({ githubRepo: repo })),
    settle(() => frictionFn(aggregatorDeps)),
    readMachineStopped(deps, nowDate),
  ]);

  const emptyStuck = (): StuckItems => ({
    blockedOver2d: [],
    needsInfoWaiting: [],
    prsWithFailedCi: [],
    thresholds: DEFAULT_THRESHOLDS,
    generatedAt: nowDate.toISOString(),
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
    generatedAt: nowDate.toISOString(),
    scanned: 0,
    sourcesOk: false,
  });

  const stuck = settledOr(stuckResult, emptyStuck(), "attention/stuck-items");
  const friction = settledOr(
    frictionResult,
    emptyFriction(),
    "attention/friction-patterns",
  );

  // Per-bucket evidence accumulators.
  const evidence = new Map<Bucket, { scanned: number; errors: string[] }>(
    BUCKETS.map((b) => [b, { scanned: 0, errors: [] }]),
  );
  const note = (bucket: Bucket, error: string) => {
    const e = evidence.get(bucket)!;
    if (!e.errors.includes(error)) e.errors.push(error);
  };

  // Rank 1 (issue #4624): stalled-prs. scanned = open PR rows the fetch
  // returned (proof the lookup ran), NOT the admitted count; its named
  // source errors (pr-list / required-contexts) render the bucket UNKNOWN.
  const stalled = settledOr<StalledPrsResult>(
    stalledResult,
    { items: [], scanned: 0, sourcesOk: false, sourceErrors: ["stalled-prs"] },
    "attention/stalled-prs",
  );
  evidence.get("prs-not-landing")!.scanned = stalled.scanned;
  for (const err of stalled.sourceErrors) note("prs-not-landing", err);
  if (!stalled.sourcesOk && stalled.sourceErrors.length === 0) {
    note("prs-not-landing", "stalled-prs");
  }

  // Rank 2: stuck-items' issue rows only (its PR lister is stubbed empty
  // above), so stuck.scanned is exactly the waiting-on-you evidence.
  evidence.get("waiting-on-you")!.scanned = stuck.scanned;
  if (stuckResult.status === "rejected" || !stuck.sourcesOk) {
    note("waiting-on-you", "stuck-items");
  }
  evidence.get("repetition")!.scanned = friction.scanned;
  if (frictionResult.status === "rejected" || !friction.sourcesOk) {
    note("repetition", "friction-patterns");
  }
  evidence.get("machine-stopped")!.scanned = machineStopped.scanned;
  for (const err of machineStopped.sourceErrors) note("machine-stopped", err);

  // Resolve each draft's registry action; a missing entry / unresolved
  // placeholder drops the item and marks its bucket UNKNOWN (never an
  // action-less item, never an asserted zero).
  const drafts: Draft[] = [
    ...(machineStopped.row ? [machineStopped.row] : []),
    ...stalled.items.map((pr) => stalledPrDraft(pr, repo)),
    ...stuck.blockedOver2d.map((issue): Draft => ({
      key: "waiting-on-you:blocked-live",
      context: { repo, number: issue.number, kind: "issue" },
      base: {
        id: `blocked-issue-${issue.number}`,
        signal: "blocked-on-human",
        title: issue.title,
        url: issue.url,
        observedValue: issue.ageDays,
        threshold: stuck.thresholds.blockedDays,
        thresholdLabel: `blocked ≥ ${stuck.thresholds.blockedDays}d`,
        crossedAt: crossedAtFrom(issue.createdAt, stuck.thresholds.blockedDays),
        dismissed: false,
      },
    })),
    ...stuck.needsInfoWaiting.map((issue): Draft => ({
      key: "waiting-on-you:needs-info",
      context: { repo, number: issue.number, kind: "issue" },
      base: {
        id: `needs-info-issue-${issue.number}`,
        signal: "blocked-on-human",
        title: issue.title,
        url: issue.url,
        observedValue: issue.ageDays,
        threshold: stuck.thresholds.needsInfoDays,
        thresholdLabel: `needs-info ≥ ${stuck.thresholds.needsInfoDays}d`,
        crossedAt: crossedAtFrom(issue.createdAt, stuck.thresholds.needsInfoDays),
        dismissed: false,
      },
    })),
    ...repetitionItems(friction).map((item): Draft => ({
      key: "repetition:hits",
      context: {},
      base: item,
    })),
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
    });
  }

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

  visible.sort(compareDrainOrder);

  const buckets: AttentionBucketSummary[] = BUCKETS.map((bucket, rank) => {
    if (UNWIRED_BUCKETS.has(bucket)) {
      return {
        rank,
        bucket,
        wired: false,
        count: 0,
        scanned: 0,
        sourcesOk: false,
        sourceErrors: ["not-wired"],
      };
    }
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
  const sourcesOk = buckets.filter((b) => b.wired).every((b) => b.sourcesOk);

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

  return { items: visible, buckets, scanned, sourcesOk };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ItemBase = Omit<AttentionFeedItem, "bucket" | "rank" | "key" | "action" | "subLines">;

interface Draft {
  key: string;
  context: ActionContext;
  base: ItemBase;
  subLines?: { key: string; line: string; detail: string }[];
}

/**
 * Per-line rendering of a rank-1 stalled PR (issue #4624). Ids: failed-required
 * keeps `pr-failed-ci-<n>` so existing 30-day dismissals survive; the new lines
 * use `pr-conflicted-<n>` / `pr-unshepherded-<n>`. crossedAt is the PR's
 * updatedAt (no transition timestamp is available).
 */
const STALLED_LINE_RENDER: Record<
  StalledPrLine,
  (pr: StalledPr) => Pick<ItemBase, "id" | "signal" | "observedValue" | "threshold" | "thresholdLabel">
> = {
  conflicted: (pr) => ({
    id: `pr-conflicted-${pr.number}`,
    signal: "breakage",
    observedValue: 1,
    threshold: 1,
    thresholdLabel: "mergeable = CONFLICTING",
  }),
  "failed-required": (pr) => ({
    id: `pr-failed-ci-${pr.number}`,
    signal: "breakage",
    observedValue: pr.failedChecks.length,
    threshold: 1,
    thresholdLabel: "≥ 1 failed required check",
  }),
  unshepherded: (pr) => ({
    id: `pr-unshepherded-${pr.number}`,
    signal: "blocked-on-human",
    observedValue: pr.requiredGreen,
    threshold: pr.requiredTotal,
    thresholdLabel: "required checks green, auto-merge unset",
  }),
};

function stalledPrDraft(pr: StalledPr, repo: string): Draft {
  return {
    key: `prs-not-landing:${pr.line}`,
    context: { repo, number: pr.number, kind: "pr" },
    base: {
      ...STALLED_LINE_RENDER[pr.line](pr),
      title: pr.title,
      url: pr.url,
      crossedAt: pr.updatedAt,
      dismissed: false,
    },
  };
}

/**
 * Run `fn` and settle it — a synchronous throw from an injected dep is
 * captured as a rejection too, so no source can escape the never-throw
 * contract.
 */
async function settle<T>(fn: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await fn() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function bucketOf(key: string): Bucket {
  return key.slice(0, key.indexOf(":")) as Bucket;
}

interface MachineStoppedRead {
  row: Draft | null;
  scanned: number;
  sourceErrors: string[];
}

/**
 * Read the four rank-0 lines, each independently settled. A rejected (or
 * UNKNOWN) read names itself in `sourceErrors` — it never reads as "not
 * stopped" (ADR-0034 §5.1/§5.2).
 */
async function readMachineStopped(
  deps: AttentionFeedDeps,
  nowDate: Date,
): Promise<MachineStoppedRead> {
  const readPaused = deps.readPaused ?? getAutopilotPaused;
  const readBlock = deps.readSessionBlockedUntil ?? (() => getSessionBlockedUntil(nowDate.getTime()));
  const readStop =
    deps.readSchedulerStopReason ?? (async () => (await getSchedulerStatus()).stopReason ?? null);
  const readDrift = deps.readShaDrift ?? (() => readDeployDrift());

  const [pausedR, blockR, stopR, driftR] = await Promise.all([
    settle(readPaused),
    settle(readBlock),
    settle(readStop),
    settle(readDrift),
  ]);

  const sourceErrors: string[] = [];
  let scanned = 0;
  const active = new Map<string, { detail: string; sinceMs: number | null }>();

  if (pausedR.status === "fulfilled") {
    scanned++;
    if (pausedR.value.paused) {
      const since = pausedR.value.since ?? null;
      active.set("paused", {
        detail: since !== null ? `autopilot paused since ${isoOrRaw(since)}` : "autopilot paused",
        sinceMs: since,
      });
    }
  } else {
    logRank0Failure("paused", pausedR.reason);
    sourceErrors.push("paused");
  }

  if (blockR.status === "fulfilled") {
    scanned++;
    if (blockR.value !== null) {
      active.set("session-blocked", {
        detail: `session blocked until ${isoOrRaw(blockR.value)}`,
        sinceMs: null,
      });
    }
  } else {
    logRank0Failure("session-block", blockR.reason);
    sourceErrors.push("session-block");
  }

  if (stopR.status === "fulfilled") {
    scanned++;
    if (stopR.value === "deliberate") {
      active.set("scheduler-deliberate", {
        detail: "scheduler stopped deliberately (stopReason=deliberate)",
        sinceMs: null,
      });
    }
  } else {
    logRank0Failure("scheduler", stopR.reason);
    sourceErrors.push("scheduler");
  }

  if (driftR.status === "fulfilled") {
    const d = driftR.value;
    if (d.deployedSha === null) sourceErrors.push("deployed-sha");
    if (d.originMasterSha === null) sourceErrors.push("origin-master-sha");
    if (d.deployedSha !== null && d.originMasterSha !== null) {
      scanned++;
      if (d.active) {
        active.set("sha-drift", {
          detail:
            `deployed ${d.deployedSha.slice(0, 8)} ≠ origin/master ${d.originMasterSha.slice(0, 8)} ` +
            `for ${d.driftSeconds ?? 0}s (≥ ${DEPLOY_DRIFT_GRACE_SECONDS}s)`,
          sinceMs: d.firstSeenMs,
        });
      }
    }
  } else {
    logRank0Failure("sha-drift", driftR.reason);
    sourceErrors.push("sha-drift");
  }

  // Active lines in BUCKET_LINES['machine-stopped'] order (most upstream first).
  const lines = BUCKET_LINES["machine-stopped"].filter((line) => active.has(line));
  if (lines.length === 0) return { row: null, scanned, sourceErrors };

  const subLines = lines.map((line) => ({
    key: `machine-stopped:${line}`,
    line,
    detail: active.get(line)!.detail,
  }));
  const sinceCandidates = lines
    .map((line) => active.get(line)!.sinceMs)
    .filter((ms): ms is number => ms !== null && Number.isFinite(ms));
  const crossedAt =
    sinceCandidates.length > 0
      ? new Date(Math.min(...sinceCandidates)).toISOString()
      : nowDate.toISOString();

  const row: Draft = {
    key: subLines[0].key,
    context: {},
    subLines,
    base: {
      // The §8.4 episode subject: the sorted set of active lines.
      id: `machine-stopped:${[...lines].sort().join(",")}`,
      signal: "blocked-on-human",
      title: `Machine stopped: ${lines.join(", ")}`,
      url: "/health",
      observedValue: lines.length,
      threshold: 1,
      thresholdLabel: `stopped: ${lines.join(", ")}`,
      crossedAt,
      dismissed: false,
    },
  };
  return { row, scanned, sourceErrors };
}

function logRank0Failure(source: string, reason: unknown): void {
  logger.error(
    { err: reason, source },
    "[attention] machine-stopped source read failed — rank 0 renders UNKNOWN",
  );
}

function isoOrRaw(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(ms);
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

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function substitute(template: string, context: ActionContext): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(context, name) ? String(context[name]) : match,
  );
}

function resolveTemplates(action: Action, context: ActionContext): Action {
  if (action.kind === "terminal-skill") {
    return { ...action, command: substitute(action.command, context) };
  }
  if (action.kind === "in-dashboard") {
    return { ...action, route: substitute(action.route, context) };
  }
  return { ...action };
}

function hasPlaceholder(action: Action): boolean {
  const field =
    action.kind === "terminal-skill"
      ? action.command
      : action.kind === "in-dashboard"
        ? action.route
        : "";
  return /\{[a-zA-Z0-9_]+\}/.test(field);
}

/**
 * Resolve the registry entry for `(key, variant)` — falling back to the
 * default (variant-less) entry — with `{repo}` / `{number}` / `{kind}`
 * substituted in `recommended` and both `alternatives` (ADR-0034 §8.2).
 * Returns null when no entry exists or a placeholder stays unresolved.
 */
export function resolveAction(
  key: string,
  variant: Variant | undefined,
  context: ActionContext,
  registry: readonly OperatorActionEntry[] = REGISTRY,
): OperatorActionEntry | null {
  const entry =
    (variant !== undefined
      ? registry.find((e) => e.key === key && e.variant === variant)
      : undefined) ?? registry.find((e) => e.key === key && e.variant === undefined);
  if (!entry) return null;
  const recommended = resolveTemplates(entry.recommended, context);
  const alternatives: [Action, Action] = [
    resolveTemplates(entry.alternatives[0], context),
    resolveTemplates(entry.alternatives[1], context),
  ];
  if ([recommended, alternatives[0], alternatives[1]].some(hasPlaceholder)) return null;
  return { ...entry, recommended, alternatives };
}

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
 * Pure helper — exported for tests. Lifts the repetition rows (hitCount ≥ the
 * cue's own escalation threshold, default PROMOTION_THRESHOLD — issue #4569)
 * out of a friction snapshot into the common item shape (before the bucket /
 * key / action fields the composer adds).
 * Deep-links to the escalation's GitHub issue when one has fired, else to the
 * Explore page's Friction tab (the current detail owner for un-escalated
 * patterns; /runs — ADR-0034's future home for this content — has not
 * shipped).
 */
export function repetitionItems(snapshot: FrictionPatternsSnapshot): ItemBase[] {
  const out: ItemBase[] = [];
  for (const group of snapshot.bySkill) {
    for (const pattern of group.patterns) {
      // Issue #4569: the line is the cue's OWN production escalation bar
      // (cue-policy.ts), defaulting to PROMOTION_THRESHOLD. A never-escalate
      // cue (Infinity — fires by design, #1789) therefore never surfaces.
      const threshold = escalationThresholdForCue(pattern.cue, PROMOTION_THRESHOLD);
      if (pattern.hitCount < threshold) continue;
      out.push({
        id: `friction-${encodeURIComponent(group.skill)}-${encodeURIComponent(pattern.cue)}`,
        signal: "repetition",
        title: `${group.skill}: ${pattern.cue}`,
        url: repetitionUrl(pattern),
        observedValue: pattern.hitCount,
        threshold,
        thresholdLabel: `hits ≥ ${threshold}`,
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
