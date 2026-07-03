/**
 * Regression tests for the OpenViking knowledge indexer's source-file
 * pass introduced in issue #210.
 *
 * The indexer historically only watched config/ + polled Redis. Agents
 * therefore had no semantic access to actual source code. These tests
 * exercise the pure helpers (parseSourcePaths, shouldIndexSource,
 * enumerateSourceFiles, buildSourceTitle, runSourceInitialPass) so we can
 * validate behavior without standing up an OV instance.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSourcePaths,
  shouldIndexSource,
  enumerateSourceFiles,
  buildSourceTitle,
  runSourceInitialPass,
  getCoverageStats,
  resetCoverageStats,
  HashDedupAdapter,
} from "../src/knowledge-base/indexer.ts";

// Use a unique temp root for each describe block so we don't collide with
// other tests in the suite.
async function makeTempProject() {
  const root = await mkdtemp(join(tmpdir(), "hydra-indexer-test-"));
  const src = join(root, "src");
  const docs = join(root, "docs");
  const node_modules = join(root, "node_modules");
  await mkdir(src, { recursive: true });
  await mkdir(docs, { recursive: true });
  await mkdir(join(src, "nested"), { recursive: true });
  await mkdir(node_modules, { recursive: true });

  // Source files we expect to be picked up.
  await writeFile(join(src, "control-loop.ts"), "export const scheduler = 1;\n");
  await writeFile(join(src, "nested", "thing.ts"), "export const x = 2;\n");
  // Non-matching extension under src/.
  await writeFile(join(src, "ignored.txt"), "noise");
  // Inside ignored dir — must be skipped.
  await writeFile(join(node_modules, "foo.ts"), "module = 1");
  // Doc file.
  await writeFile(join(docs, "architecture.md"), "# Architecture\n");
  return { root, src, docs };
}

describe("parseSourcePaths", () => {
  test("parses default-style spec with multiple entries", () => {
    const out = parseSourcePaths("/a/src:.ts,/a/docs:.md");
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { root: "/a/src", ext: ".ts" });
    assert.deepEqual(out[1], { root: "/a/docs", ext: ".md" });
  });

  test("ignores empty / malformed entries", () => {
    const out = parseSourcePaths(",,/a/src:.ts,bad,/b:");
    // bad has no colon -> skipped. /b: has empty ext -> skipped.
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { root: "/a/src", ext: ".ts" });
  });

  test("returns empty array for empty input", () => {
    assert.deepEqual(parseSourcePaths(""), []);
  });

  test("supports paths containing colons via lastIndexOf split", () => {
    // Windows-y path with drive letter (we don't run on Windows but the
    // splitter must still produce a sane result).
    const out = parseSourcePaths("C:/repo/src:.ts");
    assert.equal(out.length, 1);
    assert.equal(out[0].ext, ".ts");
    assert.equal(out[0].root, "C:/repo/src");
  });
});

describe("shouldIndexSource", () => {
  test("matches files under root with the configured extension", () => {
    const src = { root: "/proj/src", ext: ".ts" };
    assert.equal(shouldIndexSource("/proj/src/foo.ts", src), true);
    assert.equal(shouldIndexSource("/proj/src/nested/bar.ts", src), true);
  });

  test("rejects files outside the source root", () => {
    const src = { root: "/proj/src", ext: ".ts" };
    assert.equal(shouldIndexSource("/other/foo.ts", src), false);
  });

  test("rejects files with the wrong extension", () => {
    const src = { root: "/proj/src", ext: ".ts" };
    assert.equal(shouldIndexSource("/proj/src/readme.md", src), false);
  });

  test("rejects files inside .git or node_modules", () => {
    const src = { root: "/proj/src", ext: ".ts" };
    assert.equal(shouldIndexSource("/proj/src/.git/HEAD.ts", src), false);
    assert.equal(shouldIndexSource("/proj/src/node_modules/foo.ts", src), false);
  });

  test("rejects build output dirs (dist, build, coverage)", () => {
    const src = { root: "/proj/src", ext: ".ts" };
    assert.equal(shouldIndexSource("/proj/src/dist/out.ts", src), false);
    assert.equal(shouldIndexSource("/proj/src/build/out.ts", src), false);
    assert.equal(shouldIndexSource("/proj/src/coverage/x.ts", src), false);
  });
});

describe("enumerateSourceFiles", () => {
  let tempRoot: string;
  let src: string;
  let docs: string;

  before(async () => {
    const t = await makeTempProject();
    tempRoot = t.root;
    src = t.src;
    docs = t.docs;
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("finds matching .ts files recursively, skipping ignore dirs", async () => {
    const files = await enumerateSourceFiles({ root: src, ext: ".ts" });
    const rels = files.map(f => f.replace(src + "/", "")).sort();
    assert.deepEqual(rels, ["control-loop.ts", "nested/thing.ts"]);
  });

  test("matches docs root with .md extension", async () => {
    const files = await enumerateSourceFiles({ root: docs, ext: ".md" });
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("architecture.md"));
  });

  test("returns empty array for missing directory without throwing", async () => {
    const files = await enumerateSourceFiles({
      root: join(tempRoot, "does-not-exist"),
      ext: ".ts",
    });
    assert.deepEqual(files, []);
  });
});

describe("buildSourceTitle", () => {
  test("encodes path so OV gets a stable, slash-free title", () => {
    const title = buildSourceTitle("/proj/src/nested/thing.ts", { root: "/proj/src", ext: ".ts" });
    assert.equal(title, "hydra-source:src__nested__thing.ts");
  });

  test("does not contain raw path separators", () => {
    const title = buildSourceTitle("/a/b/src/x/y.ts", { root: "/a/b/src", ext: ".ts" });
    assert.ok(!title.includes("/"));
  });
});

describe("runSourceInitialPass", () => {
  let tempRoot: string;
  let src: string;
  let docs: string;
  let originalFetch: typeof fetch;
  const fetchCalls: { url: string; body: any }[] = [];

  before(async () => {
    const t = await makeTempProject();
    tempRoot = t.root;
    src = t.src;
    docs = t.docs;

    // Stub fetch so we don't hit a real OV instance. Returns shapes the
    // indexText helper expects (temp_upload + add).
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: init?.body });
      if (u.endsWith("/api/v1/resources/temp_upload")) {
        return {
          ok: true,
          json: async () => ({ temp_path: "/tmp/fake-temp-path" }),
          text: async () => "",
        } as any;
      }
      // Other resource POSTs (the "add" call after temp_upload).
      return {
        ok: true,
        json: async () => ({}),
        text: async () => "",
      } as any;
    }) as any;

    resetCoverageStats();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("indexes recently-modified source files and updates coverage stats", async () => {
    const result = await runSourceInitialPass({
      paths: [
        { root: src, ext: ".ts" },
        { root: docs, ext: ".md" },
      ],
      windowMs: 7 * 86400_000,
    });
    // 2 .ts files under src + 1 .md under docs = 3 candidates.
    assert.equal(result.scanned, 3);
    assert.equal(result.indexed, 3);
    assert.equal(result.skipped, 0);

    const cov = getCoverageStats();
    assert.equal(cov.sourceFilesIndexed, 3);
    assert.equal(cov.resourceCount, 3);
    assert.ok(cov.lastIndexAt && cov.lastIndexAt.length > 0);
  });

  test("re-running is idempotent: unchanged files are skipped via hash dedup", async () => {
    const before = getCoverageStats().sourceFilesIndexed;
    const result = await runSourceInitialPass({
      paths: [
        { root: src, ext: ".ts" },
        { root: docs, ext: ".md" },
      ],
    });
    assert.equal(result.scanned, 3);
    assert.equal(result.indexed, 0, "expected zero new uploads on second pass");
    assert.equal(result.skipped, 3);
    assert.equal(getCoverageStats().sourceFilesIndexed, before);
  });

  test("modifying a file causes the next pass to re-upload only that file", async () => {
    await writeFile(join(src, "control-loop.ts"), "export const scheduler = 99;\n");
    // Bump mtime forward to ensure the recency window catches it.
    const now = new Date();
    await utimes(join(src, "control-loop.ts"), now, now);
    const result = await runSourceInitialPass({
      paths: [{ root: src, ext: ".ts" }],
    });
    assert.equal(result.indexed, 1);
    assert.equal(result.skipped, 1);
  });

  test("files older than the window are skipped without uploading", async () => {
    // Create a file with an mtime well outside the window.
    const oldFile = join(src, "ancient.ts");
    await writeFile(oldFile, "export const old = true;\n");
    const old = new Date(Date.now() - 30 * 86400_000);
    await utimes(oldFile, old, old);

    const callsBefore = fetchCalls.length;
    const result = await runSourceInitialPass({
      paths: [{ root: src, ext: ".ts" }],
      windowMs: 7 * 86400_000,
      now: Date.now(),
    });
    // ancient.ts should be skipped due to age.
    const ancientUploads = fetchCalls
      .slice(callsBefore)
      .filter(c => c.url.endsWith("/api/v1/resources/temp_upload"))
      .filter(c => String(c.body || "").includes("ancient"));
    assert.equal(ancientUploads.length, 0);
    // Skipped count includes the ancient file plus already-indexed nested/thing.ts.
    assert.ok(result.skipped >= 2);
  });

  test("skips ignored directories during enumeration", async () => {
    // node_modules/foo.ts must never appear in fetch traffic.
    const nodeModuleUploads = fetchCalls.filter(c =>
      String(c.body || "").includes("node_modules")
    );
    assert.equal(nodeModuleUploads.length, 0);
  });
});

// Issue #1123: the dedup hash map is persisted to Redis and reloaded on startup
// so unchanged files are skipped ACROSS process restarts (not just within one
// process lifetime). These tests drive the persistence seam through an in-memory
// fake — no live Redis.
//
// Issue #2603: the persistence seam is now injected through the HashDedupAdapter
// CONSTRUCTOR (the `_setHashPersistence` module-global escape-hatch is deleted).
// A "process restart" is simulated by constructing a FRESH adapter with the SAME
// injected persistence — the fresh adapter has empty in-memory maps while the
// `fakeStore` (durable Redis stand-in) survives, exactly the cold-cache /
// warm-Redis condition every orchestrator bounce hits. No shared module-global
// state to reset — the fresh adapter IS the reset.
describe("source-index persistence across restarts (issue #1123)", () => {
  let tempRoot: string;
  let src: string;
  let originalFetch: typeof fetch;
  // The in-memory stand-in for the durable Redis hash.
  let fakeStore: Map<string, string>;
  let persistCalls: { path: string; hash: string }[];

  /** Build an adapter wired to the (shared) fakeStore-backed persistence. */
  function makeAdapter(): HashDedupAdapter {
    return new HashDedupAdapter({
      load: async () => new Map(fakeStore),
      persist: async (path: string, hash: string) => {
        fakeStore.set(path, hash);
        persistCalls.push({ path, hash });
      },
    });
  }

  before(async () => {
    const t = await makeTempProject();
    tempRoot = t.root;
    src = t.src;

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/v1/resources/temp_upload")) {
        return {
          ok: true,
          json: async () => ({ temp_path: "/tmp/fake-temp-path" }),
          text: async () => "",
        } as any;
      }
      return { ok: true, json: async () => ({}), text: async () => "" } as any;
    }) as any;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh durable store + call log per case — no cross-case dedup leakage.
    fakeStore = new Map<string, string>();
    persistCalls = [];
  });

  test("first pass persists each indexed file's hash to the durable store", async () => {
    const adapter = makeAdapter();
    const result = await adapter.runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    // makeTempProject creates control-loop.ts + nested/thing.ts under src.
    assert.equal(result.indexed, 2);
    assert.equal(fakeStore.size, 2, "both indexed files should be persisted");
    assert.equal(persistCalls.length, 2);
  });

  test("a file unchanged since its last persisted hash is skipped with a fresh in-memory cache", async () => {
    // Pass 1: index + persist through the first adapter.
    const adapter1 = makeAdapter();
    await adapter1.runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(fakeStore.size, 2);

    // Simulate a process restart: a fresh adapter has empty in-memory maps, but
    // the durable store (fakeStore) survives.
    const adapter2 = makeAdapter();

    // Hydrate from the durable store — the startup hook does this before the pass.
    const loaded = await adapter2.loadPersistedHashes();
    assert.equal(loaded, 2, "hydrated both hashes from the durable store");

    // Pass 2 (post-restart): no file changed → zero re-uploads, all skipped.
    const persistCallsBefore = persistCalls.length;
    const result = await adapter2.runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(result.indexed, 0, "unchanged files must NOT be re-embedded after restart");
    assert.equal(result.skipped, 2, "both files skipped via the rehydrated dedup map");
    assert.equal(
      persistCalls.length,
      persistCallsBefore,
      "skipped files trigger no new persist writes",
    );
  });

  test("a changed file is re-indexed and re-persisted after a restart", async () => {
    const adapter1 = makeAdapter();
    await adapter1.runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });

    // Restart: fresh adapter (empty in-memory maps), durable store survives.
    const adapter2 = makeAdapter();
    await adapter2.loadPersistedHashes();

    // Mutate one file so its content hash changes.
    await writeFile(join(src, "control-loop.ts"), "export const scheduler = 12345;\n");
    const now = new Date();
    await utimes(join(src, "control-loop.ts"), now, now);

    const result = await adapter2.runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(result.indexed, 1, "only the changed file is re-embedded");
    assert.equal(result.skipped, 1, "the unchanged file is still skipped");
    // The durable store now reflects the new hash for the changed file.
    const newHash = fakeStore.get(join(src, "control-loop.ts"));
    assert.ok(newHash, "changed file's new hash persisted");
  });

  test("loadPersistedHashes does not clobber a hotter in-memory entry", async () => {
    // Index once this lifetime (writes both in-memory + durable).
    const adapter = makeAdapter();
    await adapter.runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    const liveHash = fakeStore.get(join(src, "control-loop.ts"));

    // Simulate the durable store holding a STALE hash for the same path (e.g. a
    // racing writer). loadPersistedHashes must not overwrite the live cache.
    fakeStore.set(join(src, "control-loop.ts"), "stale-hash-deadbeef");
    await adapter.loadPersistedHashes();

    // Re-run: the live (correct) hash still matches on disk → skipped, NOT
    // re-indexed off the stale durable value.
    const result = await adapter.runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(result.indexed, 0, "live in-memory hash wins over stale durable hash");
    assert.ok(liveHash, "sanity: a live hash existed");
  });
});

// ---------------------------------------------------------------------------
// Issue #2767: the pure enumeration helpers now live in source-enumerator.ts,
// a ZERO-OpenViking module. This suite imports them from the enumerator
// directly (INV-5: testable with a filesystem-only surface, no OV stubs) and
// confirms the extraction preserved behavior 1:1. The re-export from
// indexer.ts (exercised by the suites above) keeps existing callers zero-diff
// (INV-2); this suite proves the new home works and stands alone.
// ---------------------------------------------------------------------------
import {
  parseSourcePaths as enumParseSourcePaths,
  shouldIndexSource as enumShouldIndexSource,
  enumerateSourceFiles as enumEnumerateSourceFiles,
  buildSourceTitle as enumBuildSourceTitle,
  SKIP_DIRS as enumSkipDirs,
} from "../src/knowledge-base/source-enumerator.ts";

describe("source-enumerator.ts — pure helpers, zero-OV (issue #2767)", () => {
  let root: string;
  let src: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "hydra-src-enum-test-"));
    src = join(root, "src");
    await mkdir(join(src, "nested"), { recursive: true });
    await mkdir(join(src, "node_modules"), { recursive: true });
    await writeFile(join(src, "a.ts"), "export const a = 1;");
    await writeFile(join(src, "nested", "b.ts"), "export const b = 2;");
    await writeFile(join(src, "skip.md"), "# not a .ts file");
    await writeFile(join(src, "node_modules", "dep.ts"), "should be skipped");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("parseSourcePaths parses <root>:<ext> pairs and normalises the ext", () => {
    const parsed = enumParseSourcePaths("src:.ts,docs:md");
    assert.deepEqual(parsed, [
      { root: "src", ext: ".ts" },
      { root: "docs", ext: ".md" },
    ]);
  });

  test("shouldIndexSource honours the extension filter and SKIP_DIRS", () => {
    const source = { root: src, ext: ".ts" };
    assert.equal(enumShouldIndexSource(join(src, "a.ts"), source), true);
    assert.equal(enumShouldIndexSource(join(src, "skip.md"), source), false);
    assert.equal(
      enumShouldIndexSource(join(src, "node_modules", "dep.ts"), source),
      false
    );
  });

  test("enumerateSourceFiles recursively finds matching files, skipping ignore dirs", async () => {
    const files = await enumEnumerateSourceFiles({ root: src, ext: ".ts" });
    const rels = files.map((f) => f.slice(src.length + 1)).sort();
    assert.deepEqual(rels, ["a.ts", "nested/b.ts"]);
  });

  test("buildSourceTitle produces the stable hydra-source: slug", () => {
    const title = enumBuildSourceTitle(join(src, "nested", "b.ts"), {
      root: src,
      ext: ".ts",
    });
    assert.equal(title, "hydra-source:src__nested__b.ts");
  });

  test("SKIP_DIRS is the expected ignore set", () => {
    assert.ok(enumSkipDirs.has(".git"));
    assert.ok(enumSkipDirs.has("node_modules"));
  });
});
