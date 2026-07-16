/**
 * fallback-scorer.ts — pure lexical-distance ranking for degraded knowledge
 * search (issue #3341).
 *
 * When OpenViking is unavailable (`isOvFailure` on the search result),
 * `trackedOvSearch` (ov-search.ts) degrades from semantic ranking to a lexical
 * ranking over the indexer's in-memory dedup corpus — the `path -> sha1` map
 * hydrated from `hydra:knowledge:source-hashes` at startup. This module owns
 * that ranking and NOTHING else:
 *
 *   PURE — no IO, no Redis, no fetch, no timers. Deterministic output for a
 *   given (query, paths) input, with a stable lexicographic tie-break on equal
 *   scores. The design-concept invariant for #3341 pins this purity; the
 *   corpus read stays behind `HashDedupAdapter.getIndexedPaths()` in
 *   hash-dedup.ts.
 *
 * SCORING SHAPE (prototype-validated in the #3341 design concept):
 * per-token normalized Levenshtein similarity, NOT raw whole-string
 * Levenshtein. The prototype showed whole-string distance is length-dominated
 * (it missed ov-search.ts on the query "openviking search fallback" and
 * tier-classifier.ts on "tier classification of PR paths"); per-token
 * normalized similarity ranked the plausible file top-1 on 4/4 queries.
 *
 *   - tokenize query and path on non-alphanumeric boundaries, lowercased,
 *     dropping tokens of length <= 2;
 *   - score each query token by its best `1 - distance/maxLen` similarity over
 *     the path's tokens;
 *   - average over the query tokens;
 *   - cap query tokens at {@link MAX_QUERY_TOKENS} for bounded cost.
 */

/**
 * Bounded-cost cap on the number of query tokens considered (the corpus can be
 * ranked against arbitrarily long degraded planner queries; ~8 tokens carries
 * the discriminating signal per the #3341 prototype).
 */
const MAX_QUERY_TOKENS = 8;

/** Tokens of length <= 2 ("ts", "of", "a") carry no ranking signal — drop them. */
const MIN_TOKEN_LENGTH = 3;

/** Lowercase, split on non-alphanumeric runs, drop short tokens. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

/**
 * Classic Levenshtein edit distance (two-row DP, O(|a|*|b|) time, O(|b|)
 * space). Internal — callers rank through {@link rankLexicalFallback}.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1, // deletion
        cur[j - 1] + 1, // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Normalized similarity in [0, 1]: `1 - distance / maxLen`. */
function tokenSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Score a path against an already-tokenized (and capped) query: each query
 * token contributes its best similarity over the path's tokens; the score is
 * the average over the query tokens. Range [0, 1].
 */
function scoreTokenized(queryTokens: string[], path: string): number {
  const pathTokens = tokenize(path);
  if (queryTokens.length === 0 || pathTokens.length === 0) return 0;
  let sum = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const p of pathTokens) {
      const sim = tokenSimilarity(q, p);
      if (sim > best) best = sim;
    }
    sum += best;
  }
  return sum / queryTokens.length;
}

/**
 * Per-token normalized Levenshtein score of a single (query, path) pair.
 * Pure and deterministic; exported for tests. Range [0, 1] — 0 when either
 * side tokenizes to nothing.
 */
export function lexicalPathScore(query: string, path: string): number {
  return scoreTokenized(tokenize(query).slice(0, MAX_QUERY_TOKENS), path);
}

/** A corpus path with its lexical relevance score, as ranked. */
export interface LexicalRankedPath {
  path: string;
  score: number;
}

/**
 * Rank `paths` against `query` by {@link lexicalPathScore}, descending, with a
 * stable lexicographic tie-break on the path for equal scores, returning at
 * most `limit` entries. Zero-score paths (no token overlap signal at all) are
 * dropped — under degradation, serving nothing beats serving pure noise.
 *
 * Pure: never throws on empty inputs — an empty query or empty corpus ranks to
 * `[]`, which the caller degrades to the pre-#3341 empty search result.
 */
export function rankLexicalFallback(
  query: string,
  paths: Iterable<string>,
  limit = 5,
): LexicalRankedPath[] {
  const queryTokens = tokenize(query).slice(0, MAX_QUERY_TOKENS);
  const scored: LexicalRankedPath[] = [];
  for (const path of paths) {
    const score = scoreTokenized(queryTokens, path);
    if (score > 0) scored.push({ path, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return scored.slice(0, Math.max(0, limit));
}
