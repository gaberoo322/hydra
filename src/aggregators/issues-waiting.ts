/**
 * Issues-waiting aggregator (issue #4625, ADR-0034 §8.1 ranks 2-3; admission
 * tightened by issue #4805).
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
 * - `stale-blocked`   — a non-Epic `blocked` issue with >= 1 blocker ref, all
 *                       of them closed, at any age.
 * - `blocked-live`    — a non-Epic `blocked` issue, age >= `blockedDays`, that
 *                       either references no blocker at all, or has >= 1 OPEN
 *                       blocker that is waiting on a human (or has no owner
 *                       label). A `blocked` issue whose every open blocker is
 *                       machine-owned is a dependency chain working as
 *                       designed and is NOT admitted.
 * - `needs-info`      — a non-Epic issue labelled `needs-info`, age >=
 *                       `needsInfoDays`.
 *
 * An Epic (own `## Sub-issues` section, or declared as the parent of another
 * row in hand) is never admitted to stale-blocked / blocked-live / needs-info;
 * an explicit human label (`reframe`, `ready-for-human`) still wins.
 *
 * Blocker refs come from `extractClearanceBlockerRefs` (the autopilot Phase 1.5
 * clearance refs, #4806) — no second parser. Open-blocker liveness AND labels
 * are ONE batched `fetchOpenBlockerRows` per repo; a lookup failure treats
 * every referenced blocker as OPEN with unknown owner, suppresses nothing, and
 * is named `blocker-lookup` in `sourceErrors`. The open-PR read (a blocker an
 * open PR closes is machine-owned) is lazy — issued at most once, only when an
 * open blocker is not already settled by its labels — and its failure is named
 * `open-pr-lookup`.
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
  declaresEpicChildren,
  extractClearanceBlockerRefs,
  extractDeclaredEpicRefs,
  fetchOpenBlockerRows,
} from "../github/blockers.ts";
import { listOpenPrs } from "../github/prs.ts";
import { closedIssues } from "../github/pr-refs.ts";
import { hasScopeSection } from "../scope-section.ts";
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
  /** Blocker refs found in the body (stale-blocked / blocked-live). */
  blockerNumbers: number[];
  /** Subset of `blockerNumbers` that are currently OPEN. */
  openBlockerNumbers: number[];
  /**
   * Open blockers waiting on a human (human label, or no owner label at all),
   * each with the reason to render (issue #4805). Empty for a row with no open
   * blocker, or when the blocker lookup failed.
   */
  humanBlockers: { number: number; reason: string }[];
  /** True iff the body carries a parseable `## Files in scope` section. */
  hasFilesInScope: boolean;
  /** True when the blocker lookup failed, so open blockers' owners are unknown. */
  blockerLookupFailed?: boolean;
}

/**
 * Open-blocker context for {@link classifyWaiting} (issue #4805). Absent =>
 * no machine-owned suppression (conservative).
 */
export interface BlockerContext {
  /** Labels of each OPEN blocker, from the one batched blocker read. */
  openBlockerLabels: ReadonlyMap<number, readonly string[]>;
  /** Issue numbers an open PR's body closes (lazy read; empty when not read). */
  prClosed: ReadonlySet<number>;
  /** False when the blocker lookup failed — owners are unknown. */
  lookupOk: boolean;
}

/** Labels meaning "this open blocker is waiting on a human". */
const HUMAN_LABELS = ["ready-for-human", "needs-info", "hitl-grill"] as const;
/** Labels meaning "a machine lane owns this open blocker". */
const MACHINE_LABELS = [
  "ready-for-agent",
  "needs-qa",
  "needs-dev-resume",
  "in-progress",
  "needs-triage",
  "needs-research",
  "needs-design-concept",
  "needs-tickets",
  // A `blocked` blocker is evaluated on its own feed row (no double-surfacing).
  "blocked",
] as const;

export interface IssuesWaitingResult {
  items: WaitingIssue[];
  /** Raw rows returned by the fulfilled label reads (proof the lookup ran). */
  scanned: number;
  sourcesOk: boolean;
  /** Named failed sources: a label, `blocker-lookup` and/or `open-pr-lookup`. */
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
  /** Open-PR reader (lazy; needs the `body` field). Tests inject a stub. */
  listOpenPrs?: typeof listOpenPrs;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Minimal `gh pr list --json` field set for the lazy closes-ref read. */
const PR_BODY_FIELDS = "number,title,url,updatedAt,headRefName,body";

function hasAny(labels: readonly string[], set: readonly string[]): boolean {
  return set.some((l) => labels.includes(l));
}

/**
 * Pure — the Epics among the rows in hand (issue #4805): an issue whose own
 * body declares `## Sub-issues` children, or that any row in hand declares as
 * its parent (`## Parent` / `Parent: #N` / `Child of #N`).
 */
export function epicNumbers(
  byLabel: ReadonlyMap<string, readonly IssueRow[]>,
): Set<number> {
  const out = new Set<number>();
  for (const list of byLabel.values()) {
    for (const row of list) {
      if (declaresEpicChildren(row.body)) out.add(row.number);
      for (const n of extractDeclaredEpicRefs(row.body)) out.add(n);
    }
  }
  return out;
}

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

  // One batched open-blocker lookup over the union of clearance refs of the
  // non-Epic `blocked` rows (Epics are never admitted, so never looked up).
  const blocked = byLabel.get("blocked") ?? [];
  const epics = epicNumbers(byLabel);
  const refUnion = [
    ...new Set(
      blocked
        .filter((row) => !epics.has(row.number))
        .flatMap((row) => extractClearanceBlockerRefs(row.body, row.number)),
    ),
  ];
  let lookupOk = true;
  const openBlockerLabels = new Map<number, readonly string[]>();
  try {
    const res = await fetchOpenBlockerRows(refUnion, {
      githubRepo: deps.githubRepo,
      listIssuesBySearch: search,
    });
    if (res.ok) {
      for (const r of res.rows) openBlockerLabels.set(r.number, r.labels);
    } else {
      lookupOk = false;
    }
  } catch (err) {
    logger.error({ err }, "[issues-waiting] blocker lookup threw — treating every blocker as open");
    lookupOk = false;
  }
  if (!lookupOk) sourceErrors.push("blocker-lookup");
  // Fail-safe: on lookup failure every referenced blocker is OPEN, owner unknown.
  const openBlockers: ReadonlySet<number> = lookupOk
    ? new Set(openBlockerLabels.keys())
    : new Set(refUnion);

  // Lazy open-PR read: only when some open blocker is not already settled by
  // its labels (a human or machine label decides it without a PR).
  let prClosed: ReadonlySet<number> = new Set();
  const needsPrRead =
    lookupOk &&
    [...openBlockerLabels.values()].some(
      (l) => !hasAny(l, HUMAN_LABELS) && !hasAny(l, MACHINE_LABELS),
    );
  if (needsPrRead) {
    try {
      const read = deps.listOpenPrs ?? listOpenPrs;
      const res = await read({ repo: deps.githubRepo, fields: PR_BODY_FIELDS });
      if (isIssueReadFailure(res)) {
        logger.error(
          { code: res.code },
          "[issues-waiting] open-PR read failed — no blocker treated PR-owned",
        );
        sourceErrors.push("open-pr-lookup");
      } else {
        prClosed = closedIssues(res.rows);
      }
    } catch (err) {
      logger.error({ err }, "[issues-waiting] open-PR read threw — no blocker treated PR-owned");
      sourceErrors.push("open-pr-lookup");
    }
  }

  const items = classifyWaiting(byLabel, openBlockers, now, thresholds, {
    openBlockerLabels,
    prClosed,
    lookupOk,
  });
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
 * admitting line only; output is sorted oldest-first. `blockerCtx` is optional:
 * absent, no machine-owned suppression is applied (conservative).
 */
export function classifyWaiting(
  byLabel: ReadonlyMap<string, readonly IssueRow[]>,
  openBlockers: ReadonlySet<number>,
  now: Date,
  thresholds: StuckThresholds = DEFAULT_THRESHOLDS,
  blockerCtx?: BlockerContext,
): WaitingIssue[] {
  const rows = new Map<number, IssueRow>();
  for (const list of byLabel.values()) {
    for (const row of list) if (!rows.has(row.number)) rows.set(row.number, row);
  }
  const has = (label: string, n: number) =>
    (byLabel.get(label) ?? []).some((r) => r.number === n);
  const epics = epicNumbers(byLabel);

  const out: WaitingIssue[] = [];
  for (const row of rows.values()) {
    const createdMs = Date.parse(row.createdAt);
    const ageDays = Number.isFinite(createdMs)
      ? Math.max(0, Math.floor((now.getTime() - createdMs) / DAY_MS))
      : 0;
    const old = (minDays: number) =>
      Number.isFinite(createdMs) && now.getTime() - createdMs >= minDays * DAY_MS;
    const isEpic = epics.has(row.number);
    const refs = extractClearanceBlockerRefs(row.body, row.number);
    const liveRefs = refs.filter((n) => openBlockers.has(n));

    // Open blockers waiting on a human, and whether EVERY open blocker is
    // machine-owned (=> the dependency chain is working; not admitted).
    const humanBlockers: { number: number; reason: string }[] = [];
    let allMachineOwned = false;
    const lookupFailed = blockerCtx !== undefined && !blockerCtx.lookupOk;
    if (blockerCtx !== undefined && blockerCtx.lookupOk && liveRefs.length > 0) {
      allMachineOwned = true;
      for (const n of liveRefs) {
        const labels = blockerCtx.openBlockerLabels.get(n) ?? [];
        const human = HUMAN_LABELS.find((l) => labels.includes(l));
        if (human) {
          humanBlockers.push({ number: n, reason: human });
          allMachineOwned = false;
        } else if (hasAny(labels, MACHINE_LABELS) || blockerCtx.prClosed.has(n)) {
          // machine-owned: contributes nothing to humanBlockers
        } else {
          humanBlockers.push({ number: n, reason: "no owner label" });
          allMachineOwned = false;
        }
      }
    }

    let line: WaitingLine | null = null;
    if (has("reframe", row.number)) line = "reframe";
    else if (has("ready-for-human", row.number)) line = "ready-for-human";
    else if (isEpic) line = null;
    else if (has("blocked", row.number) && refs.length > 0 && liveRefs.length === 0) {
      line = "stale-blocked";
    } else if (has("blocked", row.number) && !allMachineOwned && old(thresholds.blockedDays)) {
      line = "blocked-live";
    } else if (has("needs-info", row.number) && old(thresholds.needsInfoDays)) {
      line = "needs-info";
    }
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
      humanBlockers,
      hasFilesInScope: hasScopeSection(row.body ?? ""),
      ...(lookupFailed ? { blockerLookupFailed: true } : {}),
    });
  }
  out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  return out;
}
