/**
 * Rank 1 `prs-not-landing` lines (issue #4624): one draft per open non-draft
 * PR from src/aggregators/stalled-prs.ts. Extracted from src/attention.ts
 * (issue #5615).
 */

import {
  getStalledPrs,
  type StalledPr,
  type StalledPrLine,
  type StalledPrsDeps,
  type StalledPrsResult,
} from "../aggregators/stalled-prs.ts";
import { settledOr } from "../settled-fold.ts";
import { settle, type BucketRead, type Draft, type ItemBase } from "./draft.ts";

/** Rank-1 injection slice (see AttentionFeedDeps). */
export interface StalledPrsBucketDeps {
  /** Override the rank-1 stalled-PRs aggregator (issue #4624). Tests inject a stub. */
  getStalledPrs?: (deps?: StalledPrsDeps) => Promise<StalledPrsResult>;
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
 * Rank 1: scanned = open PR rows the fetch returned (proof the lookup ran),
 * NOT the admitted count; its named source errors (pr-list /
 * required-contexts) render the bucket UNKNOWN.
 */
export async function readStalledPrs(deps: StalledPrsBucketDeps, repo: string): Promise<BucketRead> {
  const stalledFn = deps.getStalledPrs ?? getStalledPrs;
  const stalledResult = await settle(() => stalledFn({ githubRepo: repo }));
  const stalled = settledOr<StalledPrsResult>(
    stalledResult,
    { items: [], scanned: 0, sourcesOk: false, sourceErrors: ["stalled-prs"] },
    "attention/stalled-prs",
  );
  const sourceErrors = [...stalled.sourceErrors];
  if (!stalled.sourcesOk && stalled.sourceErrors.length === 0) sourceErrors.push("stalled-prs");
  return {
    drafts: stalled.items.map((pr) => stalledPrDraft(pr, repo)),
    scanned: stalled.scanned,
    sourceErrors,
  };
}
