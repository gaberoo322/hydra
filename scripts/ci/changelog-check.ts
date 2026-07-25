/**
 * scripts/ci/changelog-check.ts — advisory changelog-fragment checker (issue #3678).
 *
 * Part of the dashboard-version epic (#3676) and wayfinder tickets #3662/#3657.
 *
 * The `.changelog/` fragment convention (#3662): each PR adds a per-PR file
 * `.changelog/<issue>-<slug>.md` holding one curated line
 * `- <type>: <description> (#<issue>)`. Per-PR fragment files are conflict-free
 * across parallel autopilot PRs (each PR adds a distinct filename), and no
 * committed `CHANGELOG.md` is introduced — the dashboard renders per-version
 * notes downstream from the tag-window diff (#3659/#3680/#3681).
 *
 * This module is the PURE decision core for the advisory
 * `.github/workflows/changelog-check.yml` workflow. It answers one question:
 * given the files a PR ADDS and the PR's labels, should the check pass silently
 * or post/update a single sticky nag comment?
 *
 * ADVISORY-ONLY (invariant, mirrors osv-scan / advisory-checks / the npm-audit
 * poison-pill lesson): the workflow that consumes this ALWAYS exits 0. Its only
 * side effect is one sticky, marker-identified PR comment. It is NOT in ci.yml,
 * NOT in deploy.needs, and NOT a branch-protection required check, so a
 * "missing fragment" can never block a merge or a deploy.
 *
 * This file is intentionally free of `fs`/network/`gh` calls so the
 * fragment-detection predicate is unit-tested directly
 * (test/changelog-check.test.mts). The workflow shell does the git-diff read,
 * label read, and gh-api comment plumbing around this pure core.
 */

/** The hidden HTML marker that makes the sticky comment findable + idempotent. */
export const CHANGELOG_COMMENT_MARKER = "<!-- hydra-changelog-check -->";

/** The opt-out label: a PR carrying it passes silently with no fragment. */
export const SKIP_CHANGELOG_LABEL = "skip-changelog";

/** The directory prefix every changelog fragment lives under. */
export const CHANGELOG_DIR_PREFIX = ".changelog/";

/**
 * True iff `path` is a changelog fragment — i.e. it lives under `.changelog/`.
 * Normalises a leading `./` so a diff path like `./.changelog/x.md` still
 * counts. The `.changelog/README.md` convention doc IS under the prefix, but
 * the caller only ever passes ADDED files from the PR diff, and a PR that adds
 * a real fragment (not just README) is the intended silence case — the README
 * is committed once (this ticket) and won't appear as an "added" file on
 * subsequent PRs.
 */
export function isChangelogFragment(path: string): boolean {
  const p = (path || "").trim().replace(/^\.\//, "");
  return p.startsWith(CHANGELOG_DIR_PREFIX) && p.length > CHANGELOG_DIR_PREFIX.length;
}

/** True iff the PR ADDS at least one file under `.changelog/`. */
export function addsChangelogFragment(addedFiles: string[]): boolean {
  return (addedFiles ?? []).some(isChangelogFragment);
}

/** Case-insensitive membership check for the skip-changelog opt-out label. */
export function hasSkipLabel(labels: string[]): boolean {
  return (labels ?? []).some((l) => (l || "").trim().toLowerCase() === SKIP_CHANGELOG_LABEL);
}

/**
 * The core silence decision.
 *
 * Silence (pass without a comment) IFF the PR adds >=1 `.changelog/` fragment
 * OR carries the `skip-changelog` label. Otherwise the check should post/update
 * the single sticky nag comment.
 *
 * @param addedFiles files the PR diff ADDS (git diff --name-status --diff-filter=A)
 * @param labels     the PR's label names
 */
export function shouldNag(addedFiles: string[], labels: string[]): boolean {
  if (addsChangelogFragment(addedFiles)) return false;
  if (hasSkipLabel(labels)) return false;
  return true;
}

/**
 * The sticky comment body posted when a fragment is missing. Always begins with
 * the hidden marker so the workflow can find-and-update it in place (never
 * accumulating duplicates across pushes). Kept terse and non-blocking — the
 * whole point is a gentle nudge, not a gate.
 */
export function nagCommentBody(): string {
  return [
    CHANGELOG_COMMENT_MARKER,
    "> *Advisory changelog check (#3678) — this never blocks merge or deploy.*",
    "",
    "This PR adds no `.changelog/` fragment and is not labeled `skip-changelog`.",
    "",
    "Please add a per-PR changelog fragment so the release notes render on the dashboard:",
    "",
    "```",
    ".changelog/<issue>-<slug>.md",
    "```",
    "",
    "with a single curated line, e.g.:",
    "",
    "```",
    "- feat: add versions panel to the dashboard (#1234)",
    "```",
    "",
    "…or apply the `skip-changelog` label if this change needs no release note",
    "(chores, tests, docs-only, revert). See `.changelog/README.md`.",
  ].join("\n");
}

/**
 * Read the ADDED files from the environment. The workflow computes the diff
 * (`git diff --name-status --diff-filter=A base..head`) and passes just the
 * added paths, newline-separated, in ADDED_FILES.
 */
function readAddedFiles(): string[] {
  return (process.env.ADDED_FILES ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Read the PR's label names from PR_LABELS (newline- or comma-separated). */
function readLabels(): string[] {
  return (process.env.PR_LABELS ?? "")
    .split(/[\r\n,]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * CLI entrypoint. Emits a JSON verdict on stdout that the workflow inspects to
 * decide whether to post/update or delete/skip the sticky comment. This NEVER
 * exits non-zero — advisory only.
 */
function main(): void {
  const addedFiles = readAddedFiles();
  const labels = readLabels();
  const nag = shouldNag(addedFiles, labels);
  const verdict = {
    nag,
    hasFragment: addsChangelogFragment(addedFiles),
    hasSkipLabel: hasSkipLabel(labels),
    marker: CHANGELOG_COMMENT_MARKER,
    addedFragmentCount: addedFiles.filter(isChangelogFragment).length,
  };
  process.stdout.write(JSON.stringify(verdict) + "\n");
  if (nag) {
    process.stdout.write(nagCommentBody() + "\n");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
