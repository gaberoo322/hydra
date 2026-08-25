/**
 * test/versions-format.test.mts — pins the pure half of the dashboard Versions
 * panel (issue #3681, epic #3676 epsilon; the commit-identity half is #4172).
 *
 * The dashboard has no component-test runner, so the panel's real decisions —
 * the current-vs-older release split, the three degraded states, the note
 * grouping order, and how a tagless Target's commit identity renders — live in
 * `dashboard/src/lib/versions-format.ts` precisely so they can be asserted here
 * (the `test/page-item-format.test.mts` precedent, issue #822).
 *
 * The headline invariant is the DOUBLE-RENDER trap: `/api/versions` returns
 * `current` WITHOUT notes and `history[0]` as the same release WITH notes, so a
 * consumer that renders both shows the newest release twice. `splitReleases`
 * owns that split and is pinned hardest below.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_TYPE_ORDER,
  noteTypeLabel,
  groupNotesByType,
  splitReleases,
  projectState,
  formatVersion,
  currentVersionLabel,
  badgeVersionLabel,
  isCommitIdentity,
  commitIdentityLabel,
  formatReleaseDate,
  shortSha,
  versionAnchorId,
  versionAnchorHref,
  issueUrl,
  ERROR_PLACEHOLDER,
  EMPTY_PLACEHOLDER,
  type ProjectVersions,
  type ReleaseNote,
} from "../dashboard/src/lib/versions-format.ts";

/** Build a note with only the fields a test cares about. */
function note(type: string, description: string, issue: number | null = null): ReleaseNote {
  return { type, description, issue, raw: `- ${type}: ${description}` };
}

/** A healthy two-release project: v1.1.0 current, v1.0.0 older. */
function healthyProject(): ProjectVersions {
  return {
    name: "hydra",
    scope: "orch",
    current: { version: "v1.1.0", date: "2026-07-20T00:00:00.000Z", sha: "abcdef1234567890" },
    history: [
      {
        version: "v1.1.0",
        date: "2026-07-20T00:00:00.000Z",
        sha: "abcdef1234567890",
        notes: [note("feat", "versions panel", 3681)],
      },
      {
        version: "v1.0.0",
        date: "2026-07-10T00:00:00.000Z",
        sha: "0123456789abcdef",
        notes: [note("fix", "deploy stamp", 3733)],
      },
    ],
    error: null,
  };
}

/**
 * A tagless Target reporting commit identity (#4172). `dirty` defaults false;
 * pass true for the live-tree case. `shortSha` renders `b824716` from this sha.
 */
function identityProject(dirty = false): ProjectVersions {
  return {
    name: "hydra-betting",
    scope: "target",
    current: {
      sha: "b824716d2ea4f9d3c8d0e5f6a7b8c9d0e1f2a3b4",
      date: "2026-08-19T14:03:00-07:00",
      dirty,
    },
    history: [],
    error: null,
  };
}

describe("versions-format: note grouping", () => {
  test("groups by type and orders by NOTE_TYPE_ORDER, not by arrival", () => {
    const groups = groupNotesByType([
      note("chore", "bump deps"),
      note("feat", "panel"),
      note("fix", "badge"),
      note("feat", "footer chip"),
    ]);

    assert.deepEqual(
      groups.map((g) => g.type),
      ["feat", "fix", "chore"],
    );
    // Order WITHIN a group is preserved from the wire.
    assert.deepEqual(
      groups[0].notes.map((n) => n.description),
      ["panel", "footer chip"],
    );
  });

  test("an unknown type is kept, labelled by its own name, and sorted last", () => {
    const groups = groupNotesByType([note("wibble", "mystery"), note("feat", "known")]);

    assert.deepEqual(
      groups.map((g) => g.type),
      ["feat", "wibble"],
    );
    assert.equal(groups[1].label, "wibble");
  });

  test("two unknown types sort alphabetically between themselves", () => {
    const groups = groupNotesByType([note("zeta", "z"), note("alpha", "a")]);
    assert.deepEqual(
      groups.map((g) => g.type),
      ["alpha", "zeta"],
    );
  });

  test("a blank or missing type is normalised into the 'other' bucket", () => {
    const groups = groupNotesByType([note("", "unlabelled"), note("   ", "whitespace")]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, "other");
    assert.equal(groups[0].notes.length, 2);
  });

  test("type matching is case-insensitive", () => {
    const groups = groupNotesByType([note("FEAT", "shouty"), note("feat", "quiet")]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, "feat");
  });

  test("null / empty / all-null input yields no groups rather than throwing", () => {
    assert.deepEqual(groupNotesByType(null), []);
    assert.deepEqual(groupNotesByType(undefined), []);
    assert.deepEqual(groupNotesByType([]), []);
    assert.deepEqual(groupNotesByType([null as unknown as ReleaseNote]), []);
  });

  test("every ordered type has a human label", () => {
    for (const type of NOTE_TYPE_ORDER) {
      assert.equal(typeof noteTypeLabel(type), "string");
      assert.ok(noteTypeLabel(type).length > 0);
    }
    assert.equal(noteTypeLabel("feat"), "Features");
  });

  test("NOTE_TYPE_ORDER mirrors the server's TYPE_ORDER, including revert", () => {
    // src/versions/read-versions.ts's TYPE_ORDER is the canonical order notes
    // arrive in; the dashboard groups by type but must never disagree about
    // where a known type sorts. "other" is dashboard-only (the server's
    // unknown-type fallback sorts last in first-seen order instead).
    assert.deepEqual(NOTE_TYPE_ORDER, [
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
      "other",
    ]);
    assert.equal(noteTypeLabel("revert"), "Reverts");
  });

  test("a revert note sorts in its canonical slot, not last as unknown", () => {
    const groups = groupNotesByType([
      note("chore", "bump deps"),
      note("revert", "undo the bad migration"),
      note("feat", "panel"),
    ]);

    assert.deepEqual(
      groups.map((g) => g.type),
      ["feat", "chore", "revert"],
    );
  });
});

describe("versions-format: splitReleases (the double-render guard)", () => {
  test("the current release is returned WITH its notes and never repeats in older", () => {
    const { current, older } = splitReleases(healthyProject());

    assert.equal(current?.version, "v1.1.0");
    assert.deepEqual(
      current?.notes.map((n) => n.description),
      ["versions panel"],
    );
    assert.deepEqual(
      older.map((e) => e.version),
      ["v1.0.0"],
    );
  });

  test("the current release is excluded from older even when it is NOT history[0]", () => {
    // Defensive: the aggregator's ordering is not something the panel relies on.
    const project = healthyProject();
    project.history.reverse();

    const { current, older } = splitReleases(project);

    assert.equal(current?.version, "v1.1.0");
    assert.deepEqual(
      older.map((e) => e.version),
      ["v1.0.0"],
    );
  });

  test("a current tag with no matching history entry still renders, note-less", () => {
    const project = healthyProject();
    project.current = { version: "v2.0.0", date: "2026-07-29T00:00:00.000Z", sha: "feedface" };

    const { current, older } = splitReleases(project);

    assert.equal(current?.version, "v2.0.0");
    assert.deepEqual(current?.notes, []);
    // Nothing is dropped: both known releases remain visible as older.
    assert.deepEqual(
      older.map((e) => e.version),
      ["v1.1.0", "v1.0.0"],
    );
  });

  test("a tagless project has no current release and no older ones", () => {
    const project: ProjectVersions = {
      name: "hydra-betting",
      scope: "target",
      current: null,
      history: [],
      error: null,
    };
    assert.deepEqual(splitReleases(project), { current: null, older: [] });
  });

  test("history without a current tag is still surfaced as older, not discarded", () => {
    const project = healthyProject();
    project.current = null;

    const { current, older } = splitReleases(project);

    assert.equal(current, null);
    assert.deepEqual(
      older.map((e) => e.version),
      ["v1.1.0", "v1.0.0"],
    );
  });

  test("null / undefined project degrades instead of throwing", () => {
    assert.deepEqual(splitReleases(null), { current: null, older: [] });
    assert.deepEqual(splitReleases(undefined), { current: null, older: [] });
  });

  test("a commit-identity project has no current RELEASE and never double-renders (#4172)", () => {
    // The Target's `current` is a CommitIdentity, not a VersionRef. It must not
    // be promoted into a note-less synthetic release (that path is for a TAG
    // with no matching history entry) — the identity renders from
    // project.current itself in the card, never through splitReleases.
    const project = identityProject();
    assert.deepEqual(splitReleases(project), { current: null, older: [] });

    // Defensive: stray history entries are still surfaced as older, not eaten.
    const stray = identityProject();
    stray.history = healthyProject().history;
    const { current, older } = splitReleases(stray);
    assert.equal(current, null);
    assert.deepEqual(older.map((e) => e.version), ["v1.1.0", "v1.0.0"]);
  });
});

describe("versions-format: degraded states", () => {
  test("a healthy tagged project is ok", () => {
    assert.equal(projectState(healthyProject()), "ok");
  });

  test("a tagless project is empty, NOT an error", () => {
    const project = healthyProject();
    project.current = null;
    project.history = [];
    assert.equal(projectState(project), "empty");
  });

  test("error wins over empty so a failed read is never read as 'never tagged'", () => {
    const project = healthyProject();
    project.current = null;
    project.history = [];
    project.error = "gh-timeout";
    assert.equal(projectState(project), "error");
  });

  test("an error alongside a current tag still renders as error", () => {
    const project = healthyProject();
    project.error = "gh-partial";
    assert.equal(projectState(project), "error");
  });

  test("a missing project entry is treated as an error", () => {
    assert.equal(projectState(null), "error");
    assert.equal(projectState(undefined), "error");
  });

  test("currentVersionLabel renders the issue's three specified states", () => {
    const ok = healthyProject();
    assert.equal(currentVersionLabel(ok), "v1.1.0");

    const empty = healthyProject();
    empty.current = null;
    empty.history = [];
    assert.equal(currentVersionLabel(empty), EMPTY_PLACEHOLDER);

    const errored = healthyProject();
    errored.error = "gh-timeout";
    assert.equal(currentVersionLabel(errored), ERROR_PLACEHOLDER);
  });

  test("the compact badge label collapses BOTH degraded states to a dash", () => {
    const empty = healthyProject();
    empty.current = null;
    empty.history = [];
    assert.equal(badgeVersionLabel(empty), ERROR_PLACEHOLDER);

    const errored = healthyProject();
    errored.error = "gh-timeout";
    assert.equal(badgeVersionLabel(errored), ERROR_PLACEHOLDER);

    assert.equal(badgeVersionLabel(healthyProject()), "v1.1.0");
  });

  test("a commit-identity project is ok — not 'empty', not an error (#4172)", () => {
    // The whole point of #4172: a read that succeeds must not render as the
    // "never been tagged" empty state nor as a failure.
    assert.equal(projectState(identityProject()), "ok");
    assert.equal(projectState(identityProject(true)), "ok");
  });

  test("currentVersionLabel renders the short sha, marked when dirty (#4172)", () => {
    assert.equal(currentVersionLabel(identityProject()), "b824716");
    // The trailing `*` is the compact dirty flag (`git describe --dirty`
    // convention) — the card body carries the explicit chip.
    assert.equal(currentVersionLabel(identityProject(true)), "b824716*");
  });

  test("the badge renders the same identity label as the card (#4172)", () => {
    // The two consumers must agree — that agreement is this module's reason
    // for existing. A blank chip (the pre-#4172 `formatVersion(undefined)`)
    // is exactly the regression this pins out.
    assert.equal(badgeVersionLabel(identityProject()), "b824716");
    assert.equal(badgeVersionLabel(identityProject(true)), "b824716*");
  });
});

describe("versions-format: misc formatting", () => {
  test("formatVersion normalises to exactly one leading v", () => {
    assert.equal(formatVersion("1.2.3"), "v1.2.3");
    assert.equal(formatVersion("v1.2.3"), "v1.2.3");
    assert.equal(formatVersion("  1.2.3  "), "v1.2.3");
    assert.equal(formatVersion(""), "");
    assert.equal(formatVersion(null), "");
    assert.equal(formatVersion(undefined), "");
  });

  test("formatReleaseDate degrades instead of rendering 'Invalid Date'", () => {
    assert.equal(formatReleaseDate(null), ERROR_PLACEHOLDER);
    assert.equal(formatReleaseDate(""), ERROR_PLACEHOLDER);
    assert.equal(formatReleaseDate("not-a-date"), ERROR_PLACEHOLDER);
    assert.notEqual(formatReleaseDate("2026-07-20T00:00:00.000Z"), ERROR_PLACEHOLDER);
  });

  test("shortSha truncates to 7 and degrades when absent", () => {
    assert.equal(shortSha("abcdef1234567890"), "abcdef1");
    assert.equal(shortSha(""), ERROR_PLACEHOLDER);
    assert.equal(shortSha(null), ERROR_PLACEHOLDER);
  });

  test("isCommitIdentity discriminates the two current shapes (#4172)", () => {
    assert.equal(isCommitIdentity(identityProject().current), true);
    assert.equal(isCommitIdentity(identityProject(true).current), true);
    assert.equal(isCommitIdentity(healthyProject().current), false, "a VersionRef is not an identity");
    assert.equal(isCommitIdentity(null), false);
  });

  test("commitIdentityLabel degrades like every other label (#4172)", () => {
    assert.equal(commitIdentityLabel(undefined), ERROR_PLACEHOLDER);
    assert.equal(commitIdentityLabel(null), ERROR_PLACEHOLDER);
  });

  test("the badge href and the panel's anchor id agree on a single, panel-wide anchor", () => {
    // Every project chip jumps to the SAME panel anchor — the artifact's
    // contract is one id="versions" on the panel, not one per project.
    assert.equal(versionAnchorId(), "versions");
    assert.equal(versionAnchorHref(), "/#versions");
    // Today lives at "/", so the href must not name a /today path.
    assert.ok(!versionAnchorHref().includes("/today"));
  });

  test("issueUrl routes each scope at its OWN repository", () => {
    assert.equal(issueUrl("orch", 3681), "https://github.com/gaberoo322/hydra/issues/3681");
    assert.equal(
      issueUrl("target", 592),
      "https://github.com/gaberoo322/hydra-betting/issues/592",
    );
  });

  test("issueUrl returns null when no link can be built", () => {
    assert.equal(issueUrl("orch", null), null);
    assert.equal(issueUrl("orch", undefined), null);
    assert.equal(issueUrl("orch", 0), null);
    assert.equal(issueUrl("orch", -1), null);
    assert.equal(issueUrl("orch", Number.NaN), null);
    // An unrecognised scope must never guess a repository.
    assert.equal(issueUrl("mystery", 1), null);
    assert.equal(issueUrl("", 1), null);
  });
});
