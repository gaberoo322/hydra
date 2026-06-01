/**
 * repo-file-matcher.ts — Anchor-reference → file matching (planner-prompt
 * scoping, issue #366).
 *
 * Heuristic, NOT graph-dependent: given an anchor reference string and a flat
 * file-tree listing, score and rank the files most likely relevant to the
 * anchor. Split out of the former monolithic `repo-map.ts` (issue #805) so
 * the matcher presents a small interface independent of the import-graph
 * machinery.
 *
 * The only shared dependency is `isTestFile`, imported from
 * `repo-import-graph.ts` (its single home — no duplication, no graph coupling).
 *
 * This module's tokenizer (`tokenizeAnchorReference`, a file-path tokenizer) is
 * a distinct concern from the priorities-alignment tokenizer that lived in the
 * now-deleted anchor-scorer.ts (#783) — the two are not code-shared.
 */

import { isTestFile } from "./repo-import-graph.ts";

// ---------------------------------------------------------------------------
// Anchor-keyed file lookup (planner-prompt scoping — issue #366)
// ---------------------------------------------------------------------------

/**
 * Split an arbitrary string into lowercase tokens of length >= 3. Splits on
 * any non-alphanumeric run (so "kalshi-price-format.ts", "src/foo/bar.ts" and
 * "feed planner scoped tree" all yield clean word tokens). Stop tokens are
 * filtered out so generic words like "the", "and", "for", "ts", "test" don't
 * cause the matcher to fire on every file in the tree.
 *
 * Pure / deterministic — exported for unit tests so the tokenisation contract
 * is locked.
 */
export function tokenizeAnchorReference(reference: string): string[] {
  if (typeof reference !== "string" || reference.length === 0) return [];
  const STOP = new Set([
    "the", "and", "for", "with", "from", "this", "that", "into", "onto",
    "out", "off", "but", "not", "all", "any", "use", "let", "src", "lib",
    "ts", "tsx", "mts", "js", "jsx", "test", "tests", "spec", "specs",
    "index", "main", "type", "types", "util", "utils", "helper", "helpers",
    "file", "files", "code", "fix", "fixes", "add", "remove", "update",
  ]);
  return [...new Set(
    reference
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  )];
}

/**
 * Score a file path against a set of lowercase anchor tokens. Returns 0 if no
 * token matches. Scoring rewards:
 *   - directory-prefix matches (token appears as a /-separated path segment): +3
 *   - filename-stem substring matches: +2
 *   - any other path substring match: +1
 *
 * Score scales linearly with the number of distinct matching tokens so a path
 * that hits two tokens always outranks one that hits one, regardless of which
 * bucket each hit lands in.
 */
export function scoreFileAgainstTokens(filePath: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = filePath.toLowerCase();
  const segments = new Set(lower.split(/[\/\\.]/).filter(Boolean));
  // Strip extensions to get a normalised stem set: "foo.test.ts" → "foo"
  const stem = lower
    .replace(/^.*\//, "")
    .replace(/\.(test|spec)\.[cm]?[tj]sx?$/, "")
    .replace(/\.[cm]?[tj]sx?$/, "");
  let score = 0;
  for (const tok of tokens) {
    if (segments.has(tok)) {
      score += 3;
      continue;
    }
    if (stem.includes(tok)) {
      score += 2;
      continue;
    }
    if (lower.includes(tok)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Find the files in `fileTreeLines` most relevant to `anchorReference` using
 * cheap heuristics (token overlap + directory prefix). Returns an array of
 * paths sorted by relevance score descending, ties broken by:
 *   1. path length ascending (shorter = more likely to be the canonical module)
 *   2. lexicographic order
 *
 * Pairs implementation files with their test counterparts: for every selected
 * `.ts`/`.tsx` non-test file, if a sibling `*.test.*` or `*.spec.*` file is
 * present in the tree, the test file is forced into the result set (consuming
 * a slot from `limit`). This matches the planner's mental model — modify a
 * file, modify its tests — and keeps the prompt useful for test-anchored work.
 *
 * Returns an empty array when the anchor reference has no recognizable tokens
 * (e.g. doc anchors like "ADR-0004"). Callers should treat empty results as
 * a signal to omit the scoped file tree from the prompt entirely.
 *
 * @param anchorReference - The anchor.reference string (e.g.
 *   "reframe:execution-cost" or "kalshi-price-format implementation")
 * @param fileTreeLines   - Lines of `git ls-files` output (one path per line)
 * @param limit           - Max files to return (default 50)
 */
export function findRelatedFiles(
  anchorReference: string,
  fileTreeLines: string[],
  limit = 50,
): string[] {
  const tokens = tokenizeAnchorReference(anchorReference);
  if (tokens.length === 0) return [];
  if (fileTreeLines.length === 0) return [];

  type Scored = { path: string; score: number; isTest: boolean };
  const scored: Scored[] = [];
  for (const rawPath of fileTreeLines) {
    const path = rawPath.trim();
    if (!path) continue;
    const score = scoreFileAgainstTokens(path, tokens);
    if (score > 0) {
      scored.push({ path, score, isTest: isTestFile(path) });
    }
  }
  if (scored.length === 0) return [];

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });

  // Force-pair implementation files with their nearest test file. Walk the
  // sorted list, accumulate up to `limit` paths, and for each non-test impl
  // path remember the matching test path (if it exists anywhere in the tree).
  const fileSet = new Set(fileTreeLines.map((l) => l.trim()).filter(Boolean));
  const selected: string[] = [];
  const seen = new Set<string>();

  const addPath = (p: string) => {
    if (!seen.has(p) && selected.length < limit) {
      seen.add(p);
      selected.push(p);
    }
  };

  for (const entry of scored) {
    addPath(entry.path);
    if (selected.length >= limit) break;

    // Pair impl → test (only when scoring an impl file).
    if (!entry.isTest && /\.[cm]?[tj]sx?$/.test(entry.path)) {
      const stemPath = entry.path.replace(/\.[cm]?[tj]sx?$/, "");
      const testCandidates = [
        `${stemPath}.test.ts`,
        `${stemPath}.test.tsx`,
        `${stemPath}.test.mts`,
        `${stemPath}.test.js`,
        `${stemPath}.spec.ts`,
        `${stemPath}.spec.mts`,
      ];
      for (const c of testCandidates) {
        if (fileSet.has(c)) {
          addPath(c);
          break;
        }
      }
    }
  }

  return selected;
}
