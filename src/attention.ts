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

import { DEFAULT_THRESHOLDS } from "./aggregators/stuck-items.ts";
import {
  getIssuesWaiting,
  type IssuesWaitingDeps,
  type IssuesWaitingResult,
  type WaitingIssue,
} from "./aggregators/issues-waiting.ts";
import { getRepoArchivedOrNull } from "./github/repo.ts";
import { getTargetGithubRepo } from "./target-config.ts";
import {
  listDispatchOutcomes,
  type DispatchOutcomeListResult,
} from "./redis/dispatch-outcomes.ts";
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
  /** Override the rank-2 issues-waiting aggregator (issue #4625). Tests inject a stub. */
  getIssuesWaiting?: (deps?: IssuesWaitingDeps) => Promise<IssuesWaitingResult>;
  /** Override the rank-3 issues-waiting read against the Target repo. Defaults to the same aggregator. */
  getTargetIssuesWaiting?: (deps?: IssuesWaitingDeps) => Promise<IssuesWaitingResult>;
  /** The configured Target repo. Defaults to `getTargetGithubRepo()` (src/target-config.ts). */
  targetGithubRepo?: string;
  /** Is the Target repo archived? `null` = UNKNOWN. Default: src/github/repo.ts. */
  readTargetRepoArchived?: (repo: string) => Promise<boolean | null>;
  /** Dispatch-outcome window read for the reframe attempt count. Default: src/redis/dispatch-outcomes.ts. */
  listDispatchOutcomes?: (opts: { sinceMs: number }) => Promise<DispatchOutcomeListResult>;
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

/** Buckets with no source in this slice (#4626 wires the last one). */
const UNWIRED_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>(["parked-over-cap"]);

const DEFAULT_REPO = "gaberoo322/hydra";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getAttentionFeed(
  deps: AttentionFeedDeps = {},
): Promise<AttentionFeedResult> {
  const waitingFn = deps.getIssuesWaiting ?? getIssuesWaiting;
  const stalledFn = deps.getStalledPrs ?? getStalledPrs;
  const frictionFn = deps.getFrictionPatterns ?? getFrictionPatterns;
  const loadDismissed = deps.loadDismissedIds ?? loadDismissedIds;
  const recordSurfaced = deps.recordSurfaced ?? recordSurfacedItems;
  const registry = deps.registry ?? REGISTRY;
  const repo = deps.githubRepo ?? DEFAULT_REPO;
  const nowDate = deps.now ?? new Date();

  const aggregatorDeps = { now: deps.now, githubRepo: deps.githubRepo };

  // Issue #4624 / #4625: rank 1 reads PRs through stalled-prs (ONE
  // `gh pr list`), and ranks 2-3 read issues through issues-waiting;
  // getStuckItems is no longer called from the feed (its /api/v2/today/stuck
  // response shape is unchanged).

  // Never throws — every source degrades independently.
  const [waitingResult, targetRead, stalledResult, frictionResult, machineStopped] =
    await Promise.all([
      settle(() => waitingFn({ ...aggregatorDeps, now: nowDate })),
      readTargetItems(deps, nowDate),
      settle(() => stalledFn({ githubRepo: repo })),
      settle(() => frictionFn(aggregatorDeps)),
      readMachineStopped(deps, nowDate),
    ]);

  const emptyWaiting = (): IssuesWaitingResult => ({
    items: [],
    scanned: 0,
    sourcesOk: false,
    sourceErrors: ["issues-waiting"],
    thresholds: DEFAULT_THRESHOLDS,
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

  const waiting = settledOr(waitingResult, emptyWaiting(), "attention/issues-waiting");
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

  // Rank 2: issues-waiting against the Orchestrator repo. A rejected source
  // names itself; a partial failure names the failed label / blocker-lookup.
  evidence.get("waiting-on-you")!.scanned = waiting.scanned;
  if (waitingResult.status === "rejected") note("waiting-on-you", "issues-waiting");
  for (const err of waiting.sourceErrors) note("waiting-on-you", err);
  if (!waiting.sourcesOk && waiting.sourceErrors.length === 0) {
    note("waiting-on-you", "issues-waiting");
  }

  // Rank 3: the configured Target (or the archived aggregate row).
  evidence.get("target-items")!.scanned = targetRead.scanned;
  for (const err of targetRead.sourceErrors) note("target-items", err);
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
    ...waiting.items.map((issue) =>
      waitingDraft(issue, "waiting-on-you", repo, waiting.thresholds, undefined),
    ),
    ...targetRead.drafts,
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** Dispatch-outcome window the reframe attempt count reads (the record TTL). */
const REFRAME_WINDOW_MS = 90 * DAY_MS;
/** A reframe is a Target build that failed 2+ times (the label's own definition). */
const REFRAME_THRESHOLD = 2;

interface ReframeAttempts {
  count: number;
  /** Newest matching record's cycle id, for the transcript deep link. */
  newestCycleId: string | null;
}

/**
 * Per-line rendering of a rank-2 / rank-3 issue (issue #4625). Rank-2 ids keep
 * `blocked-issue-<n>` / `needs-info-issue-<n>` (30-day dismissal continuity);
 * rank-3 ids are `target-<line>-issue-<n>` so equal issue numbers on the two
 * repos can never collide.
 */
function waitingDraft(
  issue: WaitingIssue,
  bucket: "waiting-on-you" | "target-items",
  repo: string,
  thresholds: { blockedDays: number; needsInfoDays: number },
  reframe: ReframeAttempts | null | undefined,
): Draft {
  const idPrefix = bucket === "target-items" ? "target-" : "";
  const idFor = (stem: string) => `${idPrefix}${stem}-issue-${issue.number}`;
  const common = {
    signal: "blocked-on-human" as const,
    title: issue.title,
    url: issue.url,
    dismissed: false,
  };
  let base: ItemBase;
  switch (issue.line) {
    case "blocked-live":
      base = {
        ...common,
        id: idFor("blocked"),
        observedValue: issue.ageDays,
        threshold: thresholds.blockedDays,
        thresholdLabel: `blocked ≥ ${thresholds.blockedDays}d`,
        crossedAt: crossedAtFrom(issue.createdAt, thresholds.blockedDays),
      };
      break;
    case "needs-info":
      base = {
        ...common,
        id: idFor("needs-info"),
        observedValue: issue.ageDays,
        threshold: thresholds.needsInfoDays,
        thresholdLabel: `needs-info ≥ ${thresholds.needsInfoDays}d`,
        crossedAt: crossedAtFrom(issue.createdAt, thresholds.needsInfoDays),
      };
      break;
    case "ready-for-human":
      base = {
        ...common,
        id: idFor("ready-for-human"),
        observedValue: 1,
        threshold: 1,
        thresholdLabel: "labelled ready-for-human",
        crossedAt: issue.createdAt,
      };
      break;
    case "stale-blocked":
      base = {
        ...common,
        id: idFor("stale-blocked"),
        observedValue: 1,
        threshold: 1,
        thresholdLabel: "labelled blocked, no open blocker",
        crossedAt: issue.createdAt,
      };
      break;
    case "reframe": {
      // undefined = the enrichment read failed; null = it ran, no record matched.
      let detail: string;
      let count = REFRAME_THRESHOLD;
      if (reframe === undefined) {
        detail = "attempt count unavailable";
      } else if (reframe === null || reframe.count === 0) {
        detail = "no dispatch record found for this issue";
      } else {
        count = reframe.count;
        detail =
          `${reframe.count} dev_target attempts` +
          (reframe.newestCycleId
            ? `; latest transcript /dispatch/${reframe.newestCycleId}/transcript`
            : "");
      }
      base = {
        ...common,
        id: idFor("reframe"),
        observedValue: count,
        threshold: REFRAME_THRESHOLD,
        thresholdLabel: `failed ${REFRAME_THRESHOLD}+ times`,
        crossedAt: issue.createdAt,
        detail,
      };
      break;
    }
  }
  return {
    key: `${bucket}:${issue.line}`,
    context: { repo, number: issue.number, kind: "issue" },
    base,
  };
}

interface TargetRead {
  drafts: Draft[];
  scanned: number;
  sourceErrors: string[];
}

/**
 * Rank 3 (issue #4625): read the ONE configured Target repo. Archived or unset
 * => exactly one aggregate `target-items:archived` row (sourcesOk, scanned 1,
 * no per-issue reads). A null (UNKNOWN) archived read still runs the issue
 * reads but names `target-repo-metadata`. Never throws.
 */
async function readTargetItems(deps: AttentionFeedDeps, nowDate: Date): Promise<TargetRead> {
  const targetRepo = deps.targetGithubRepo ?? getTargetGithubRepo();
  const readArchived = deps.readTargetRepoArchived ?? ((r: string) => getRepoArchivedOrNull(r));
  const waitingFn = deps.getTargetIssuesWaiting ?? getIssuesWaiting;
  const sourceErrors: string[] = [];

  let archived: boolean | null = null;
  if (targetRepo === "") {
    archived = true; // unset
  } else {
    try {
      archived = await readArchived(targetRepo);
    } catch (err) {
      logger.error({ err, repo: targetRepo }, "[attention] target repo archived read threw");
      archived = null;
    }
  }

  if (archived === true) {
    const label = targetRepo === "" ? "(unset)" : targetRepo;
    return {
      scanned: 1,
      sourceErrors,
      drafts: [
        {
          key: "target-items:archived",
          context: { repo: targetRepo },
          base: {
            id: `target-items:archived:${targetRepo}`,
            signal: "blocked-on-human",
            title: `Target ${label} archived — awaiting swap`,
            url: targetRepo === "" ? "/health" : `https://github.com/${targetRepo}`,
            observedValue: 1,
            threshold: 1,
            thresholdLabel: "configured Target is archived or unset",
            crossedAt: nowDate.toISOString(),
            dismissed: false,
            detail: "the configured Target repo is archived or unset; swap it (ADR-0013)",
          },
        },
      ],
    };
  }
  if (archived === null) sourceErrors.push("target-repo-metadata");

  let result: IssuesWaitingResult;
  try {
    result = await waitingFn({
      now: nowDate,
      githubRepo: targetRepo,
      includeReframe: true,
    });
  } catch (err) {
    logger.error({ err, repo: targetRepo }, "[attention] target issues-waiting read failed");
    sourceErrors.push("issues-waiting");
    return { drafts: [], scanned: 0, sourceErrors };
  }
  for (const e of result.sourceErrors) if (!sourceErrors.includes(e)) sourceErrors.push(e);
  if (!result.sourcesOk && result.sourceErrors.length === 0) sourceErrors.push("issues-waiting");

  // Reframe enrichment: one window read, only when a reframe row exists.
  // Failure keeps the row (admission source is the label) and never flips
  // sourcesOk.
  let attempts: Map<number, ReframeAttempts> | null = null;
  if (result.items.some((i) => i.line === "reframe")) {
    attempts = await readReframeAttempts(deps, nowDate);
  }

  return {
    scanned: result.scanned,
    sourceErrors,
    drafts: result.items.map((issue) =>
      waitingDraft(
        issue,
        "target-items",
        targetRepo,
        result.thresholds,
        issue.line === "reframe"
          ? attempts === null
            ? undefined
            : (attempts.get(issue.number) ?? null)
          : undefined,
      ),
    ),
  };
}

async function readReframeAttempts(
  deps: AttentionFeedDeps,
  nowDate: Date,
): Promise<Map<number, ReframeAttempts> | null> {
  const list = deps.listDispatchOutcomes ?? listDispatchOutcomes;
  try {
    const res = await list({ sinceMs: nowDate.getTime() - REFRAME_WINDOW_MS });
    if (res.ok === false) {
      logger.error({ error: res.error }, "[attention] reframe attempt-count read failed");
      return null;
    }
    const out = new Map<number, ReframeAttempts & { newestAt: number }>();
    for (const rec of res.records) {
      if (rec.className !== "dev_target") continue;
      const m = /^issue-(\d+)$/.exec(rec.anchorReference ?? "");
      if (!m) continue;
      const n = Number.parseInt(m[1], 10);
      const cur = out.get(n) ?? { count: 0, newestCycleId: null, newestAt: -1 };
      cur.count += 1;
      if (rec.recordedAt > cur.newestAt) {
        cur.newestAt = rec.recordedAt;
        cur.newestCycleId = rec.cycleId;
      }
      out.set(n, cur);
    }
    return out;
  } catch (err) {
    logger.error({ err }, "[attention] reframe attempt-count read threw");
    return null;
  }
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
