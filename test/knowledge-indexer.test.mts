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
  loadPersistedHashes,
  _setHashPersistence,
} from "../src/knowledge-base/source-indexer.ts";

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
// fake — no live Redis — and simulate a restart by clearing the in-memory cache
// (resetCoverageStats) while keeping the persisted store, exactly the cold-cache /
// warm-Redis condition every orchestrator bounce hits.
describe("source-index persistence across restarts (issue #1123)", () => {
  let tempRoot: string;
  let src: string;
  let originalFetch: typeof fetch;
  // The in-memory stand-in for the durable Redis hash.
  let fakeStore: Map<string, string>;
  let persistCalls: { path: string; hash: string }[];

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
    _setHashPersistence(); // restore real Redis-backed accessors
    await rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    fakeStore = new Map<string, string>();
    persistCalls = [];
    resetCoverageStats(); // clears the in-memory cache
    _setHashPersistence({
      load: async () => new Map(fakeStore),
      persist: async (path: string, hash: string) => {
        fakeStore.set(path, hash);
        persistCalls.push({ path, hash });
      },
    });
  });

  test("first pass persists each indexed file's hash to the durable store", async () => {
    const result = await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    // makeTempProject creates control-loop.ts + nested/thing.ts under src.
    assert.equal(result.indexed, 2);
    assert.equal(fakeStore.size, 2, "both indexed files should be persisted");
    assert.equal(persistCalls.length, 2);
  });

  test("a file unchanged since its last persisted hash is skipped with a fresh in-memory cache", async () => {
    // Pass 1: index + persist.
    await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(fakeStore.size, 2);

    // Simulate a process restart: the in-memory cache is gone, but the durable
    // store survives. resetCoverageStats() drops the in-memory hashes; the
    // fakeStore (Redis stand-in) is untouched.
    resetCoverageStats();

    // Hydrate from the durable store — the startup hook does this before the pass.
    const loaded = await loadPersistedHashes();
    assert.equal(loaded, 2, "hydrated both hashes from the durable store");

    // Pass 2 (post-restart): no file changed → zero re-uploads, all skipped.
    const persistCallsBefore = persistCalls.length;
    const result = await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(result.indexed, 0, "unchanged files must NOT be re-embedded after restart");
    assert.equal(result.skipped, 2, "both files skipped via the rehydrated dedup map");
    assert.equal(
      persistCalls.length,
      persistCallsBefore,
      "skipped files trigger no new persist writes",
    );
  });

  test("a changed file is re-indexed and re-persisted after a restart", async () => {
    await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });

    // Restart: drop in-memory cache, keep durable store.
    resetCoverageStats();
    await loadPersistedHashes();

    // Mutate one file so its content hash changes.
    await writeFile(join(src, "control-loop.ts"), "export const scheduler = 12345;\n");
    const now = new Date();
    await utimes(join(src, "control-loop.ts"), now, now);

    const result = await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(result.indexed, 1, "only the changed file is re-embedded");
    assert.equal(result.skipped, 1, "the unchanged file is still skipped");
    // The durable store now reflects the new hash for the changed file.
    const newHash = fakeStore.get(join(src, "control-loop.ts"));
    assert.ok(newHash, "changed file's new hash persisted");
  });

  test("loadPersistedHashes does not clobber a hotter in-memory entry", async () => {
    // Index once this lifetime (writes both in-memory + durable).
    await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    const liveHash = fakeStore.get(join(src, "control-loop.ts"));

    // Simulate the durable store holding a STALE hash for the same path (e.g. a
    // racing writer). loadPersistedHashes must not overwrite the live cache.
    fakeStore.set(join(src, "control-loop.ts"), "stale-hash-deadbeef");
    await loadPersistedHashes();

    // Re-run: the live (correct) hash still matches on disk → skipped, NOT
    // re-indexed off the stale durable value.
    const result = await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }] });
    assert.equal(result.indexed, 0, "live in-memory hash wins over stale durable hash");
    assert.ok(liveHash, "sanity: a live hash existed");
  });
});

// Issue #2335: the startup source-index pass paces its embed-triggering uploads
// so it does not burst OV's Ollama embedding backend and starve the load-gated
// /api/v1/skills handler (#1831). The pace delay is inserted only AFTER a file
// that actually uploaded (a skip costs no embed → never paced) and defaults to 0
// (no behaviour change unless INDEXER_EMBED_PACE_MS is set / paceMs is passed).
describe("runSourceInitialPass embed pacing (issue #2335)", () => {
  let tempRoot: string;
  let src: string;
  let originalFetch: typeof fetch;

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
    resetCoverageStats(); // fresh dedup cache so both files upload again
  });

  test("paceMs:0 inserts no delay (default behaviour preserved)", async () => {
    const start = Date.now();
    const result = await runSourceInitialPass({
      paths: [{ root: src, ext: ".ts" }],
      paceMs: 0,
    });
    const elapsed = Date.now() - start;
    // makeTempProject creates control-loop.ts + nested/thing.ts under src.
    assert.equal(result.indexed, 2, "both files index with no pacing");
    assert.ok(elapsed < 200, `paceMs:0 should not stall (took ${elapsed}ms)`);
  });

  test("a positive paceMs delays AFTER each uploaded file", async () => {
    const PACE = 60;
    const start = Date.now();
    const result = await runSourceInitialPass({
      paths: [{ root: src, ext: ".ts" }],
      paceMs: PACE,
    });
    const elapsed = Date.now() - start;
    // 2 uploads → 2 pace delays (one after each upload). Lower-bound the total
    // wall time at a single pace to keep the assertion robust against fast CI
    // while still proving the delay is applied to an upload.
    assert.equal(result.indexed, 2, "both files index");
    assert.ok(
      elapsed >= PACE,
      `expected at least one ${PACE}ms pace delay, took ${elapsed}ms`,
    );
  });

  test("skips are not paced — a fully-deduped pass returns promptly", async () => {
    // Pass 1: index both files (warms the in-memory dedup cache).
    await runSourceInitialPass({ paths: [{ root: src, ext: ".ts" }], paceMs: 0 });
    // Pass 2: nothing changed → both files are skipped. Even a large paceMs must
    // NOT stall, because a skip triggers no embed and so is never paced.
    const start = Date.now();
    const result = await runSourceInitialPass({
      paths: [{ root: src, ext: ".ts" }],
      paceMs: 10_000,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.indexed, 0, "no new uploads on the deduped pass");
    assert.equal(result.skipped, 2, "both files skipped");
    assert.ok(elapsed < 1000, `skips must not be paced (took ${elapsed}ms)`);
  });
});
