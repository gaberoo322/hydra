/**
 * scripts/ci/issue-dedup.ts — Shared issue-dedup baseline for the Orchestrator
 * "fill the board" skills (issue #2554).
 *
 * Background: `hydra-research`, `hydra-discover`, and `hydra-architecture-scan`
 * each turn idle capacity into ready-for-agent GitHub issues. Each one carried
 * its OWN prose copy of the dedup rule ("word overlap >50% → SKIP") with no
 * shared, testable implementation — so when research (opportunistic /
 * empty-board) and discover (heartbeat) fired in the same window they could
 * DOUBLE-FILE the same finding: one playbook's "is this >50% overlap with an
 * existing title?" judgement is an LLM eyeball, not a deterministic function,
 * and two independent eyeballs disagree at the margin.
 *
 * This module is the single source of truth for that judgement: a pure,
 * deterministic word-overlap test the playbooks call (via the CLI below) so
 * BOTH skills compute "duplicate?" the exact same way against the exact same
 * baseline (open issues + issues closed within the dedup window). When two
 * skills agree byte-for-byte on what counts as a duplicate, the same finding
 * cannot slip past one and get filed by the other.
 *
 * The rule (the historical prose, made deterministic):
 *
 *   Two issue titles are duplicates iff their normalised word sets have
 *   Jaccard overlap > DEFAULT_OVERLAP_THRESHOLD (0.5 — i.e. "more than half
 *   the distinct words are shared"). Normalisation lower-cases, strips
 *   punctuation, and drops a small stop-word + boilerplate-prefix list
 *   ("the", "a", "fix", "add", …) so "Fix the empty-cycle rate" and
 *   "Reduce empty cycle rate" are seen as the same finding.
 *
 * The helper is pure (no fs / network / process) — see
 * test/issue-dedup.test.mts for the regression matrix. The CLI wrapper at the
 * bottom lets a playbook shell out:
 *
 *   node --experimental-strip-types scripts/ci/issue-dedup.ts \
 *     "<candidate title>" "<existing 1>" "<existing 2>" ...
 *
 * It prints a JSON verdict ({duplicate, matchedTitle, overlap}) to stdout and
 * exits 0 always (a dedup check never crashes the producing skill).
 */

/** Default Jaccard-overlap threshold above which two titles are duplicates. */
export const DEFAULT_OVERLAP_THRESHOLD = 0.5;

/**
 * Stop words + boilerplate issue-title prefixes stripped before comparison.
 * These carry no finding-identity signal — "Fix X" and "X" name the same
 * finding — so leaving them in would deflate the overlap ratio and let real
 * duplicates through.
 */
const STOP_WORDS = new Set<string>([
  // articles / conjunctions / prepositions
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "by",
  "from",
  "into",
  "via",
  // imperative issue-title prefixes that name the *action*, not the *finding*
  "fix",
  "add",
  "remove",
  "reduce",
  "improve",
  "refactor",
  "update",
  "consolidate",
  "make",
  "ensure",
  "support",
]);

/**
 * Normalise a title into a set of comparison tokens: lower-case, strip
 * punctuation to spaces, split on whitespace, drop stop words and empties.
 * Exported for the test matrix.
 */
export function normaliseTitle(title: string): Set<string> {
  const tokens = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/**
 * Jaccard overlap of two normalised token sets: |A ∩ B| / |A ∪ B|.
 * Two empty / fully-stripped titles overlap 0 (never auto-duplicate on
 * emptiness — a title that is all stop words carries no identity to match).
 */
export function titleOverlap(a: string, b: string): number {
  const sa = normaliseTitle(a);
  const sb = normaliseTitle(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** A verdict for a single candidate against the baseline. */
export interface DedupVerdict {
  /** True iff the candidate overlaps some baseline title above the threshold. */
  duplicate: boolean;
  /** The baseline title that triggered the match (highest overlap), if any. */
  matchedTitle?: string;
  /** The overlap ratio of the best match (0 when no baseline supplied). */
  overlap: number;
}

/**
 * Decide whether `candidateTitle` duplicates any title in `existingTitles`
 * (the shared baseline = open issues + recently-closed issues within the
 * dedup window). Returns the best (highest-overlap) match so the caller can
 * log it verbatim. Pure — never throws on well-formed string input.
 *
 * `threshold` defaults to {@link DEFAULT_OVERLAP_THRESHOLD}; the verdict is
 * `duplicate` when the best overlap is STRICTLY GREATER THAN the threshold
 * (matching the historical ">50%" prose, not ">=").
 */
export function isDuplicateIssue(
  candidateTitle: string,
  existingTitles: readonly string[],
  threshold: number = DEFAULT_OVERLAP_THRESHOLD,
): DedupVerdict {
  let best = 0;
  let bestTitle: string | undefined;
  for (const existing of existingTitles ?? []) {
    const overlap = titleOverlap(candidateTitle, existing);
    if (overlap > best) {
      best = overlap;
      bestTitle = existing;
    }
  }
  return {
    duplicate: best > threshold,
    matchedTitle: best > threshold ? bestTitle : undefined,
    overlap: best,
  };
}

/**
 * Partition a list of candidate titles into the ones to FILE and the ones to
 * SKIP (duplicates) against the shared baseline. Convenience over
 * {@link isDuplicateIssue} for the common "I have N candidates" case so a
 * playbook can file `kept` and log `skipped` in one pass.
 */
export function partitionCandidates(
  candidateTitles: readonly string[],
  existingTitles: readonly string[],
  threshold: number = DEFAULT_OVERLAP_THRESHOLD,
): {
  kept: string[];
  skipped: Array<{ title: string; matchedTitle: string; overlap: number }>;
} {
  const kept: string[] = [];
  const skipped: Array<{ title: string; matchedTitle: string; overlap: number }> =
    [];
  for (const candidate of candidateTitles ?? []) {
    const verdict = isDuplicateIssue(candidate, existingTitles, threshold);
    if (verdict.duplicate && verdict.matchedTitle) {
      skipped.push({
        title: candidate,
        matchedTitle: verdict.matchedTitle,
        overlap: verdict.overlap,
      });
    } else {
      kept.push(candidate);
    }
  }
  return { kept, skipped };
}

// ---------------------------------------------------------------------------
// CLI: node --experimental-strip-types scripts/ci/issue-dedup.ts \
//        "<candidate>" "<existing 1>" "<existing 2>" ...
//
// Prints a JSON DedupVerdict for the candidate (argv[2]) against the baseline
// (argv[3..]) and exits 0 always — a dedup check must never crash the
// producing skill (CLAUDE.md fail-loud-but-don't-block discipline).
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      typeof import.meta.url === "string" &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta may be unavailable under some loaders; treat as not-main */
    return false;
  }
})();

if (isMain) {
  const [, , candidate, ...existing] = process.argv;
  if (candidate === undefined) {
    console.error(
      'usage: issue-dedup.ts "<candidate title>" "<existing 1>" "<existing 2>" ...',
    );
    process.exit(0);
  }
  const verdict = isDuplicateIssue(candidate, existing);
  console.log(JSON.stringify(verdict));
  process.exit(0);
}
