/**
 * scripts/ci/derive-version-bump.ts — semver bump derivation from Conventional
 * Commits (issue #3677, epic #3676 alpha; wayfinder decisions #3655/#3656).
 *
 * deploy.sh calls this AFTER the health gate passes to decide the next semver
 * tag: given the commit subjects since the last tag, what bump (major/minor/
 * patch) does Conventional Commits imply, and what is the resulting `vX.Y.Z`?
 *
 * NO npm dependency (ADR-0005 no-dependency lane): this is a ~30-line node-stdlib
 * string parse over `git log --format=%s%n%b`. #3655 decided the tool's ONLY job
 * is to derive the bump — the changelog is curated per-PR under `.changelog/`
 * (#3656), never tool-generated — so a full git-cliff-style templater is YAGNI.
 *
 * PURE CORE + THIN CLI (mirrors scripts/ci/changelog-check.ts): the bump math is
 * a set of pure functions unit-tested directly (test/derive-version-bump.test.mts).
 * The CLI entrypoint does the one git read (`git log <lastTag>..HEAD`) and prints
 * the next tag; deploy.sh consumes stdout. The pure functions take the commit
 * subjects/bodies as data so no test forks git.
 *
 * INVARIANTS (from the design concept for #3677):
 *  - feat -> MINOR; fix/chore/perf/refactor/security/test/docs/style/build/ci/
 *    cleanup/revert/other -> PATCH; a `!` suffix on the type OR a `BREAKING
 *    CHANGE` footer -> MAJOR. Highest-precedence bump across the range wins.
 *  - Scoped types (`feat(scope):`) parse on the type token before `(`.
 *  - Unknown / non-conventional subjects default to PATCH (never skip a bump).
 *  - Baseline: if NO prior tag exists, the first tag is v1.0.0 (orch).
 */

/** The three Conventional-Commits bump levels, lowest -> highest precedence. */
export type Bump = "patch" | "minor" | "major";

/** Numeric precedence so the highest bump across a commit range wins. */
const BUMP_RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

/** The baseline first tag when the repo carries no prior tag (orch). */
export const BASELINE_VERSION = "1.0.0";

/** A parsed semver triple. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a `vX.Y.Z` (or `X.Y.Z`) tag into a {@link SemVer}. Returns null when the
 * string is not a clean semver triple, so the caller falls back to the baseline.
 */
export function parseSemver(tag: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((tag || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * The bump implied by a SINGLE commit, from its subject line + body.
 *
 * A `!` before the `:` (e.g. `feat!:` / `refactor(core)!:`) or a `BREAKING
 * CHANGE` footer in the body is MAJOR regardless of type. Otherwise `feat` is
 * MINOR and everything else (including unknown/non-conventional subjects) is
 * PATCH — a bump is never skipped.
 */
export function bumpForCommit(subject: string, body = ""): Bump {
  const subj = (subject || "").trim();
  // The Conventional-Commits header: type, optional (scope), optional `!`, `:`.
  const header = /^([a-zA-Z]+)(\([^)]*\))?(!)?:/.exec(subj);
  const breakingBang = header?.[3] === "!";
  const breakingFooter = /(^|\n)BREAKING[ -]CHANGE/.test(body || "");
  if (breakingBang || breakingFooter) return "major";
  const type = header?.[1]?.toLowerCase();
  if (type === "feat") return "minor";
  // fix/chore/perf/refactor/security/docs/... and unknown subjects -> patch.
  return "patch";
}

/**
 * The highest-precedence bump across a list of commits. Each entry is a
 * `{ subject, body }` pair (body optional, for BREAKING-CHANGE detection).
 * An empty range yields PATCH — deploy always mints a tag on a healthy deploy.
 */
export function deriveBump(commits: Array<{ subject: string; body?: string }>): Bump {
  let best: Bump = "patch";
  for (const c of commits ?? []) {
    const b = bumpForCommit(c.subject, c.body);
    if (BUMP_RANK[b] > BUMP_RANK[best]) best = b;
  }
  return best;
}

/** Apply a bump to a {@link SemVer}, resetting lower components per semver. */
export function applyBump(v: SemVer, bump: Bump): SemVer {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

/** Render a {@link SemVer} as a `vX.Y.Z` tag (leading `v`). */
export function formatTag(v: SemVer): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

/**
 * The full derivation: given the previous tag (or null for a fresh repo) and the
 * commits since it, return the next `vX.Y.Z` tag.
 *
 * - No prior tag -> baseline v1.0.0 (the range's commits do NOT bump the
 *   baseline; the baseline IS the first release).
 * - Prior tag present -> apply the highest bump across the range to it.
 */
export function nextTag(
  prevTag: string | null,
  commits: Array<{ subject: string; body?: string }>,
): string {
  const prev = prevTag ? parseSemver(prevTag) : null;
  if (!prev) {
    // Fresh repo (or an unparseable prior tag): the first tag is the baseline.
    return `v${BASELINE_VERSION}`;
  }
  return formatTag(applyBump(prev, deriveBump(commits)));
}

/**
 * Split a raw `git log --format=%s%x00%b%x1e` stream into `{subject, body}`
 * commit records. Records are `\x1e`-separated; within a record the subject and
 * body are `\x00`-separated. This keeps multi-line bodies (needed for BREAKING
 * CHANGE footers) intact without a subject/body ambiguity from newlines.
 */
export function parseGitLog(raw: string): Array<{ subject: string; body: string }> {
  return (raw || "")
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => {
      const nul = rec.indexOf("\x00");
      if (nul === -1) return { subject: rec.trim(), body: "" };
      return { subject: rec.slice(0, nul).trim(), body: rec.slice(nul + 1).trim() };
    });
}

/**
 * CLI entrypoint (invoked by deploy.sh). Reads the previous tag and the commit
 * range from the environment (deploy.sh runs the git commands and passes the
 * results in), then prints the next `vX.Y.Z` tag on stdout.
 *
 *   PREV_TAG   — the previous tag (empty/unset => baseline v1.0.0)
 *   GIT_LOG    — `git log <prev>..HEAD --format=%s%x00%b%x1e` output
 *
 * Deterministic, no git process of its own, so deploy.sh owns the git reads and
 * this stays a pure transform. Prints ONLY the tag (deploy.sh captures it).
 */
function main(): void {
  const prevTag = (process.env.PREV_TAG ?? "").trim() || null;
  const commits = parseGitLog(process.env.GIT_LOG ?? "");
  process.stdout.write(nextTag(prevTag, commits) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
