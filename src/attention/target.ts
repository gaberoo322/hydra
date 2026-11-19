/**
 * Rank 3 `target-items` lines (issue #4625): the rank-2 issue lines read
 * against the ONE configured Target repo, plus `reframe` and the `archived`
 * aggregate row. The repo comes from getTargetGithubRepo(), never a literal.
 * Extracted from src/attention.ts (issue #5615).
 */

import {
  getIssuesWaiting,
  type IssuesWaitingDeps,
  type IssuesWaitingResult,
} from "../aggregators/issues-waiting.ts";
import { getRepoArchivedOrNull } from "../github/repo.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import {
  listDispatchOutcomes,
  type DispatchOutcomeListResult,
} from "../redis/dispatch-outcomes.ts";
import { bucketCycleStatus } from "../autopilot/cycle-status.ts";
import { logger } from "../logger.ts";
import type { BucketRead } from "./draft.ts";
import { REFRAME_WINDOW_MS, waitingDraft, type ReframeAttempts } from "./waiting.ts";

/** Rank-3 injection slice (see AttentionFeedDeps). */
export interface TargetBucketDeps {
  /** Override the rank-3 issues-waiting read against the Target repo. Defaults to the same aggregator. */
  getTargetIssuesWaiting?: (deps?: IssuesWaitingDeps) => Promise<IssuesWaitingResult>;
  /** The configured Target repo. Defaults to `getTargetGithubRepo()` (src/target-config.ts). */
  targetGithubRepo?: string;
  /** Is the Target repo archived? `null` = UNKNOWN. Default: src/github/repo.ts. */
  readTargetRepoArchived?: (repo: string) => Promise<boolean | null>;
  /** Dispatch-outcome window read for the reframe attempt count. Default: src/redis/dispatch-outcomes.ts. */
  listDispatchOutcomes?: (opts: { sinceMs: number }) => Promise<DispatchOutcomeListResult>;
}

/**
 * Rank 3 (issue #4625): read the ONE configured Target repo. Archived or unset
 * => exactly one aggregate `target-items:archived` row (sourcesOk, scanned 1,
 * no per-issue reads). A null (UNKNOWN) archived read still runs the issue
 * reads but names `target-repo-metadata`. Never throws.
 */
export async function readTargetItems(deps: TargetBucketDeps, nowDate: Date): Promise<BucketRead> {
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
  deps: TargetBucketDeps,
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
      // The row reads "failed 2+ times": count failed attempts only.
      if (bucketCycleStatus(rec.outcome) !== "failed") continue;
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
