/**
 * Merge-commit / PR-label **parser leaf** — the zero-IO core of the
 * recent-merges aggregator (issue #3100).
 *
 * This leaf answers one question at the lowest abstraction level: "what does a
 * git-log line or a `gh pr view --json` field MEAN?" It is a pure transform
 * from strings (git-log output, gh-json fields, label arrays) into typed domain
 * records (`MergeCommit`, `PrMeta`, tier number). It has NO subprocess deps, NO
 * `gh` CLI deps, and NO Redis — it imports nothing from the aggregator's IO
 * layer.
 *
 * These parsers previously lived inline in `recent-merges.ts`, mixed with the
 * IO-orchestration layer (`getRecentMerges`, `listRecentMergeCommits`) that runs
 * the subprocess `git log` + `gh pr view` fan-outs. A test of `tierFromLabels`
 * (a pure string-array fold returning `number | null`) had to import
 * `recent-merges.ts`, which pulled in the GitHub CLI Adapter seam
 * (`github/exec-file-compat.ts`, `github/issues.ts`) and the taxonomy Module at
 * module-init time. Concentrating the parsers here separates the "what does a
 * git-log line mean?" concern from the "run git and gh and assemble the result"
 * concern, giving each a testable interface of its own.
 *
 * `recent-merges.ts` imports these symbols from here and RE-EXPORTS them for
 * back-compat, so `import { tierFromLabels, ... } from "./recent-merges.ts"`
 * (and the existing test import paths) keep working unchanged. The IO layer
 * imports the `MergeCommit` / `PrMeta` types back from this leaf — their
 * canonical home — since they name the records the parsers produce.
 *
 * # Design contract
 *
 * - **Pure.** No IO, no throw. Every function is a deterministic
 *   string(s) → record transform.
 * - **Tolerant.** Malformed / legacy / stub input degrades gracefully
 *   (subject-only git-log lines, missing gh-json fields) rather than throwing.
 */

// ---------------------------------------------------------------------------
// Domain record types (canonical home)
// ---------------------------------------------------------------------------

/**
 * The intermediate "merge commit" step (issue #2177): a PR number paired with
 * its merge timestamp, sourced from the git-log committer date — NOT from a
 * per-PR `gh pr view` call. This is the cheap primitive that
 * `listRecentMergeCommits` returns and `getRecentMerges` enriches.
 */
export interface MergeCommit {
  prNumber: number;
  /**
   * ISO-8601 committer date of the first-parent merge commit. For Hydra's
   * squash-merge mode this is the merge time. Empty string when the git-log
   * format carried no date field (e.g. a test stub emitting subject-only
   * lines, or a `%cI`-less log); callers tolerate the empty string the same
   * way they tolerate a missing `mergedAt` (Date.parse → NaN → excluded).
   */
  mergedAt: string;
}

/**
 * The per-PR metadata record produced from a raw `gh pr view --json` object.
 * `getRecentMerges` folds one of these into each `MergeItem`.
 */
export interface PrMeta {
  title: string;
  labels: string[];
  mergedAt: string;
  url: string;
}

// ---------------------------------------------------------------------------
// git-log field separator
// ---------------------------------------------------------------------------

/**
 * Delimiter between the committer date (`%cI`) and the subject (`%s`) in the
 * git-log pretty format. A literal that cannot appear inside an ISO-8601
 * committer date, so a split on the first occurrence cleanly separates the
 * date from a subject that may itself contain pipes.
 */
export const GIT_LOG_FIELD_SEP = "|";

// ---------------------------------------------------------------------------
// git-log parsers
// ---------------------------------------------------------------------------

/**
 * Pure helper. Parses git-log output in the `%cI|%s` pretty format into
 * `{prNumber, mergedAt}` pairs, pulling the `(#NNN)` PR-number suffix from the
 * subject and the committer date from the leading field. Returns the first
 * `limit` matches in newest-first order.
 *
 * Tolerant of subject-only lines (no `|` delimiter) — a line with no
 * separator is treated as a bare subject with an empty `mergedAt`, so older
 * `--pretty=format:%s` output and test stubs still parse (the PR number is
 * still recovered; only the date is absent). Commits without a recognizable
 * `(#NNN)` suffix are skipped (typically operator-direct commits, not PR
 * merges).
 */
export function extractMergeCommitsFromGitLog(
  stdout: string,
  limit: number,
): MergeCommit[] {
  if (!stdout) return [];
  const out: MergeCommit[] = [];
  const seen = new Set<number>();
  for (const line of stdout.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    // Split the leading `%cI|` date field off the subject. Split on the FIRST
    // separator only so a subject containing a pipe stays intact. A line with
    // no separator is a bare subject (legacy `%s`-only format / test stub).
    const sepIdx = raw.indexOf(GIT_LOG_FIELD_SEP);
    let mergedAt = "";
    let subject = raw;
    if (sepIdx !== -1) {
      const candidateDate = raw.slice(0, sepIdx).trim();
      // Only treat the leading field as a date if it parses as one — guards
      // against a subject-only line that happens to contain a pipe.
      if (candidateDate && Number.isFinite(Date.parse(candidateDate))) {
        mergedAt = candidateDate;
        subject = raw.slice(sepIdx + 1).trim();
      }
    }
    const n = prNumberFromSubject(subject);
    if (n === null) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ prNumber: n, mergedAt });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Pure helper. Back-compat wrapper that returns just the PR-number list from
 * git-log output (the pre-#2177 public shape). Implemented in terms of
 * `extractMergeCommitsFromGitLog` so the parse logic lives in one place;
 * callers that need the merge timestamp use the commit-returning form.
 */
export function extractPrNumbersFromGitLog(stdout: string, limit: number): number[] {
  return extractMergeCommitsFromGitLog(stdout, limit).map((c) => c.prNumber);
}

/**
 * Pure helper. Pulls a `(#NNN)` PR-number suffix from a commit subject.
 * Recognizes both the squash-merge `(#NNN)` suffix and the classic
 * `Merge pull request #NNN` prefix. Returns null when no positive integer
 * PR number is present.
 */
export function prNumberFromSubject(subject: string): number | null {
  const trimmed = subject.trim();
  if (!trimmed) return null;
  // Common shapes:
  //   "feat: foo (#123)"
  //   "Merge pull request #123 from owner/branch"
  let n: number | null = null;
  const suffix = trimmed.match(/\(#(\d+)\)\s*$/);
  if (suffix) n = Number(suffix[1]);
  if (n === null) {
    const merge = trimmed.match(/^Merge pull request #(\d+)\b/);
    if (merge) n = Number(merge[1]);
  }
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// gh-json → PrMeta mapper
// ---------------------------------------------------------------------------

/**
 * Pure helper. Maps one raw `gh pr view --json` object (as `viewPr` returns it)
 * into the `PrMeta` shape, flattening `labels` to a `string[]` and defaulting
 * missing string fields to `""`. Never throws.
 */
export function prMetaFromView(view: {
  title?: unknown;
  labels?: Array<{ name?: unknown }>;
  mergedAt?: unknown;
  url?: unknown;
}): PrMeta {
  return {
    title: typeof view.title === "string" ? view.title : "",
    url: typeof view.url === "string" ? view.url : "",
    mergedAt: typeof view.mergedAt === "string" ? view.mergedAt : "",
    labels: (view.labels ?? [])
      .map((l) => l?.name)
      .filter((n): n is string => typeof n === "string"),
  };
}

// ---------------------------------------------------------------------------
// Label parser
// ---------------------------------------------------------------------------

/**
 * Pure helper. Finds a `tier:N` label (case-insensitive) and returns the
 * integer N. Returns null when no such label exists or when N isn't a
 * non-negative integer.
 */
export function tierFromLabels(labels: readonly string[]): number | null {
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const m = raw.toLowerCase().match(/^tier[:\s-]*(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
