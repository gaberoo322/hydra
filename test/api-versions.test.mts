/**
 * GET /api/versions regression tests (issue #3680, epic #3676 delta; the
 * tagless-TARGET half rewritten for #4172's commit-identity decision).
 *
 * THE TAGLESS REPO IS THE HEADLINE CASE — read this before adding cases.
 * Verified 2026-07-25: ~/hydra had ZERO tags at #3680's merge (it has since
 * been stamping deploy tags), and ~/hydra-betting has zero tags and no
 * .changelog/ directory at all — the Target has NO deploy path
 * (hydra-betting#743), so nothing will ever stamp a semver there. #4172's
 * operator decision: a tagless TARGET reports COMMIT IDENTITY
 * (`{ sha, date, dirty }`) instead of an empty card, while a tagless ORCH repo
 * keeps returning `{ current: null, history: [], error: null }` ("no releases
 * yet"). Both are the PRIMARY path, not edge cases — a reviewer seeing either
 * live must NOT read it as a bug. They are therefore the first suite here.
 *
 * The remaining suites pin the four traps a sandbox proved would otherwise ship
 * silently, each of which is invisible in the empty-repo response:
 *   1. `git describe` must never be used — it exits 128 on a tagless repo, so a
 *      describe-based read would fail 100% of requests today.
 *   2. The commit sha must come from `%(*objectname)`; `%(objectname)` on an
 *      ANNOTATED tag is the tag-object sha, which matches no commit.
 *   3. The sort must be `-v:refname`; lexical order puts v1.9.0 above v1.10.0.
 *   4. `-- .changelog/` does not exclude README.md — the app must filter it, or
 *      the convention doc renders as a release note.
 *
 * No real git process, no Redis, no live Express server: the git seam and the
 * clock are injected, and the route handler is called directly (the
 * test/taxonomy-route.test.mts + test/deployed-version.test.mts patterns).
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createVersionsRouter,
  type VersionsRouterDeps,
} from "../src/api/versions.ts";
import {
  readAllVersions,
  resetVersionsCache,
  parseTagRows,
  parseCommitRow,
  parseNoteLine,
  parseFragment,
  isFragmentPath,
  sortNotesByType,
  resolveHistoryLimit,
  EMPTY_TREE_SHA,
  DEFAULT_HISTORY_LIMIT,
  VERSIONS_CACHE_TTL_MS,
  type VersionRef,
} from "../src/versions/read-versions.ts";
import { listVersionProjects } from "../src/versions/project-list.ts";
import type { VersionProject } from "../src/versions/project-list.ts";
import type { gitExec as GitExecFn } from "../src/github/git.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-07-25T12:00:00.000Z");

const ORCH: VersionProject = {
  name: "hydra",
  scope: "orch",
  root: "/fake/orch",
};
const TARGET: VersionProject = {
  name: "hydra-betting",
  scope: "target",
  root: "/fake/target",
};
const PROJECTS = [ORCH, TARGET];

/**
 * A per-root script for the fake git seam. Any key left unset behaves like the
 * real thing on a tagless / empty repo: exit 0 with empty stdout (except `head`,
 * which defaults to a valid `git log -1` line — a real checkout has a HEAD).
 */
interface RootScript {
  /** `for-each-ref` stdout. Empty string = tagless repo (exit 0, no output). */
  tags?: string;
  /** When set, `for-each-ref` returns the FAILURE arm with this code. */
  tagsFailCode?: string;
  /** Keyed by the literal `<prev>..<tag>` range argument. */
  diffs?: Record<string, string>;
  /** Keyed by the literal `<tag>:<path>` argument. */
  shows?: Record<string, string>;
  /** `git log -1 --format=%H|%cI` stdout for the #4172 commit-identity read. */
  head?: string;
  /** When set, the commit-identity `git log -1` fails with this code. */
  headFailCode?: string;
  /**
   * `git status --porcelain` stdout. Empty string (the default) = clean tree.
   */
  status?: string;
  /** When set, the dirty-check `git status --porcelain` fails with this code. */
  statusFailCode?: string;
}

interface FakeGit {
  impl: typeof GitExecFn;
  calls: string[][];
}

/**
 * Build a gitExec stub driven by a per-root script. Records every argv so the
 * tests can assert on HOW git was invoked (the sort flag, the format string,
 * the absence of `describe`) and not just on the parsed output.
 */
function scriptedGit(scripts: Record<string, RootScript>): FakeGit {
  const calls: string[][] = [];
  const impl = (async (args: string[]) => {
    calls.push([...args]);
    // Every invocation is `-C <root> <subcommand> ...`.
    const root = args[1];
    const sub = args[2];
    const script = scripts[root] ?? {};

    if (sub === "for-each-ref") {
      if (script.tagsFailCode) {
        return {
          ok: false as const,
          code: script.tagsFailCode as any,
          stderr: "fatal: not a git repository",
        };
      }
      return {
        ok: true as const,
        data: { stdout: script.tags ?? "", stderr: "" },
      };
    }
    if (sub === "diff") {
      // ["-C", root, "diff", "--diff-filter=A", "--name-only", range, "--", dir]
      const range = args[5];
      return {
        ok: true as const,
        data: { stdout: script.diffs?.[range] ?? "", stderr: "" },
      };
    }
    if (sub === "show") {
      // ["-C", root, "show", "<tag>:<path>"]
      const spec = args[3];
      const content = script.shows?.[spec];
      if (content === undefined) {
        return {
          ok: false as const,
          code: "gh-failed" as any,
          stderr: `fatal: path does not exist: ${spec}`,
        };
      }
      return { ok: true as const, data: { stdout: content, stderr: "" } };
    }
    if (sub === "log") {
      // ["-C", root, "log", "-1", "--format=..."] — the #4172 identity read.
      if (script.headFailCode) {
        return {
          ok: false as const,
          code: script.headFailCode as any,
          stderr: "fatal: your current branch does not have any commits yet",
        };
      }
      return {
        ok: true as const,
        data: { stdout: `${script.head ?? DEFAULT_HEAD_LINE}\n`, stderr: "" },
      };
    }
    if (sub === "status") {
      // ["-C", root, "status", "--porcelain"] — the #4172 dirty check.
      if (script.statusFailCode) {
        return {
          ok: false as const,
          code: script.statusFailCode as any,
          stderr: "fatal: not a git repository",
        };
      }
      return {
        ok: true as const,
        data: { stdout: script.status ?? "", stderr: "" },
      };
    }
    return { ok: false as const, code: "gh-failed" as any, stderr: "unexpected" };
  }) as unknown as typeof GitExecFn;
  return { impl, calls };
}

/**
 * A populated orchestrator fixture. Note the tag order: v1.10.0 sits ABOVE
 * v1.9.0, which is what `--sort=-v:refname` produces and what
 * `--sort=-refname` (lexical) would get WRONG.
 */
const POPULATED_TAGS = [
  "v1.10.0|2026-07-25T17:38:52-07:00|aaaa111commitsha",
  "v1.9.0|2026-07-20T10:00:00-07:00|bbbb222commitsha",
  "v1.0.0|2026-07-01T09:00:00-07:00|cccc333commitsha",
].join("\n");

const POPULATED_ORCH: RootScript = {
  tags: POPULATED_TAGS,
  diffs: {
    // Newest window: two fragments, deliberately fix-before-feat on disk so the
    // type ordering is observable in the output.
    "v1.9.0..v1.10.0":
      ".changelog/3677-tag-at-deploy.md\n.changelog/3680-versions-api.md\n",
    // Middle window: git returns README.md alongside a real fragment.
    "v1.0.0..v1.9.0": ".changelog/README.md\n.changelog/3600-tidy.md\n",
    // Oldest tag has no predecessor — the window opens at the empty tree.
    [`${EMPTY_TREE_SHA}..v1.0.0`]: ".changelog/1-genesis.md\n.changelog/README.md\n",
  },
  shows: {
    "v1.10.0:.changelog/3677-tag-at-deploy.md":
      "- fix: stamp the deploy tag idempotently (#3677)\n",
    "v1.10.0:.changelog/3680-versions-api.md":
      "- feat: add the GET /api/versions read surface (#3680)\n",
    "v1.9.0:.changelog/3600-tidy.md": "- chore: tidy the thing (#3600)\n",
    "v1.0.0:.changelog/1-genesis.md": "- feat: first release (#1)\n",
  },
};

// ---------------------------------------------------------------------------
// The #4172 commit-identity fixture — what a tagless Target checkout reports
// ---------------------------------------------------------------------------

/** A plausible full `%H` sha for the Target workspace's HEAD. */
const TARGET_HEAD_SHA = "b824716d2ea4f9d3c8d0e5f6a7b8c9d0e1f2a3b4";
/** A plausible strict-ISO `%cI` committer date for that commit. */
const TARGET_HEAD_DATE = "2026-08-19T14:03:00-07:00";
/** The default `git log -1 --format=%H|%cI` line every unset `head` serves. */
const DEFAULT_HEAD_LINE = `${TARGET_HEAD_SHA}|${TARGET_HEAD_DATE}`;

// ---------------------------------------------------------------------------
// Route harness (mirrors test/taxonomy-route.test.mts)
// ---------------------------------------------------------------------------

function mockReq(): any {
  return { method: "GET", url: "/versions", headers: {}, query: {}, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

async function callRoute(deps: VersionsRouterDeps = {}) {
  const router = createVersionsRouter({ now: () => NOW_MS, projects: PROJECTS, ...deps });
  const handler = findHandler(router, "GET", "/versions");
  assert.ok(handler, "GET /versions handler must exist");
  const res = mockRes();
  await handler!(mockReq(), res);
  return res;
}

// ===========================================================================
// 1. THE HEADLINE CASE — both repositories are tagless today: the ORCH card is
//    the "no releases yet" empty state, the TARGET card reports commit identity
//    (#4172 — the Target has no deploy path, so no semver will ever be stamped
//    there; reporting the checked-out commit + a dirty flag is what IS honest).
// ===========================================================================

describe("GET /api/versions — the tagless path: orch empty, target commit identity (#3680, #4172)", () => {
  beforeEach(() => resetVersionsCache());

  test("a tagless ORCH repo returns current:null/history:[] and NO error", async () => {
    // for-each-ref on a tagless repo exits 0 with empty stdout — the live state
    // of the Orchestrator before its first deploy tag, and NOT a failure.
    const git = scriptedGit({ "/fake/orch": {}, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    assert.equal(res._status, 200);
    assert.equal(res._body.projects.length, 2);
    const orch = res._body.projects[0];
    assert.equal(orch.current, null, "a tagless repo has no current release");
    assert.deepEqual(orch.history, []);
    assert.equal(
      orch.error,
      null,
      "zero tags is a valid steady state — it must NOT be reported as an error",
    );
  });

  test("a tagless TARGET reports commit identity instead of an empty card (#4172)", async () => {
    const git = scriptedGit({ "/fake/orch": {}, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    assert.equal(res._status, 200);
    const target = res._body.projects[1];
    assert.equal(target.scope, "target");
    assert.equal(target.error, null, "a tagless Target is not an error");
    // deepEqual (strict) pins the SHAPE: exactly sha/date/dirty — no `version`
    // field pretending a semver exists, and no notes key.
    assert.deepEqual(target.current, {
      sha: TARGET_HEAD_SHA,
      date: TARGET_HEAD_DATE,
      dirty: false,
    });
  });

  test("the Target's dirty flag is true on an untracked file, an uncommitted edit, or both", async () => {
    // The live ~/hydra-betting tree carries untracked files — the exact case
    // `dirty` exists to surface.
    for (const status of [
      "?? scratch-notes.md\n", // untracked only
      " M web/src/lib/thing.ts\n", // unstaged modification
      "M  web/src/lib/thing.ts\n", // staged modification
      " M web/src/lib/thing.ts\n?? scratch-notes.md\n", // both at once
    ]) {
      const git = scriptedGit({ "/fake/orch": {}, "/fake/target": { status } });
      const res = await callRoute({ gitExec: git.impl });
      assert.equal(
        res._body.projects[1].current.dirty,
        true,
        `expected dirty:true for porcelain output ${JSON.stringify(status)}`,
      );
    }
  });

  test("the Target's commit identity synthesises no pseudo-history (#4172)", async () => {
    const git = scriptedGit({
      "/fake/orch": {},
      "/fake/target": { status: "?? scratch-notes.md\n" },
    });
    const res = await callRoute({ gitExec: git.impl });

    const target = res._body.projects[1];
    assert.deepEqual(target.history, [], "recent commits must not masquerade as releases");
    assert.deepEqual(target.current, {
      sha: TARGET_HEAD_SHA,
      date: TARGET_HEAD_DATE,
      dirty: true,
    });
  });

  test("a Target WITH tags reports semver, not commit identity (the upgrade path)", async () => {
    // #4172 is strictly upgradeable: if hydra-betting#743 ever delivers a deploy
    // path, the semver read must take over without unwinding anything.
    const git = scriptedGit({
      "/fake/orch": {},
      "/fake/target": { tags: "v0.1.0|2026-07-02T09:00:00-07:00|dddd444commitsha" },
    });
    const res = await callRoute({ gitExec: git.impl });

    const target = res._body.projects[1];
    assert.equal(target.current.version, "v0.1.0");
    assert.equal("dirty" in target.current, false, "a tagged repo reports a release, not a tree");
  });

  test("the tagless response still carries the project identity for both scopes", async () => {
    const git = scriptedGit({ "/fake/orch": {}, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    assert.deepEqual(
      res._body.projects.map((p: any) => p.scope),
      ["orch", "target"],
      "scope is the machine identity and must survive the empty path",
    );
    assert.deepEqual(
      res._body.projects.map((p: any) => p.name),
      ["hydra", "hydra-betting"],
    );
    assert.equal(typeof res._body.generatedAt, "string");
  });

  test("a tagless read spawns once for orch and three for the target", async () => {
    const git = scriptedGit({ "/fake/orch": {}, "/fake/target": {} });
    await callRoute({ gitExec: git.impl });
    // orch: for-each-ref. target: for-each-ref (tags), log -1 (identity),
    // status --porcelain (dirty). No tags means no windows to diff anywhere.
    assert.equal(git.calls.length, 4);
    const targetCalls = git.calls.filter((argv) => argv[1] === "/fake/target");
    assert.equal(targetCalls.length, 3);
    assert.ok(
      targetCalls.some((argv) => argv.includes("--porcelain")),
      "the dirty check must read `git status --porcelain` — untracked files only appear there",
    );
  });
});

// ===========================================================================
// 2. `git describe` is disqualified (trap 1)
// ===========================================================================

describe("versions read — never uses git describe (#3680)", () => {
  beforeEach(() => resetVersionsCache());

  test("no git invocation uses the `describe` subcommand", async () => {
    // `git describe --tags --abbrev=0` exits 128 ("fatal: No names found") on a
    // tagless repo, so a describe-based read would fail every request today.
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    await callRoute({ gitExec: git.impl });

    for (const argv of git.calls) {
      assert.ok(
        !argv.includes("describe"),
        `git describe is disqualified for this read; saw: git ${argv.join(" ")}`,
      );
    }
  });

  test("`current` is read from the first for-each-ref row", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    const enumeration = git.calls.find((argv) => argv.includes("for-each-ref"));
    assert.ok(enumeration, "the read must enumerate tags via for-each-ref");
    assert.ok(
      enumeration!.includes("refs/tags/v*"),
      "enumeration must be glob-filtered to semver-shaped tags",
    );
    assert.equal(res._body.projects[0].current.version, "v1.10.0");
  });
});

// ===========================================================================
// 3. The annotated-tag sha trap and the version-sort trap (traps 2 + 3)
// ===========================================================================

describe("versions read — tag enumeration format and ordering (#3680)", () => {
  beforeEach(() => resetVersionsCache());

  test("the format dereferences to the COMMIT sha, not the tag-object sha", async () => {
    // On an annotated tag (what scripts/deploy.sh stamps) %(objectname) is the
    // TAG OBJECT sha — a sha that appears in no git log. Emitting it would be a
    // silent wrong-sha bug no fixture-free test would catch.
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    await callRoute({ gitExec: git.impl });

    const enumeration = git.calls.find((argv) => argv.includes("for-each-ref"))!;
    const format = enumeration.find((a) => a.startsWith("--format="))!;
    assert.ok(format, "for-each-ref must pass an explicit --format");
    assert.ok(
      format.includes("%(*objectname)"),
      "the sha must come from the DEREFERENCED %(*objectname), not %(objectname)",
    );
    assert.ok(
      format.includes("%(else)%(objectname)"),
      "a lightweight tag (empty %(*objectname)) needs the %(objectname) fallback",
    );
    assert.ok(
      format.includes("%(creatordate:iso-strict)"),
      "the release date is the TAG date, not the commit date",
    );
  });

  test("the sort is -v:refname, so v1.10.0 outranks v1.9.0", async () => {
    // Lexical --sort=-refname puts v1.9.0 ABOVE v1.10.0 ('0' > '.'), and the
    // Target's v0.1.0 baseline reaches that rollover within ten releases.
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    const enumeration = git.calls.find((argv) => argv.includes("for-each-ref"))!;
    assert.ok(
      enumeration.includes("--sort=-v:refname"),
      "version-aware sort is mandatory",
    );
    assert.ok(
      !enumeration.includes("--sort=-refname"),
      "lexical sort mis-orders the 9 -> 10 rollover",
    );
    assert.deepEqual(
      res._body.projects[0].history.map((h: any) => h.version),
      ["v1.10.0", "v1.9.0", "v1.0.0"],
    );
  });

  test("current carries {version,date,sha} and NO notes (history[0] owns them)", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    const orch = res._body.projects[0];
    assert.deepEqual(orch.current, {
      version: "v1.10.0",
      date: "2026-07-25T17:38:52-07:00",
      sha: "aaaa111commitsha",
    });
    assert.equal(
      "notes" in orch.current,
      false,
      "current must not carry notes — the dashboard would double-render history[0]",
    );
    assert.equal(orch.history[0].version, orch.current.version);
    assert.ok(Array.isArray(orch.history[0].notes));
  });
});

// ===========================================================================
// 4. The fragment fold — README filtering, empty-tree window, tag-time reads
// ===========================================================================

describe("versions read — changelog fragment fold (#3680)", () => {
  beforeEach(() => resetVersionsCache());

  test("README.md is filtered out of the tag window (trap 4)", async () => {
    // `-- .changelog/` returns README.md alongside real fragments; the app must
    // drop it or the convention doc renders as a release note.
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    const middle = res._body.projects[0].history[1];
    assert.equal(middle.version, "v1.9.0");
    assert.equal(middle.notes.length, 1, "only the real fragment folds in");
    assert.equal(middle.notes[0].description, "tidy the thing");

    for (const argv of git.calls) {
      assert.ok(
        !argv.some((a) => a.includes("README.md")),
        "the convention doc must never be read as a fragment",
      );
    }
  });

  test("the oldest tag's window opens at the canonical empty tree", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    const usedEmptyTree = git.calls.some((argv) =>
      argv.includes(`${EMPTY_TREE_SHA}..v1.0.0`),
    );
    assert.ok(usedEmptyTree, "the oldest tag has no predecessor commit");
    assert.deepEqual(
      res._body.projects[0].history[2].notes.map((n: any) => n.description),
      ["first release"],
    );
  });

  test("note content is read AT THE TAG, not from the working tree", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    await callRoute({ gitExec: git.impl });

    const shows = git.calls.filter((argv) => argv[2] === "show");
    assert.ok(shows.length > 0, "fragments must be read through git show");
    for (const argv of shows) {
      assert.match(
        argv[3],
        /^v\d+\.\d+\.\d+:\.changelog\//,
        "each read must be pinned to the release tag",
      );
    }
  });

  test("notes are parsed and ordered by conventional-commit type", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl });

    const newest = res._body.projects[0].history[0];
    // On disk the fix fragment sorts first by filename; the response groups by
    // type, so feat precedes fix.
    assert.deepEqual(newest.notes.map((n: any) => n.type), ["feat", "fix"]);
    assert.deepEqual(newest.notes.map((n: any) => n.issue), [3680, 3677]);
    assert.equal(
      newest.notes[0].description,
      "add the GET /api/versions read surface",
    );
  });

  test("the history bound is honoured", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const res = await callRoute({ gitExec: git.impl, historyLimit: 2 });

    assert.equal(res._body.projects[0].history.length, 2);
    assert.deepEqual(
      res._body.projects[0].history.map((h: any) => h.version),
      ["v1.10.0", "v1.9.0"],
    );
    // The bound trims history, never `current`.
    assert.equal(res._body.projects[0].current.version, "v1.10.0");
  });
});

// ===========================================================================
// 5. Never-throw degradation
// ===========================================================================

describe("versions read — never-throw degradation (#3680)", () => {
  beforeEach(() => resetVersionsCache());

  test("a git failure degrades ONE project and never suppresses its sibling", async () => {
    const git = scriptedGit({
      "/fake/orch": POPULATED_ORCH,
      "/fake/target": { tagsFailCode: "gh-failed" },
    });
    const res = await callRoute({ gitExec: git.impl });

    assert.equal(res._status, 200, "a broken repo must not 500 the whole read");
    const [orch, target] = res._body.projects;
    assert.equal(orch.current.version, "v1.10.0", "the healthy sibling is intact");
    assert.equal(target.current, null);
    assert.deepEqual(target.history, []);
    assert.equal(target.error, "gh-failed", "the failure carries a machine code");
  });

  test("an unreadable fragment omits the note without failing the release", async () => {
    const git = scriptedGit({
      "/fake/orch": {
        tags: "v1.0.0|2026-07-01T09:00:00-07:00|cccc333commitsha",
        diffs: { [`${EMPTY_TREE_SHA}..v1.0.0`]: ".changelog/9-missing.md\n" },
        // No `shows` entry -> the stub returns the failure arm.
      },
      "/fake/target": {},
    });
    const res = await callRoute({ gitExec: git.impl });

    assert.equal(res._status, 200);
    const orch = res._body.projects[0];
    assert.equal(orch.current.version, "v1.0.0");
    assert.equal(orch.history.length, 1);
    assert.deepEqual(orch.history[0].notes, []);
    assert.equal(orch.error, null, "a missing fragment is not a repo-level failure");
  });

  test("a git failure in the Target's identity read degrades that entry only (#4172)", async () => {
    // The issue's degradation contract: a git failure in the Target workspace
    // degrades the TARGET entry to current:null/history:[]/error at HTTP 200
    // and never fails the endpoint or the Orchestrator's entry.
    const git = scriptedGit({
      "/fake/orch": POPULATED_ORCH,
      "/fake/target": { headFailCode: "gh-failed" },
    });
    const res = await callRoute({ gitExec: git.impl });

    assert.equal(res._status, 200, "a broken Target must not 500 the whole read");
    const [orch, target] = res._body.projects;
    assert.equal(orch.current.version, "v1.10.0", "the Orchestrator entry is unaffected");
    assert.equal(target.current, null);
    assert.deepEqual(target.history, []);
    assert.equal(target.error, "gh-failed", "the failure carries a machine code");
  });

  test("a FAILED dirty check degrades the Target rather than asserting clean (#4172)", async () => {
    // `dirty` is the load-bearing field: reporting a sha we could read next to
    // a cleanliness we could NOT verify would be the false-honesty pattern this
    // issue exists to remove. A failed status read must degrade the entry.
    const git = scriptedGit({
      "/fake/orch": {},
      "/fake/target": { statusFailCode: "gh-timeout" },
    });
    const res = await callRoute({ gitExec: git.impl });

    assert.equal(res._status, 200);
    const [orch, target] = res._body.projects;
    assert.equal(orch.error, null);
    assert.equal(target.current, null);
    assert.deepEqual(target.history, []);
    assert.equal(target.error, "gh-timeout");
  });

  test("an unparseable identity row degrades with a versions-* code (#4172)", async () => {
    const git = scriptedGit({ "/fake/orch": {}, "/fake/target": { head: "garbage" } });
    const res = await callRoute({ gitExec: git.impl });

    assert.equal(res._status, 200);
    const target = res._body.projects[1];
    assert.equal(target.current, null);
    assert.equal(target.error, "versions-commit-unparseable");
  });
});

// ===========================================================================
// 6. The per-root cache
// ===========================================================================

describe("versions read — 60s per-root cache (#3680)", () => {
  beforeEach(() => resetVersionsCache());

  test("a second read inside the TTL serves the cache with no git calls", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    let t = NOW_MS;
    const now = () => t;

    await readAllVersions({ gitExec: git.impl, projects: PROJECTS, now });
    const cold = git.calls.length;
    assert.ok(cold > 0);

    t = NOW_MS + VERSIONS_CACHE_TTL_MS - 1;
    const second = await readAllVersions({ gitExec: git.impl, projects: PROJECTS, now });
    assert.equal(git.calls.length, cold, "no git process inside the TTL window");
    // POPULATED_ORCH has tags, so `current` is the VersionRef arm of the union.
    assert.equal(
      (second[0].current as VersionRef).version,
      "v1.10.0",
      "the cached value still serves",
    );
  });

  test("crossing the TTL forces a refetch", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    let t = NOW_MS;
    const now = () => t;

    await readAllVersions({ gitExec: git.impl, projects: PROJECTS, now });
    const cold = git.calls.length;

    t = NOW_MS + VERSIONS_CACHE_TTL_MS;
    await readAllVersions({ gitExec: git.impl, projects: PROJECTS, now });
    assert.ok(git.calls.length > cold, "the TTL boundary must re-read git");
  });

  test("the cache is keyed by repo root, so a shared name does not collide", async () => {
    const git = scriptedGit({
      "/fake/orch": POPULATED_ORCH,
      "/fake/target": { tags: "v0.1.0|2026-07-02T09:00:00-07:00|dddd444commitsha" },
    });
    // Two entries with the SAME display name but different roots.
    const sameName = [
      { name: "dup", scope: "orch" as const, root: "/fake/orch" },
      { name: "dup", scope: "target" as const, root: "/fake/target" },
    ];
    const out = await readAllVersions({
      gitExec: git.impl,
      projects: sameName,
      now: () => NOW_MS,
    });
    assert.equal((out[0].current as VersionRef).version, "v1.10.0");
    assert.equal((out[1].current as VersionRef).version, "v0.1.0", "the root, not the name, is the key");
  });

  test("resetVersionsCache drops the singleton so the next read re-reads git", async () => {
    const git = scriptedGit({ "/fake/orch": POPULATED_ORCH, "/fake/target": {} });
    const now = () => NOW_MS; // same instant — a hit would be served if it survived

    await readAllVersions({ gitExec: git.impl, projects: PROJECTS, now });
    const cold = git.calls.length;
    resetVersionsCache();
    await readAllVersions({ gitExec: git.impl, projects: PROJECTS, now });
    assert.ok(git.calls.length > cold, "expected a fresh read after the reset");
  });
});

// ===========================================================================
// 7. Pure helpers
// ===========================================================================

describe("versions read — pure helpers (#3680)", () => {
  test("parseTagRows keeps semver-shaped rows and drops the rest", () => {
    const rows = parseTagRows(
      [
        "v1.2.3|2026-07-01T00:00:00Z|sha1",
        "", // blank
        "not-a-tag|2026-07-01T00:00:00Z|sha2", // wrong shape
        "v1.2|2026-07-01T00:00:00Z|sha3", // incomplete semver
        "v10.0.1|2026-07-02T00:00:00Z|sha4",
      ].join("\n"),
    );
    assert.deepEqual(rows.map((r) => r.version), ["v1.2.3", "v10.0.1"]);
    assert.equal(rows[0].sha, "sha1");
  });

  test("parseCommitRow accepts a %H|%cI line and rejects the rest (#4172)", () => {
    assert.deepEqual(parseCommitRow(`${TARGET_HEAD_SHA}|${TARGET_HEAD_DATE}\n`), {
      sha: TARGET_HEAD_SHA,
      date: TARGET_HEAD_DATE,
    });
    // A short (but hex) sha is as valid as a full one — shape, not length.
    assert.deepEqual(parseCommitRow("abc1234|2026-08-19T14:03:00-07:00"), {
      sha: "abc1234",
      date: "2026-08-19T14:03:00-07:00",
    });
    assert.equal(parseCommitRow(""), null, "an empty repo read has no identity");
    assert.equal(parseCommitRow("\n"), null);
    assert.equal(parseCommitRow("no-separator"), null);
    assert.equal(parseCommitRow("not-hex|2026-08-19T14:03:00-07:00"), null);
    assert.equal(parseCommitRow("abc1234|"), null, "a sha with no date is not an identity");
  });

  test("isFragmentPath accepts fragments and rejects README plus nested paths", () => {
    assert.equal(isFragmentPath(".changelog/3680-versions-api.md"), true);
    assert.equal(isFragmentPath(".changelog/1-genesis.md"), true);
    assert.equal(
      isFragmentPath(".changelog/README.md"),
      false,
      "the convention doc is not a release note",
    );
    assert.equal(isFragmentPath(".changelog/nested/3680-x.md"), false);
    assert.equal(isFragmentPath("src/versions/read-versions.ts"), false);
  });

  test("parseNoteLine parses the documented form and degrades unknown lines", () => {
    assert.deepEqual(parseNoteLine("- feat: add a thing (#3680)"), {
      type: "feat",
      description: "add a thing",
      issue: 3680,
      raw: "- feat: add a thing (#3680)",
    });
    // No issue reference is still a valid note.
    const noIssue = parseNoteLine("- fix: repair a thing");
    assert.equal(noIssue!.type, "fix");
    assert.equal(noIssue!.issue, null);
    // A malformed line surfaces rather than vanishing.
    const other = parseNoteLine("just some prose");
    assert.equal(other!.type, "other");
    assert.equal(other!.description, "just some prose");
    assert.equal(parseNoteLine("   "), null);
  });

  test("parseFragment reads every note line in a file", () => {
    const notes = parseFragment("- feat: one (#1)\n\n- fix: two (#2)\n");
    assert.deepEqual(notes.map((n) => n.type), ["feat", "fix"]);
  });

  test("sortNotesByType groups by canonical type order, unknown types last", () => {
    const notes = [
      { type: "chore", description: "c", issue: null, raw: "" },
      { type: "zzz", description: "z", issue: null, raw: "" },
      { type: "feat", description: "f", issue: null, raw: "" },
      { type: "fix", description: "x", issue: null, raw: "" },
    ];
    assert.deepEqual(
      sortNotesByType(notes).map((n) => n.type),
      ["feat", "fix", "chore", "zzz"],
    );
  });

  test("resolveHistoryLimit falls back to the default on junk", () => {
    assert.equal(resolveHistoryLimit("5"), 5);
    assert.equal(resolveHistoryLimit(undefined), DEFAULT_HISTORY_LIMIT);
    assert.equal(resolveHistoryLimit(""), DEFAULT_HISTORY_LIMIT);
    assert.equal(resolveHistoryLimit("nope"), DEFAULT_HISTORY_LIMIT);
    assert.equal(resolveHistoryLimit("0"), DEFAULT_HISTORY_LIMIT);
    assert.equal(resolveHistoryLimit("-3"), DEFAULT_HISTORY_LIMIT);
  });
});

// ===========================================================================
// 8. Roster + module boundary
// ===========================================================================

describe("versions — project roster and module boundary (#3680)", () => {
  test("listVersionProjects yields one orch entry and one target entry", () => {
    const projects = listVersionProjects();
    assert.equal(projects.length, 2);
    assert.deepEqual(projects.map((p) => p.scope), ["orch", "target"]);
    for (const p of projects) {
      assert.ok(p.root.startsWith("/"), "roots must be absolute paths");
      assert.ok(p.name.length > 0);
    }
  });

  test("src/versions/ never imports from scripts/ or node:child_process", () => {
    // The repo's only established direction is scripts/ -> src/ (12 call sites,
    // zero the other way), and tsconfig includes src/**/*.ts only. Git access
    // must also stay on the gitExec seam rather than spawning directly.
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const rel of [
      "../src/versions/read-versions.ts",
      "../src/versions/project-list.ts",
      "../src/api/versions.ts",
    ]) {
      const source = readFileSync(new URL(rel, import.meta.url), "utf8");
      const importLines = source
        .split("\n")
        .filter((l) => /^\s*import\s/.test(l) || /\bfrom\s+"/.test(l));
      for (const line of importLines) {
        assert.ok(
          !line.includes("scripts/"),
          `src/ must not import from scripts/ (${rel}): ${line.trim()}`,
        );
        assert.ok(
          !line.includes("child_process"),
          `git access must ride the gitExec seam (${rel}): ${line.trim()}`,
        );
      }
    }
    assert.ok(here.length > 0);
  });
});
