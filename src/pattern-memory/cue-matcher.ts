/**
 * pattern-memory/cue-matcher.ts — fuzzy cue-deduplication algorithm
 *
 * Extracted from agent-memory.ts (issue #2108; the algorithm itself was
 * introduced in #1667). A self-contained pure-function cluster — stemming,
 * tokenization, an overlap-coefficient similarity score, and the pattern
 * resolver `recordPattern` uses to decide whether an incoming friction cue
 * should merge into an existing pattern or spawn a new one.
 *
 * Purely arithmetic over strings: no Redis, no filesystem, no async, and no
 * imports from the rest of `src/pattern-memory/`. Import direction is one-way
 * — `agent-memory.ts` imports from here, never the reverse. `findPatternForCue`
 * is generic over the minimal pattern shape it reads (`category` + `firstSeen`)
 * so the matcher stays decoupled from the `MemoryPattern` store type.
 *
 * Public surface (also unit-tested directly in test/friction-cue-dedup.test.mts):
 *   cueSimilarity         — string × string → number in [0, 1]
 *   findPatternForCue     — pattern[] × string → pattern | undefined
 *   CUE_MERGE_THRESHOLD   — exported constant
 */

/**
 * Issue #1667 — minimum cue-similarity (overlap coefficient over stemmed
 * kebab tokens) for a new cue to merge into an existing pattern instead of
 * fragmenting into a fresh hitCount:1 entry. Calibrated against the retro
 * evidence in #1667: the four knip-demote spellings and the three
 * sentry-vercel-edge spellings all score >= 0.6 against their oldest
 * sibling, while unrelated cues sharing a prefix token (e.g. two distinct
 * scope-check gotchas) stay below it.
 */
export const CUE_MERGE_THRESHOLD = 0.6;

/**
 * Light suffix stem so trivial inflection differences ("missing"/"misses",
 * "referenced"/"references", "internally"/"internal") collapse to one token.
 * Deliberately crude — a stem only has to be CONSISTENT across spellings of
 * the same gotcha, not linguistically correct. Minimum stem length 3 so short
 * tokens ("is", "ci", "npm") pass through untouched.
 */
function stemCueToken(token: string): string {
  for (const suffix of ["ing", "ed", "es", "ly", "s"]) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function tokenizeCue(cue: string): Set<string> {
  return new Set(
    cue
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stemCueToken),
  );
}

/**
 * Similarity between two free-authored kebab-case cues in [0, 1]: the overlap
 * coefficient (|intersection| / min(|A|, |B|)) over stemmed tokens. Overlap
 * coefficient (not Jaccard) so a short cue that is a near-subset of a longer
 * restatement still scores high — the fragmentation pattern in the #1667
 * evidence is precisely "same tokens, different elaborations".
 *
 * Guard: when either cue has fewer than 2 tokens the metric degenerates (any
 * superset of a single-token cue would score 1.0), so single-token cues
 * match exact-spelling only.
 *
 * Exported for direct unit testing; production callers go through
 * `findPatternForCue`.
 */
export function cueSimilarity(a: string, b: string): number {
  const ta = tokenizeCue(a);
  const tb = tokenizeCue(b);
  const minSize = Math.min(ta.size, tb.size);
  if (minSize === 0) return 0;
  if (minSize < 2) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / minSize;
}

/**
 * Resolve the pattern a cue should land on: exact category match first
 * (cheap, and pre-existing fragments keep their identity), otherwise the
 * best fuzzy match at or above CUE_MERGE_THRESHOLD. Ties prefer the OLDER
 * pattern (firstSeen) so the earliest spelling of a gotcha stays canonical
 * regardless of store order. Returns undefined when nothing matches — the
 * caller creates a fresh pattern, exactly as before #1667.
 *
 * Generic over the minimal pattern shape this resolver reads (`category` +
 * `firstSeen`) so the matcher stays decoupled from the `MemoryPattern` store
 * type. Exported for direct unit testing.
 */
export function findPatternForCue<P extends { category: string; firstSeen: string }>(
  patterns: P[],
  category: string,
): P | undefined {
  const exact = patterns.find(p => p.category === category);
  if (exact) return exact;

  let best: P | undefined;
  let bestScore = 0;
  for (const p of patterns) {
    const score = cueSimilarity(p.category, category);
    if (score < CUE_MERGE_THRESHOLD) continue;
    if (
      !best ||
      score > bestScore ||
      (score === bestScore && p.firstSeen < best.firstSeen)
    ) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}
