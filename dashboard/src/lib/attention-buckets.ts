/**
 * Pure bucket derivation for the Today attention feed (issue #4628,
 * ADR-0034 §5.2/§8.1). Extracted from AttentionFeed.jsx so the trust rules
 * are unit-tested behaviourally (test/operator-actions-affordance.test.mts)
 * — the dashboard ships no JSX test runner.
 *
 * The rules:
 *   - every bucket the client knows (`knownBuckets`, the BUCKET_WHY keys)
 *     that the payload did NOT summarise becomes a synthetic UNKNOWN
 *     section — never a quiet omission;
 *   - `rendered` is only the items that land in a PROVED (wired +
 *     sourcesOk) bucket — the header count never counts hidden items;
 *   - `orphaned` is the items whose bucket has no section at all — surfaced
 *     by the feed, never silently dropped;
 *   - a payload that is present but carries no bucket summaries is
 *     `malformed` — neither an all-clear nor a list.
 */

export interface BucketSummary {
  bucket: string;
  rank: number | string;
  count: number | string;
  wired: boolean;
  sourcesOk: boolean;
  sourceErrors: string[];
}

export interface FeedItemLike {
  bucket: string;
}

export interface DerivedFeed<I extends FeedItemLike> {
  buckets: BucketSummary[];
  rendered: I[];
  orphaned: I[];
  malformed: boolean;
}

export function deriveFeedBuckets<I extends FeedItemLike>(
  data: { buckets?: unknown } | null | undefined,
  items: readonly I[],
  knownBuckets: readonly string[],
): DerivedFeed<I> {
  const reported: BucketSummary[] = Array.isArray(data?.buckets) ? (data.buckets as BucketSummary[]) : [];
  const missing = data ? knownBuckets.filter((k) => !reported.some((b) => b.bucket === k)) : [];
  const buckets: BucketSummary[] = [
    ...reported,
    ...missing.map((bucket) => ({
      bucket,
      rank: "?",
      count: "?",
      wired: false,
      sourcesOk: false,
      sourceErrors: ["no summary in payload"],
    })),
  ];
  const proved = new Set(buckets.filter((b) => b.wired && b.sourcesOk).map((b) => b.bucket));
  const sectioned = new Set(buckets.map((b) => b.bucket));
  return {
    buckets,
    rendered: items.filter((item) => proved.has(item.bucket)),
    orphaned: items.filter((item) => !sectioned.has(item.bucket)),
    malformed: Boolean(data) && reported.length === 0,
  };
}

/** Per-item dismiss outcome lines, keyed by item id (QA round 4, PR #4976). */
export type DismissOutcomes = Record<string, string>;

export type DismissResult =
  | { ok: false; error: unknown }
  | { ok: true; reread: boolean };

/**
 * Fold one dismiss outcome into the per-item map — pure, so the feed's
 * banner rules are unit-tested behaviourally:
 *   - a failure records `<title>: dismiss failed — <message>` under THAT
 *     item's id; another item's attempt never clears it;
 *   - a success clears that item's entry — unless the post-dismiss feed
 *     re-read FAILED, which is named (never a silent stale list).
 */
export function recordDismissOutcome(
  prev: DismissOutcomes,
  item: { id: string; title: string },
  result: DismissResult,
): DismissOutcomes {
  const next = { ...prev };
  if ("error" in result) {
    const err = result.error as { message?: string } | null | undefined;
    next[item.id] = `${item.title}: dismiss failed — ${err?.message ?? String(result.error)}`;
  } else if (result.ok && result.reread === false) {
    next[item.id] = `${item.title}: dismissed · feed re-read FAILED — list may be stale`;
  } else {
    delete next[item.id];
  }
  return next;
}
