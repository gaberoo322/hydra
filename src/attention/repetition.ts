/**
 * Rank 4 `repetition` line: friction patterns at or over the cue's own
 * escalation bar. Extracted from src/attention.ts (issue #5615).
 */

import {
  getFrictionPatterns,
  type FrictionPatternsDeps,
  type FrictionPatternsSnapshot,
  type FrictionPatternRow,
} from "../aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD, escalationThresholdForCue } from "../pattern-memory/index.ts";
import { settledOr } from "../settled-fold.ts";
import { settle, type BucketRead, type ItemBase } from "./draft.ts";

/** Rank-4 injection slice (see AttentionFeedDeps). */
export interface RepetitionBucketDeps {
  /** Override the friction-patterns aggregator. Tests inject a stub. */
  getFrictionPatterns?: (deps?: FrictionPatternsDeps) => Promise<FrictionPatternsSnapshot>;
}

/** Rank 4: a rejected or not-ok friction read names `friction-patterns`. */
export async function readRepetition(
  deps: RepetitionBucketDeps,
  aggregatorDeps: FrictionPatternsDeps,
  nowDate: Date,
): Promise<BucketRead> {
  const frictionFn = deps.getFrictionPatterns ?? getFrictionPatterns;
  const frictionResult = await settle(() => frictionFn(aggregatorDeps));
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
  const friction = settledOr(frictionResult, emptyFriction(), "attention/friction-patterns");
  return {
    drafts: repetitionItems(friction).map((item) => ({
      key: "repetition:hits",
      context: {},
      base: item,
    })),
    scanned: friction.scanned,
    sourceErrors:
      frictionResult.status === "rejected" || !friction.sourcesOk ? ["friction-patterns"] : [],
  };
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
