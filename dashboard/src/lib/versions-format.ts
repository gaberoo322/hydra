/**
 * dashboard/src/lib/versions-format.ts — the pure half of the Versions panel
 * (issue #3681, epic #3676 epsilon; wayfinder ticket #3660).
 *
 * `GET /api/versions` (#3680) returns `{ projects: ProjectVersions[], generatedAt }`.
 * The two consumers this seam feeds — the Today-page Versions panel
 * (`components/Versions.jsx`) and the always-on footer badge
 * (`components/VersionBadge.jsx`) — must agree exactly on three decisions:
 *
 *   1. Which release is "current", and which of `history[]` are the "older" ones.
 *   2. What a degraded project renders as ("no releases yet" vs "—").
 *   3. How notes are grouped and ordered inside a release.
 *
 * Lifting those decisions here (the `page-item-format.ts` precedent, issue #822)
 * keeps the two components from drifting AND makes the logic unit-testable —
 * the dashboard has no component-test runner, so a pure module tested from
 * `test/versions-format.test.mts` is the only way to pin this behaviour.
 *
 * THE DOUBLE-RENDER TRAP this module exists to prevent: per #3680's contract,
 * `current` carries NO notes while `history[0]` is *the same release* WITH its
 * notes. A naive consumer renders the newest release twice — once from
 * `current` and again at the head of the "older versions" list. {@link
 * splitReleases} is the single place that split is made.
 */

// ---------------------------------------------------------------------------
// Wire types (structural mirrors of src/versions/read-versions.ts)
// ---------------------------------------------------------------------------

/** One curated line from one `.changelog/` fragment (#3678). */
export interface ReleaseNote {
  /** Conventional-Commits type, lowercased. `"other"` when unparseable. */
  type: string;
  description: string;
  /** The issue the note references (NOT the PR), or null. */
  issue: number | null;
  raw: string;
}

/** A release pointer: the tag, when it was cut, and the commit it points at. */
export interface VersionRef {
  version: string;
  date: string;
  sha: string;
}

/** A release plus everything that shipped in its tag window. */
export interface VersionHistoryEntry extends VersionRef {
  notes: ReleaseNote[];
}

/** One entry of the wire `projects` array. */
export interface ProjectVersions {
  name: string;
  scope: string;
  current: VersionRef | null;
  history: VersionHistoryEntry[];
  /** A failure code when the read degraded, else null. Tagless is NOT an error. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Note grouping
// ---------------------------------------------------------------------------

/**
 * Display order for Conventional-Commits types — most operator-relevant first.
 * A type absent from this list sorts alphabetically AFTER every known type, so
 * an unrecognised type is still rendered rather than silently dropped.
 */
export const NOTE_TYPE_ORDER: readonly string[] = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "other",
];

/** Human-facing heading per type; unknown types fall back to the raw type. */
export const NOTE_TYPE_LABEL: Readonly<Record<string, string>> = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  refactor: "Refactors",
  docs: "Docs",
  test: "Tests",
  build: "Build",
  ci: "CI",
  chore: "Chores",
  other: "Other",
};

/** The heading for a note type. Unknown types render their own name. */
export function noteTypeLabel(type: string): string {
  const key = (type || "").trim().toLowerCase();
  if (!key) return NOTE_TYPE_LABEL.other;
  return NOTE_TYPE_LABEL[key] ?? key;
}

/** One rendered group of notes sharing a type. */
export interface NoteGroup {
  type: string;
  label: string;
  notes: ReleaseNote[];
}

/**
 * Group a release's notes by Conventional-Commits type, ordered by
 * {@link NOTE_TYPE_ORDER} (unknown types alphabetically last). Note order
 * WITHIN a group is preserved from the wire — the aggregator already emits
 * them in fragment order, and re-sorting would scramble a curated sequence.
 *
 * A missing/blank type is normalised to `"other"` so it still lands in a group
 * rather than creating an unlabelled bucket.
 */
export function groupNotesByType(notes: ReleaseNote[] | null | undefined): NoteGroup[] {
  const buckets = new Map<string, ReleaseNote[]>();

  for (const note of notes ?? []) {
    if (!note) continue;
    const type = (note.type || "").trim().toLowerCase() || "other";
    const existing = buckets.get(type);
    if (existing) existing.push(note);
    else buckets.set(type, [note]);
  }

  return [...buckets.entries()]
    .map(([type, groupNotes]) => ({ type, label: noteTypeLabel(type), notes: groupNotes }))
    .sort((a, b) => {
      const ai = NOTE_TYPE_ORDER.indexOf(a.type);
      const bi = NOTE_TYPE_ORDER.indexOf(b.type);
      if (ai !== -1 && bi !== -1) return ai - bi;
      // A known type always precedes an unknown one.
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.type.localeCompare(b.type);
    });
}

// ---------------------------------------------------------------------------
// Current-vs-older split
// ---------------------------------------------------------------------------

/** The result of splitting a project's release stream. */
export interface ReleaseSplit {
  /**
   * The current release WITH its notes — the `history` entry whose version
   * matches `current.version`. Null when the project is tagless, degraded, or
   * when `current` has no matching history entry (in which case a note-less
   * synthetic entry is produced instead, so the version still renders).
   */
  current: VersionHistoryEntry | null;
  /** Every OTHER release, newest first — never includes `current`. */
  older: VersionHistoryEntry[];
}

/**
 * Split a project's releases into the current one (with notes) and the older
 * ones, without ever rendering the newest release twice.
 *
 * `current` carries no notes on the wire, so the notes are recovered by
 * matching `current.version` against `history[]`. When no history entry matches
 * (a defensive case: a tag newer than the aggregator's history window), a
 * synthetic note-less entry is returned so the operator still sees the version
 * number rather than "no releases yet".
 */
export function splitReleases(project: ProjectVersions | null | undefined): ReleaseSplit {
  const history = (project?.history ?? []).filter(Boolean);
  const currentRef = project?.current ?? null;

  if (!currentRef) {
    // Tagless (or degraded): there is no current release to promote, but any
    // history entries that DID come back are still worth showing as older.
    return { current: null, older: history };
  }

  const index = history.findIndex((entry) => entry.version === currentRef.version);
  if (index === -1) {
    return {
      current: { ...currentRef, notes: [] },
      older: history,
    };
  }

  return {
    current: history[index],
    older: history.filter((_, i) => i !== index),
  };
}

// ---------------------------------------------------------------------------
// Degraded-state rendering
// ---------------------------------------------------------------------------

/** Rendering mode for one project card / badge chip. */
export type ProjectState = "error" | "empty" | "ok";

/**
 * Which of the three states a project renders in.
 *
 * `error` wins over `empty`: a degraded read that happens to return no tags
 * must not be mistaken for a healthy tagless repository, because the two call
 * for opposite operator responses (investigate vs. cut a release).
 */
export function projectState(project: ProjectVersions | null | undefined): ProjectState {
  if (!project) return "error";
  if (project.error) return "error";
  if (!project.current) return "empty";
  return "ok";
}

/** The dash rendered wherever a version is unknowable because the read failed. */
export const ERROR_PLACEHOLDER = "—";

/** The prose rendered for a healthy repository that has never been tagged. */
export const EMPTY_PLACEHOLDER = "no releases yet";

/**
 * Normalise a tag to a single leading `v` (`1.2.3` and `v1.2.3` both render
 * `v1.2.3`), so a repo that changes its tag prefix doesn't change the UI.
 */
export function formatVersion(version: string | null | undefined): string {
  const raw = (version || "").trim();
  if (!raw) return "";
  return raw.startsWith("v") ? raw : `v${raw}`;
}

/**
 * The version string for a project, already degraded: `—` on error,
 * `no releases yet` when tagless, else the normalised tag.
 */
export function currentVersionLabel(project: ProjectVersions | null | undefined): string {
  const state = projectState(project);
  if (state === "error") return ERROR_PLACEHOLDER;
  if (state === "empty") return EMPTY_PLACEHOLDER;
  return formatVersion(project?.current?.version);
}

/**
 * The COMPACT label for the footer chip, where horizontal space is scarce: a
 * tagless project collapses to the same `—` as an errored one (the panel is
 * where the two are distinguished in prose).
 */
export function badgeVersionLabel(project: ProjectVersions | null | undefined): string {
  const state = projectState(project);
  if (state === "ok") return formatVersion(project?.current?.version);
  return ERROR_PLACEHOLDER;
}

// ---------------------------------------------------------------------------
// Misc formatting
// ---------------------------------------------------------------------------

/**
 * A short human release date (`Jul 29, 2026`) in the viewer's locale.
 * An absent or unparseable date renders {@link ERROR_PLACEHOLDER} rather than
 * `Invalid Date`.
 */
export function formatReleaseDate(iso: string | null | undefined): string {
  if (!iso) return ERROR_PLACEHOLDER;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return ERROR_PLACEHOLDER;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The first 7 characters of a commit sha, or `—` when absent. */
export function shortSha(sha: string | null | undefined): string {
  const raw = (sha || "").trim();
  return raw ? raw.slice(0, 7) : ERROR_PLACEHOLDER;
}

/**
 * The DOM id of a project's card in the Versions panel. The footer badge links
 * to `/#<this id>`, so both sides derive it from here rather than hard-coding
 * a string that could drift.
 */
export function versionAnchorId(scope: string | null | undefined): string {
  const raw = (scope || "").trim() || "unknown";
  return `versions-${raw}`;
}

/** The route + hash the footer chip navigates to (Today lives at `/`). */
export function versionAnchorHref(scope: string | null | undefined): string {
  return `/#${versionAnchorId(scope)}`;
}

/**
 * Which GitHub repository a scope's issues live in. A release note's `issue`
 * number is only meaningful against its OWN repo — linking a Target note at
 * `gaberoo322/hydra` would silently point at an unrelated Orchestrator issue.
 */
export const SCOPE_REPO: Readonly<Record<string, string>> = {
  orch: "gaberoo322/hydra",
  target: "gaberoo322/hydra-betting",
};

/**
 * The GitHub issue URL for a note, or null when it can't be built (no issue
 * number, or a scope with no known repo). Callers render plain text on null
 * rather than a link to nowhere.
 */
export function issueUrl(
  scope: string | null | undefined,
  issue: number | null | undefined,
): string | null {
  if (typeof issue !== "number" || !Number.isFinite(issue) || issue <= 0) return null;
  const repo = SCOPE_REPO[(scope || "").trim()];
  if (!repo) return null;
  return `https://github.com/${repo}/issues/${issue}`;
}
