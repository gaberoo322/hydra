/**
 * versions/read-versions — the deep module behind `GET /api/versions`
 * (issue #3680, epic #3676 delta).
 *
 * It answers one question per repository: "what release is this checkout on,
 * and what shipped in each of the last N releases?" — folding git tags (stamped
 * at deploy by #3677) together with the per-PR changelog fragments (#3678) that
 * landed inside each tag-to-tag window. All the policy lives here; the route
 * (`src/api/versions.ts`) and the roster (`project-list.ts`) are thin.
 *
 * ── FOUR CORRECTIONS PROVEN IN A SANDBOX (do not "fix" these back) ──────────
 *
 * 1. `current` IS THE HIGHEST-SEMVER TAG, NOT `git describe`.
 *    `git describe --tags --abbrev=0` exits 128 ("fatal: No names found") on a
 *    tagless repo — and BOTH repos are tagless at merge time — so a
 *    describe-based read fails 100% of requests on day one. It also answers
 *    "nearest reachable ancestor tag", a different question from "latest
 *    release". `git for-each-ref` exits 0 with EMPTY stdout when tagless, which
 *    is the degrade behaviour we want. This is a DELIBERATE divergence from the
 *    sibling `src/health/deployed-version.ts` (an orphan with zero production
 *    consumers; wiring or retiring it is out of scope for #3680).
 *
 * 2. THE COMMIT SHA COMES FROM `%(*objectname)`, WITH `%(objectname)` AS
 *    FALLBACK. On an ANNOTATED tag (what `scripts/deploy.sh` stamps),
 *    `%(objectname)` is the TAG OBJECT sha — a sha that appears in no `git log`
 *    and matches no commit. Emitting it is a silent wrong-sha bug. Lightweight
 *    tags invert this (`%(*objectname)` is empty), hence the `%(if)` fallback.
 *
 * 3. THE SORT IS `-v:refname`, NEVER `-refname`. Lexical ordering puts `v1.9.0`
 *    ABOVE `v1.10.0` ('0' 0x30 > '.' 0x2E). The Target's baseline is `v0.1.0`,
 *    so the 9→10 rollover is within ten releases, not hypothetical.
 *
 * 4. `-- .changelog/` DOES NOT EXCLUDE `README.md`. The pathspec returns the
 *    convention doc alongside real fragments, so the fold MUST filter basenames
 *    itself ({@link isFragmentPath}). Note that
 *    `scripts/ci/changelog-check.ts::isChangelogFragment()` is prefix-only and
 *    DOES match README.md — it is not reusable here (and a `src/ → scripts/`
 *    import would reverse the repo's only established direction anyway: 12
 *    `scripts→src` imports exist, zero `src→scripts`, and `tsconfig.json`
 *    includes `src/**` only).
 *
 * ── ZERO TAGS IS A VALID STEADY STATE, NOT AN ERROR ─────────────────────────
 *    A tagless repo returns `{ current: null, history: [], error: null }` — the
 *    "no releases yet" card, NOT a failure. Only a genuine git failure sets
 *    `error`. This is the PRIMARY path at merge time.
 *
 * ── NEVER-THROW ─────────────────────────────────────────────────────────────
 *    `gitExec` (the GitHub CLI Adapter seam, #896/#899) returns a discriminated
 *    result and never throws, so the degrade is a BRANCH, not a catch. One
 *    project's failure degrades that entry only and never suppresses a sibling.
 *    The outer try/catch is belt-and-braces for an unexpected parse throw.
 *
 * ── BOUNDED WORK ────────────────────────────────────────────────────────────
 *    Per COLD read of one repo: 1 `for-each-ref` + at most N tag-window diffs
 *    (N = the history limit, env-tunable) + at most {@link MAX_FRAGMENT_READS}
 *    `git show`s. Results cache for {@link VERSIONS_CACHE_TTL_MS} keyed by REPO
 *    ROOT PATH (the real identity — two rows could share a display name, and the
 *    root is what git is invoked against). Reads run SEQUENTIALLY so a dashboard
 *    hit can never fan out into a spawn storm.
 */

import { gitExec as defaultGitExec } from "../github/git.ts";
import { isGhFailure } from "../github/exec.ts";
import { logger } from "../logger.ts";
import {
  listVersionProjects,
  type VersionProject,
  type VersionProjectScope,
} from "./project-list.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache TTL per repo root. Mirrors the 60s health-probe caches. */
export const VERSIONS_CACHE_TTL_MS = 60_000;

/**
 * Git's canonical empty tree. The OLDEST tag has no predecessor, so its window
 * is `<empty-tree>..<tag>`. Hardcoded rather than spawning
 * `git hash-object -t tree /dev/null` — the value is SHA-1-fixed.
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Default history bound. Override with `HYDRA_VERSIONS_HISTORY_LIMIT`. */
export const DEFAULT_HISTORY_LIMIT = 20;

/** Hard cap on `git show` spawns per cold repo read. */
export const MAX_FRAGMENT_READS = 100;

/** Per-invocation git timeout — a dashboard read must never hang. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * One spawn yields the whole version-sorted `{version,date,sha}` payload,
 * pre-sorted and glob-filtered. `%(creatordate)` is the TAG date (when the
 * release was cut), which is the right field for a release date — not the
 * commit date.
 */
const TAG_FORMAT =
  "%(refname:short)|%(creatordate:iso-strict)|%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)";

/** Shape validation for a release tag. No semver arithmetic is performed. */
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+$/;

/** `.changelog/<issue>-<slug>.md` — deliberately does NOT match `README.md`. */
const FRAGMENT_BASENAME_RE = /^\d+-[a-z0-9-]+\.md$/;

/** `- <type>: <description> (#<issue>)` per `.changelog/README.md`. */
const NOTE_LINE_RE = /^-\s+([A-Za-z]+):\s+(.+?)(?:\s+\(#(\d+)\))?\s*$/;

/**
 * Canonical Conventional-Commits ordering. Notes are emitted in this order so
 * same-type entries arrive adjacent — the grouping the dashboard renders under
 * per-type headings. Unknown types sort last, in first-seen order.
 */
const TYPE_ORDER = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

const CHANGELOG_DIR = ".changelog/";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** A release pointer: the tag, when it was cut, and the COMMIT it points at. */
export interface VersionRef {
  version: string;
  /** ISO-8601 tag creation date. */
  date: string;
  /** The dereferenced COMMIT sha (never the tag-object sha). */
  sha: string;
}

/** One curated line from one changelog fragment. */
export interface ReleaseNote {
  /** Conventional-Commits type, lowercased. `"other"` when unparseable. */
  type: string;
  description: string;
  /** The issue the note references (NOT the PR), or null. */
  issue: number | null;
  /** The verbatim source line, for debugging. */
  raw: string;
}

/** A release plus everything that shipped in its tag window. */
export interface VersionHistoryEntry extends VersionRef {
  notes: ReleaseNote[];
}

/**
 * The per-repo payload. `current` carries NO notes — `history[0]` is the same
 * release WITH its notes, so a consumer must not double-render the newest entry.
 */
export interface ProjectVersionsData {
  current: VersionRef | null;
  history: VersionHistoryEntry[];
  /**
   * A `gh-*` failure code when the read degraded, else null. A TAGLESS repo is
   * NOT an error — it returns `current: null, history: [], error: null`.
   */
  error: string | null;
}

/** One entry of the wire `projects` array. */
export interface ProjectVersions extends ProjectVersionsData {
  name: string;
  scope: VersionProjectScope;
}

/**
 * Injectable dependencies. All defaulted, so production callers pass nothing and
 * tests pin the clock, the git seam, the bound, and the roster.
 */
export interface ReadVersionsDeps {
  /** Clock (default `Date.now`) — advance past the TTL to force a refetch. */
  now?: () => number;
  /** The git seam (default the #899 adapter) — stub to pin tags and fragments. */
  gitExec?: typeof defaultGitExec;
  /** History bound (default {@link resolveHistoryLimit}). */
  historyLimit?: number;
  /** Roster override (default {@link listVersionProjects}). */
  projects?: readonly VersionProject[];
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so tests pin them without any git process
// ---------------------------------------------------------------------------

/**
 * Resolve the history bound from an env value. Non-numeric, zero, negative, and
 * absent all fall back to {@link DEFAULT_HISTORY_LIMIT} — the bound is a safety
 * rail, so a typo must never widen it to unbounded.
 */
export function resolveHistoryLimit(raw?: string): number {
  if (!raw || !raw.trim()) return DEFAULT_HISTORY_LIMIT;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_HISTORY_LIMIT;
  return n;
}

/**
 * Parse `for-each-ref` output into version-sorted refs. Rows that are blank,
 * short, or not shaped `vMAJOR.MINOR.PATCH` are dropped — git already sorted
 * and glob-filtered, this is shape validation only.
 */
export function parseTagRows(stdout: string): VersionRef[] {
  const rows: VersionRef[] = [];
  for (const line of stdout.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const parts = row.split("|");
    if (parts.length < 3) continue;
    const version = parts[0].trim();
    if (!SEMVER_TAG_RE.test(version)) continue;
    rows.push({ version, date: parts[1].trim(), sha: parts[2].trim() });
  }
  return rows;
}

/**
 * True only for a real changelog fragment. The `-- .changelog/` pathspec also
 * returns `.changelog/README.md`, which would otherwise render the convention
 * doc as a release note.
 */
export function isFragmentPath(p: string): boolean {
  if (!p.startsWith(CHANGELOG_DIR)) return false;
  const base = p.slice(CHANGELOG_DIR.length);
  if (!base || base.includes("/")) return false;
  return FRAGMENT_BASENAME_RE.test(base);
}

/**
 * Parse one fragment line. A line matching the documented
 * `- <type>: <description> (#<issue>)` form yields a typed note; any other
 * non-empty line degrades to `type: "other"` rather than being dropped, so a
 * malformed fragment still surfaces something a human can read.
 */
export function parseNoteLine(line: string): ReleaseNote | null {
  const raw = line.trim();
  if (!raw) return null;
  const m = NOTE_LINE_RE.exec(raw);
  if (m) {
    return {
      type: m[1].toLowerCase(),
      description: m[2].trim(),
      issue: m[3] ? Number.parseInt(m[3], 10) : null,
      raw,
    };
  }
  const description = raw.replace(/^[-*]\s*/, "").trim();
  if (!description) return null;
  return { type: "other", description, issue: null, raw };
}

/** Parse a whole fragment file into its notes. */
export function parseFragment(content: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const line of content.split("\n")) {
    const note = parseNoteLine(line);
    if (note) notes.push(note);
  }
  return notes;
}

/**
 * Order notes by canonical Conventional-Commits type so same-type entries are
 * adjacent (the grouping the dashboard renders). Stable within a type.
 */
export function sortNotesByType(notes: ReleaseNote[]): ReleaseNote[] {
  const rank = (t: string): number => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => rank(a.note.type) - rank(b.note.type) || a.index - b.index)
    .map((x) => x.note);
}

// ---------------------------------------------------------------------------
// Per-root cache singleton
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: ProjectVersionsData;
  at: number;
}

// Module-owned (not threaded through the route) so dashboard traffic shares one
// cache across requests — the established pattern in src/health/deployed-sha.ts.
const cache = new Map<string, CacheEntry>();

/**
 * Test hook: drop the memoized per-root cache so the next read goes back to git.
 * Mirrors `resetDeployedShaCache()` / `resetDeployedVersionCache()` — this repo
 * has no module-reset harness, so a module owning a process-lifetime singleton
 * exports an explicit reset.
 */
export function resetVersionsCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// The git read
// ---------------------------------------------------------------------------

/** The degraded payload. A `code` of null means "tagless", not "broken". */
function noReleases(error: string | null): ProjectVersionsData {
  return { current: null, history: [], error };
}

/**
 * Read the tag-window changelog fragments for one release and fold them into
 * notes. A diff or show failure degrades THAT release's notes to `[]` — it never
 * fails the whole repo read.
 */
async function readWindowNotes(
  root: string,
  tag: string,
  prev: string,
  git: typeof defaultGitExec,
  budget: { reads: number },
): Promise<ReleaseNote[]> {
  const diff = await git(
    [
      "-C",
      root,
      "diff",
      "--diff-filter=A",
      "--name-only",
      `${prev}..${tag}`,
      "--",
      CHANGELOG_DIR,
    ],
    { timeout: GIT_TIMEOUT_MS },
  );
  if (isGhFailure(diff)) {
    logger.error(
      { root, tag, code: diff.code, stderr: diff.stderr.slice(0, 200) },
      "[versions] tag-window diff failed — release renders with no notes",
    );
    return [];
  }

  const paths = diff.data.stdout
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean)
    // git will NOT exclude .changelog/README.md — the app must.
    .filter(isFragmentPath);

  const notes: ReleaseNote[] = [];
  for (const p of paths) {
    if (budget.reads >= MAX_FRAGMENT_READS) {
      logger.error(
        { root, tag, cap: MAX_FRAGMENT_READS },
        "[versions] fragment-read budget exhausted — truncating release notes",
      );
      break;
    }
    budget.reads += 1;
    // Content is read AT THE TAG, not from the working tree: a fragment edited
    // or deleted after its release must still render its historical text.
    const shown = await git(["-C", root, "show", `${tag}:${p}`], {
      timeout: GIT_TIMEOUT_MS,
    });
    if (isGhFailure(shown)) {
      logger.error(
        { root, tag, path: p, code: shown.code, stderr: shown.stderr.slice(0, 200) },
        "[versions] fragment read failed — note omitted",
      );
      continue;
    }
    notes.push(...parseFragment(shown.data.stdout));
  }
  return sortNotesByType(notes);
}

/** Cold read of one repo root. Never throws — degrades instead. */
async function readVersionData(
  root: string,
  limit: number,
  git: typeof defaultGitExec,
): Promise<ProjectVersionsData> {
  try {
    const refs = await git(
      [
        "-C",
        root,
        "for-each-ref",
        "--sort=-v:refname",
        `--format=${TAG_FORMAT}`,
        "refs/tags/v*",
      ],
      { timeout: GIT_TIMEOUT_MS },
    );
    if (isGhFailure(refs)) {
      // A missing root, a non-repo, or a missing git binary lands here. Degrade
      // this ONE entry; siblings are unaffected.
      logger.error(
        { root, code: refs.code, stderr: refs.stderr.slice(0, 200) },
        "[versions] tag enumeration failed — degrading to no-releases",
      );
      return noReleases(refs.code);
    }

    const tags = parseTagRows(refs.data.stdout);
    // Tagless is a VALID steady state, not an error: exit 0 + empty stdout.
    if (tags.length === 0) return noReleases(null);

    const windowCount = Math.min(limit, tags.length);
    const budget = { reads: 0 };
    const history: VersionHistoryEntry[] = [];
    for (let i = 0; i < windowCount; i += 1) {
      const tag = tags[i];
      // Rows descend, so tags[i+1] is the PREVIOUS release. The oldest tag in
      // the repo has no predecessor — its window opens at the empty tree.
      const prev = i + 1 < tags.length ? tags[i + 1].version : EMPTY_TREE_SHA;
      const notes = await readWindowNotes(root, tag.version, prev, git, budget);
      history.push({ ...tag, notes });
    }

    return { current: tags[0], history, error: null };
  } catch (err: any) {
    // Belt-and-braces: gitExec never throws, so reaching here means a parse bug.
    // Fail loud, but still degrade rather than propagate (CLAUDE.md never-throw).
    logger.error(
      { root, err },
      "[versions] read threw despite never-throw contract — degrading",
    );
    return noReleases("versions-read-failed");
  }
}

// ---------------------------------------------------------------------------
// Public read surface
// ---------------------------------------------------------------------------

/**
 * Read one repository's version stream, served from the per-root cache when it
 * is inside {@link VERSIONS_CACHE_TTL_MS}. Never throws.
 */
export async function readProjectVersions(
  project: VersionProject,
  deps: ReadVersionsDeps = {},
): Promise<ProjectVersions> {
  const now = deps.now ?? Date.now;
  const git = deps.gitExec ?? defaultGitExec;
  const limit =
    deps.historyLimit ??
    resolveHistoryLimit(process.env.HYDRA_VERSIONS_HISTORY_LIMIT);

  const at = now();
  const hit = cache.get(project.root);
  if (hit && at - hit.at < VERSIONS_CACHE_TTL_MS) {
    return { name: project.name, scope: project.scope, ...hit.value };
  }

  const value = await readVersionData(project.root, limit, git);
  cache.set(project.root, { value, at });
  return { name: project.name, scope: project.scope, ...value };
}

/**
 * Read every configured repository, in roster order. Sequential by design: a
 * cold read forks git, and a dashboard hit must not fan out into a spawn storm.
 * One repo's failure degrades that entry only.
 */
export async function readAllVersions(
  deps: ReadVersionsDeps = {},
): Promise<ProjectVersions[]> {
  const projects = deps.projects ?? listVersionProjects();
  const out: ProjectVersions[] = [];
  for (const project of projects) {
    out.push(await readProjectVersions(project, deps));
  }
  return out;
}
