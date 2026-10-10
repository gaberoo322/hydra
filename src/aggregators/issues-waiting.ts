/**
 * Issues-waiting aggregator (issue #4625, ADR-0034 §8.1 ranks 2-3).
 *
 * One repo-parameterised classifier behind BOTH the "Issues waiting on you"
 * bucket (the Orchestrator repo) and the "Target items" bucket (the one
 * configured Target repo, plus the `reframe` line). One issue is admitted to
 * AT MOST ONE line, by precedence:
 *
 *   reframe > ready-for-human > stale-blocked > blocked-live > needs-info
 *
 * - `reframe`         — labelled `reframe` (only when `includeReframe`).
 * - `ready-for-human` — labelled `ready-for-human` (presence).
 * - `stale-blocked`   — labelled `blocked` with ZERO open strict blocker refs
 *                       (none referenced, or all referenced are closed), at
 *                       any age.
 * - `blocked-live`    — labelled `blocked` with >= 1 OPEN strict blocker AND
 *                       age >= `blockedDays`.
 * - `needs-info`      — labelled `needs-info`, age >= `needsInfoDays`.
 *
 * Blocker refs use the STRICT predicate (`extractStrictBlockerRefs`), never the
 * loose `extractIssueRefs`, so a `Part of #N` mention never hides a stale row.
 * Liveness is ONE batched `fetchOpenBlockerNumbers` per repo; its fail-safe
 * (lookup failure => every referenced blocker treated OPEN) is reused, and the
 * failure is named `blocker-lookup` in `sourceErrors`.
 *
 * Never throws; imports only `src/github/*`, and the two threshold exports of
 * stuck-items.ts (no Redis).
 */

import {
  isIssueReadFailure,
  listIssuesByLabel,
  listIssuesBySearch,
  type IssueRow,
} from "../github/issues.ts";
import {
  extractStrictBlockerRefs,
  fetchOpenBlockerNumbers,
} from "../github/blockers.ts";
import { DEFAULT_THRESHOLDS, type StuckThresholds } from "./stuck-items.ts";
import { logger } from "../logger.ts";

export type WaitingLine =
  | "reframe"
  | "ready-for-human"
  | "stale-blocked"
  | "blocked-live"
  | "needs-info";

export interface WaitingIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  ageDays: number;
  labels: string[];
  line: WaitingLine;
  /** Strict blocker refs found in the body (stale-blocked / blocked-live). */
  blockerNumbers: number[];
  /** Subset of `blockerNumbers` that are currently OPEN. */
  openBlockerNumbers: number[];
}

export interface IssuesWaitingResult {
  items: WaitingIssue[];
  /** Raw rows returned by the fulfilled label reads (proof the lookup ran). */
  scanned: number;
  sourcesOk: boolean;
  /** Named failed sources: a label (`blocked`, ...) and/or `blocker-lookup`. */
  sourceErrors: string[];
  thresholds: StuckThresholds;
}

export interface IssuesWaitingDeps {
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to the seam default. */
  githubRepo?: string;
  /** Also read the `reframe` label (Target repo only). */
  includeReframe?: boolean;
  thresholds?: Partial<StuckThresholds>;
  listIssuesByLabel?: typeof listIssuesByLabel;
  listIssuesBySearch?: typeof listIssuesBySearch;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getIssuesWaiting(
  deps: IssuesWaitingDeps = {},
): Promise<IssuesWaitingResult> {
  const now = deps.now ?? new Date();
  const thresholds: StuckThresholds = { ...DEFAULT_THRESHOLDS, ...(deps.thresholds ?? {}) };
  const listByLabel = deps.listIssuesByLabel ?? listIssuesByLabel;
  const search = deps.listIssuesBySearch ?? listIssuesBySearch;
  const opts = { repo: deps.githubRepo };

  const labels = [
    ...(deps.includeReframe ? ["reframe"] : []),
    "ready-for-human",
    "blocked",
    "needs-info",
  ];

  const sourceErrors: string[] = [];
  let scanned = 0;
  const byLabel = new Map<string, IssueRow[]>();
  const reads = await Promise.all(
    labels.map(async (label) => {
      try {
        return { label, res: await listByLabel(label, opts) };
      } catch (err) {
        logger.error({ err, label }, "[issues-waiting] label read threw");
        return { label, res: null };
      }
    }),
  );
  for (const { label, res } of reads) {
    if (res === null) {
      sourceErrors.push(label);
      byLabel.set(label, []);
      continue;
    }
    if (isIssueReadFailure(res)) {
      logger.error({ label, code: res.code }, "[issues-waiting] label read failed");
      sourceErrors.push(label);
      byLabel.set(label, []);
      continue;
    }
    scanned += res.rows.length;
    byLabel.set(label, res.rows);
  }

  // One batched open-blocker lookup over the union of strict refs.
  const blocked = byLabel.get("blocked") ?? [];
  const refUnion = [
    ...new Set(blocked.flatMap((row) => extractStrictBlockerRefs(row.body))),
  ];
  let lookupFailed = false;
  let openBlockers = new Set<number>();
  try {
    openBlockers = await fetchOpenBlockerNumbers(refUnion, {
      githubRepo: deps.githubRepo,
      listIssuesBySearch: async (...args) => {
        const res = await search(...args);
        if (isIssueReadFailure(res)) lookupFailed = true;
        return res;
      },
    });
  } catch (err) {
    logger.error({ err }, "[issues-waiting] blocker lookup threw — treating every blocker as open");
    lookupFailed = true;
    openBlockers = new Set(refUnion);
  }
  if (lookupFailed) sourceErrors.push("blocker-lookup");

  const items = classifyWaiting(byLabel, openBlockers, now, thresholds);
  return {
    items,
    scanned,
    sourcesOk: sourceErrors.length === 0,
    sourceErrors,
    thresholds,
  };
}

/**
 * Pure classifier — exported for tests. `byLabel` maps each label read to its
 * rows (a label absent from the map was not read, e.g. `reframe` when
 * `includeReframe` is false). Each issue is admitted to its highest-precedence
 * admitting line only; output is sorted oldest-first.
 */
export function classifyWaiting(
  byLabel: ReadonlyMap<string, readonly IssueRow[]>,
  openBlockers: ReadonlySet<number>,
  now: Date,
  thresholds: StuckThresholds = DEFAULT_THRESHOLDS,
): WaitingIssue[] {
  const rows = new Map<number, IssueRow>();
  for (const list of byLabel.values()) {
    for (const row of list) if (!rows.has(row.number)) rows.set(row.number, row);
  }
  const has = (label: string, n: number) =>
    (byLabel.get(label) ?? []).some((r) => r.number === n);

  const out: WaitingIssue[] = [];
  for (const row of rows.values()) {
    const createdMs = Date.parse(row.createdAt);
    const ageDays = Number.isFinite(createdMs)
      ? Math.max(0, Math.floor((now.getTime() - createdMs) / DAY_MS))
      : 0;
    const old = (minDays: number) =>
      Number.isFinite(createdMs) && now.getTime() - createdMs >= minDays * DAY_MS;
    const refs = extractStrictBlockerRefs(row.body);
    const liveRefs = refs.filter((n) => openBlockers.has(n));

    let line: WaitingLine | null = null;
    if (has("reframe", row.number)) line = "reframe";
    else if (has("ready-for-human", row.number)) line = "ready-for-human";
    else if (has("blocked", row.number) && liveRefs.length === 0) line = "stale-blocked";
    else if (has("blocked", row.number) && old(thresholds.blockedDays)) line = "blocked-live";
    else if (has("needs-info", row.number) && old(thresholds.needsInfoDays)) line = "needs-info";
    if (line === null) continue;

    out.push({
      number: row.number,
      title: row.title,
      url: row.url,
      createdAt: row.createdAt,
      ageDays,
      labels: [...row.labels],
      line,
      blockerNumbers: refs,
      openBlockerNumbers: liveRefs,
    });
  }
  out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  return out;
}
