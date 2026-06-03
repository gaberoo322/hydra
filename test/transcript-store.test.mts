/**
 * Authoritative test surface for the **Transcript Store** Seam
 * (`src/transcript-store.ts`, issue #951) — the single owner of where Claude
 * Code session transcripts live and how to read them.
 *
 * The Seam exists to kill a real divergence: `usage-tracker.ts` honored
 * `HYDRA_CLAUDE_PROJECTS_ROOT` while `api/dispatches.ts` hard-coded
 * `~/.claude/projects`. The root-resolution tests below pin the env override as
 * the ONE source of truth, so the divergence cannot reappear. The path-traversal
 * confinement guard is tested here once, authoritatively, rather than per-caller.
 */
import { test, describe, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  projectsRoot,
  encodeProjectDir,
  sessionIdFromPath,
  isUuidShaped,
  confineToRoot,
  resolveTranscriptPath,
  listTranscriptFiles,
} from "../src/transcript-store.ts";

const UUID = "38c78e5c-884f-47ae-acb4-5d48286776b3";

// ---------------------------------------------------------------------------
// projectsRoot — the single source of truth for HYDRA_CLAUDE_PROJECTS_ROOT
// ---------------------------------------------------------------------------

describe("projectsRoot", () => {
  const saved = process.env.HYDRA_CLAUDE_PROJECTS_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.HYDRA_CLAUDE_PROJECTS_ROOT;
    else process.env.HYDRA_CLAUDE_PROJECTS_ROOT = saved;
  });

  test("defaults to ~/.claude/projects when the env override is unset", () => {
    delete process.env.HYDRA_CLAUDE_PROJECTS_ROOT;
    assert.equal(projectsRoot(), join(homedir(), ".claude", "projects"));
  });

  test("honors HYDRA_CLAUDE_PROJECTS_ROOT (the relocation seam) — no divergence", () => {
    process.env.HYDRA_CLAUDE_PROJECTS_ROOT = "/some/relocated/root";
    assert.equal(projectsRoot(), "/some/relocated/root");
  });

  test("an empty override falls back to the default (not the empty string)", () => {
    process.env.HYDRA_CLAUDE_PROJECTS_ROOT = "";
    assert.equal(projectsRoot(), join(homedir(), ".claude", "projects"));
  });
});

// ---------------------------------------------------------------------------
// encodeProjectDir — the harness's <projectDir> filename grammar
// ---------------------------------------------------------------------------

describe("encodeProjectDir", () => {
  test("replaces every non-alphanumeric char with '-'", () => {
    assert.equal(encodeProjectDir("/home/gabe/hydra"), "-home-gabe-hydra");
  });

  test("encodes a worktree path with dots and slashes", () => {
    assert.equal(
      encodeProjectDir("/home/gabe/hydra/.claude/worktrees/agent-1"),
      "-home-gabe-hydra--claude-worktrees-agent-1",
    );
  });
});

// ---------------------------------------------------------------------------
// sessionIdFromPath — the <sessionId>.jsonl stem
// ---------------------------------------------------------------------------

describe("sessionIdFromPath", () => {
  test("strips the .jsonl extension and the directory", () => {
    assert.equal(sessionIdFromPath(`/root/proj/${UUID}.jsonl`), UUID);
  });

  test("handles a bare filename", () => {
    assert.equal(sessionIdFromPath("abc.jsonl"), "abc");
  });
});

// ---------------------------------------------------------------------------
// isUuidShaped — the first path-traversal guard
// ---------------------------------------------------------------------------

describe("isUuidShaped", () => {
  test("accepts a UUID-shaped token", () => {
    assert.equal(isUuidShaped(UUID), true);
  });
  test("rejects a traversal payload, junk, and empty", () => {
    assert.equal(isUuidShaped("../../etc/passwd"), false);
    assert.equal(isUuidShaped("not-a-uuid"), false);
    assert.equal(isUuidShaped(""), false);
  });
});

// ---------------------------------------------------------------------------
// confineToRoot — the authoritative defence-in-depth confinement guard
// ---------------------------------------------------------------------------

describe("confineToRoot", () => {
  test("returns the resolved path when the candidate is inside the root", () => {
    const out = confineToRoot(
      "/home/x/.claude/projects",
      "/home/x/.claude/projects/d/f.jsonl",
    );
    assert.equal(out, "/home/x/.claude/projects/d/f.jsonl");
  });

  test("returns null when the candidate escapes the root", () => {
    const out = confineToRoot(
      "/home/x/.claude/projects",
      "/home/x/.claude/projects/../../../etc/passwd",
    );
    assert.equal(out, null);
  });

  test("treats the root itself as confined (not an escape)", () => {
    const out = confineToRoot("/r", "/r");
    assert.equal(out, "/r");
  });
});

// ---------------------------------------------------------------------------
// resolveTranscriptPath — projectDir-direct + scan fallback + confinement
// ---------------------------------------------------------------------------

describe("resolveTranscriptPath", () => {
  test("returns null for a non-UUID sessionId (traversal guard)", async () => {
    const out = await resolveTranscriptPath("../../etc/passwd", undefined, {
      root: "/tmp/root",
      stat: async () => true,
    });
    assert.equal(out, null);
  });

  test("resolves directly from a known projectDir without scanning", async () => {
    const root = "/tmp/root";
    const out = await resolveTranscriptPath(UUID, "/home/gabe/hydra", {
      root,
      stat: async (p) => p.includes("-home-gabe-hydra"),
      listProjectDirs: async () => {
        throw new Error("scan should not run when the direct path hits");
      },
    });
    assert.equal(out, join(root, "-home-gabe-hydra", `${UUID}.jsonl`));
  });

  test("falls back to scanning project dirs when projectDir is unknown", async () => {
    const root = "/tmp/root";
    const out = await resolveTranscriptPath(UUID, undefined, {
      root,
      stat: async (p) => p.includes("dir-b"),
      listProjectDirs: async () => ["dir-a", "dir-b"],
    });
    assert.equal(out, join(root, "dir-b", `${UUID}.jsonl`));
  });

  test("returns null when no dir contains the session file", async () => {
    const out = await resolveTranscriptPath(UUID, undefined, {
      root: "/tmp/root",
      stat: async () => false,
      listProjectDirs: async () => ["dir-a"],
    });
    assert.equal(out, null);
  });
});

// ---------------------------------------------------------------------------
// listTranscriptFiles — the recursive JSONL walk
// ---------------------------------------------------------------------------

describe("listTranscriptFiles", () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("walks arbitrarily deep and returns only .jsonl files", async () => {
    root = await mkdtemp(join(tmpdir(), "transcript-store-"));
    const projA = join(root, "-proj-a");
    const nested = join(root, "-proj-b", UUID, "subagents");
    await mkdir(projA, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(projA, `${UUID}.jsonl`), "{}\n");
    await writeFile(join(projA, "notes.txt"), "ignore me");
    await writeFile(join(nested, "child.jsonl"), "{}\n");

    const files = await listTranscriptFiles(root);
    const rels = files.map((f) => f.slice(root.length + 1)).sort();
    assert.deepEqual(rels, [
      join("-proj-a", `${UUID}.jsonl`),
      join("-proj-b", UUID, "subagents", "child.jsonl"),
    ]);
  });

  test("returns [] for a missing root rather than throwing", async () => {
    const files = await listTranscriptFiles("/does/not/exist/anywhere");
    assert.deepEqual(files, []);
  });
});
