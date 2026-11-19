/**
 * Rank 2 `waiting-on-you` lines (issues #4625, #5313, #5316) and the shared
 * issue-row renderer the rank-3 Target bucket reuses (ADR-0034 §8.1: rank 3
 * is the rank-2 lines read against the Target). Extracted from
 * src/attention.ts (issue #5615).
 */

import { DEFAULT_THRESHOLDS } from "../aggregators/stuck-items.ts";
import {
  getIssuesWaiting,
  type IssuesWaitingDeps,
  type IssuesWaitingResult,
  type WaitingIssue,
} from "../aggregators/issues-waiting.ts";
import { resolveGithubRepo } from "../github/issues.ts";
import { HOLD_EXIT_ALERT_WINDOW_DAYS } from "../lifecycle/index.ts";
import { listHoldExits, readReconcileReport, type ListHoldExitsResult } from "../redis/lifecycle-journal.ts";
import { settledOr } from "../settled-fold.ts";
import { logger } from "../logger.ts";
import { settle, type BucketRead, type Draft, type ItemBase } from "./draft.ts";

/** Rank-2 injection slice (see AttentionFeedDeps). */
export interface WaitingBucketDeps {
  /** Override the rank-2 issues-waiting aggregator (issue #4625). Tests inject a stub. */
  getIssuesWaiting?: (deps?: IssuesWaitingDeps) => Promise<IssuesWaitingResult>;
  /**
   * Rank-2 `hold-exit` line read (ADR-0047 Decision 3, #5313): unsanctioned
   * human-hold exits journaled at or after `sinceMs`. Default:
   * src/redis/lifecycle-journal.ts listHoldExits.
   */
  readHoldExits?: (repo: string, sinceMs: number) => Promise<ListHoldExitsResult>;
  /**
   * `waiting-on-you:invalid-state` line read (issue #5316): the persisted
   * lifecycle reconcile report, composed from ONE Redis read and zero gh
   * calls. Default: src/redis/lifecycle-journal.ts readReconcileReport().
   */
  readLifecycleReconcile?: () => Promise<InvalidStateRead>;
}

/** The slice of the persisted reconcile report the `invalid-state` line composes from. */
export type InvalidStateRead =
  | { ok: true; ts: number | null; invalid: Array<{ number: number; labels: string[] }> }
  | { ok: false };

/** The `invalid-state` line is healthy only while the report is younger than this (3h). */
export const INVALID_STATE_REPORT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

async function readLifecycleReconcileDefault(): Promise<InvalidStateRead> {
  const res = await readReconcileReport(resolveGithubRepo());
  if (res.ok === false) return { ok: false };
  const raw = res.report?.invalid;
  const invalid = Array.isArray(raw)
    ? raw.flatMap((r) => {
        const row = r as { number?: unknown; labels?: unknown } | null;
        return row && typeof row.number === "number" && Array.isArray(row.labels)
          ? [{ number: row.number, labels: row.labels.map(String) }]
          : [];
      })
    : [];
  return { ok: true, ts: res.report === null ? null : res.ts, invalid };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Dispatch-outcome window the reframe attempt count reads (the record TTL). */
export const REFRAME_WINDOW_MS = 90 * DAY_MS;
/** A reframe is a Target build that failed 2+ times (the label's own definition). */
const REFRAME_THRESHOLD = 2;

export interface ReframeAttempts {
  count: number;
  /** Newest matching record's cycle id, for the transcript deep link. */
  newestCycleId: string | null;
}

/** Human-readable blocker state for a blocked / stale-blocked issue row. */
function blockerDetail(issue: WaitingIssue): string {
  const open = issue.openBlockerNumbers;
  if (issue.line === "blocked-live") {
    if (issue.blockerLookupFailed && open.length > 0) {
      return open
        .map((n) => `blocked by #${n} (state unknown — blocker lookup failed)`)
        .join(", ");
    }
    if (issue.humanBlockers.length > 0) {
      return issue.humanBlockers.map((b) => `blocked on #${b.number} (${b.reason})`).join(", ");
    }
  }
  if (open.length > 0) return `blocked by ${open.map((n) => `#${n} (open)`).join(", ")}`;
  if (issue.blockerNumbers.length > 0) {
    const closed = `no open blocker (refs ${issue.blockerNumbers.map((n) => `#${n}`).join(", ")} are closed)`;
    return issue.hasFilesInScope
      ? closed
      : `${closed}; add a ## Files in scope section before relabelling`;
  }
  return "labelled blocked, no blocker referenced in the body";
}

/**
 * Per-line rendering of a rank-2 / rank-3 issue (issue #4625). Rank-2 ids keep
 * `blocked-issue-<n>` (blocked-live) / `needs-info-issue-<n>` (30-day
 * dismissal continuity); stale-blocked is `stale-blocked-issue-<n>`. Rank-3 ids
 * are `target-<line>-issue-<n>`, so equal issue numbers on the two repos can
 * never collide.
 */
export function waitingDraft(
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
        detail: blockerDetail(issue),
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
        // Own id (INV-7): dismissing a blocked-live row must not hide the
        // later stale-blocked signal for the same issue.
        id: idFor("stale-blocked"),
        observedValue: 1,
        threshold: 1,
        thresholdLabel: "labelled blocked, no open blocker",
        crossedAt: issue.createdAt,
        detail: blockerDetail(issue),
      };
      break;
    case "reframe": {
      // undefined = the enrichment read failed; null = it ran, no record matched.
      let detail: string;
      let count = REFRAME_THRESHOLD; // INV-8: no/unknown record => the threshold (the label's own definition)
      if (reframe === undefined) {
        detail = "attempt count unavailable";
      } else if (reframe === null || reframe.count === 0) {
        detail = "no dispatch record found for this issue";
      } else {
        count = reframe.count;
        detail =
          `${reframe.count} dev_target attempt${reframe.count === 1 ? "" : "s"}` +
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

interface HoldExitRead {
  drafts: Draft[];
  scanned: number;
  failed: boolean;
}

/**
 * Rank 2 `hold-exit` (ADR-0047 Decision 3, #5313): ONE draft per issue — its
 * latest unsanctioned human-hold exit. The id carries the exit timestamp so a
 * later exit is a new episode a prior dismissal cannot hide. No gh call: the
 * url is built from repo + number.
 */
function readHoldExitDrafts(
  result: PromiseSettledResult<ListHoldExitsResult>,
  repo: string,
): HoldExitRead {
  if (result.status === "rejected") {
    logger.error({ err: result.reason }, "[attention] hold-exit read threw");
    return { drafts: [], scanned: 0, failed: true };
  }
  const read = result.value;
  if (read.ok !== true) {
    logger.error({ error: read.error }, "[attention] hold-exit read failed");
    return { drafts: [], scanned: 0, failed: true };
  }
  const latest = new Map<number, (typeof read.exits)[number]>();
  for (const exit of read.exits) {
    const prior = latest.get(exit.issue);
    if (prior === undefined || exit.ts >= prior.ts) latest.set(exit.issue, exit);
  }
  const drafts = [...latest.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((exit): Draft => ({
      key: "waiting-on-you:hold-exit",
      context: { repo, number: exit.issue, kind: "issue" },
      base: {
        id: `hold-exit-issue-${exit.issue}-${exit.ts}`,
        signal: "blocked-on-human",
        title: `#${exit.issue} left ${exit.from ?? "(unknown)"} via ${exit.source}`,
        url: `https://github.com/${repo}/issues/${exit.issue}`,
        dismissed: false,
        observedValue: 1,
        threshold: 1,
        thresholdLabel: "human-hold exit outside operator-route",
        crossedAt: new Date(exit.ts).toISOString(),
      },
    }));
  return { drafts, scanned: read.exits.length, failed: false };
}

/**
 * `waiting-on-you:invalid-state` (issue #5316): one item per open issue the
 * reconcile found with 2+ lifecycle state labels. Composed from the persisted
 * report alone, so there is no gh call at compose time.
 */
function invalidStateDraft(
  row: { number: number; labels: string[] },
  repo: string,
  reportTs: number,
): Draft {
  return {
    key: "waiting-on-you:invalid-state",
    context: { repo, number: row.number, kind: "issue" },
    base: {
      id: `invalid-state-issue-${row.number}`,
      signal: "blocked-on-human",
      title: `Issue #${row.number} carries ${row.labels.length} lifecycle state labels`,
      url: `https://github.com/${repo}/issues/${row.number}`,
      dismissed: false,
      observedValue: row.labels.length,
      threshold: 2,
      thresholdLabel: "2+ lifecycle state labels",
      crossedAt: new Date(reportTs).toISOString(),
      detail: row.labels.join(", "),
    },
  };
}

/**
 * Rank 2 `waiting-on-you`: issues-waiting against the Orchestrator repo plus
 * the `hold-exit` line. A rejected source names itself; a partial failure
 * names the failed label / blocker-lookup. `scanned` is the SUM of the
 * issues-waiting and hold-exit reads.
 */
export async function readWaiting(
  deps: WaitingBucketDeps,
  ctx: { repo: string; now: Date; githubRepo?: string },
): Promise<BucketRead> {
  const waitingFn = deps.getIssuesWaiting ?? getIssuesWaiting;
  const readHoldExits = deps.readHoldExits ?? listHoldExits;
  const holdSinceMs = ctx.now.getTime() - HOLD_EXIT_ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const [waitingResult, holdExitResult] = await Promise.all([
    settle(() => waitingFn({ githubRepo: ctx.githubRepo, now: ctx.now })),
    settle(() => readHoldExits(ctx.repo, holdSinceMs)),
  ]);
  const emptyWaiting = (): IssuesWaitingResult => ({
    items: [],
    scanned: 0,
    sourcesOk: false,
    sourceErrors: ["issues-waiting"],
    thresholds: DEFAULT_THRESHOLDS,
  });
  const waiting = settledOr(waitingResult, emptyWaiting(), "attention/issues-waiting");
  const sourceErrors: string[] = [];
  const note = (e: string) => {
    if (!sourceErrors.includes(e)) sourceErrors.push(e);
  };
  if (waitingResult.status === "rejected") note("issues-waiting");
  for (const err of waiting.sourceErrors) note(err);
  if (!waiting.sourcesOk && waiting.sourceErrors.length === 0) note("issues-waiting");

  // `hold-exit` (#5313): a failed read names `hold-exits` (bucket UNKNOWN),
  // never an asserted zero.
  const holdExits = readHoldExitDrafts(holdExitResult, ctx.repo);
  if (holdExits.failed) note("hold-exits");

  return {
    drafts: [
      ...waiting.items.map((issue) =>
        waitingDraft(issue, "waiting-on-you", ctx.repo, waiting.thresholds, undefined),
      ),
      ...holdExits.drafts,
    ],
    scanned: waiting.scanned + holdExits.scanned,
    sourceErrors,
  };
}

/**
 * `waiting-on-you:invalid-state` (issue #5316) read. `fresh` is true only
 * while the persisted report exists and is younger than
 * INVALID_STATE_REPORT_MAX_AGE_MS; the composer ANDs it into the line's
 * `healthy` flag. A failed read adds no sourceError (the line just reads
 * unhealthy through `fresh`), matching the pre-split behaviour.
 */
export async function readInvalidState(
  deps: WaitingBucketDeps,
  repo: string,
  now: Date,
): Promise<BucketRead & { fresh: boolean }> {
  const invalidResult = await settle(deps.readLifecycleReconcile ?? readLifecycleReconcileDefault);
  const invalidRead: InvalidStateRead =
    invalidResult.status === "fulfilled" ? invalidResult.value : { ok: false };
  const fresh =
    invalidRead.ok &&
    invalidRead.ts !== null &&
    now.getTime() - invalidRead.ts < INVALID_STATE_REPORT_MAX_AGE_MS;
  return {
    drafts:
      invalidRead.ok && fresh
        ? invalidRead.invalid.map((row) => invalidStateDraft(row, repo, invalidRead.ts as number))
        : [],
    scanned: 0,
    sourceErrors: [],
    fresh,
  };
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
