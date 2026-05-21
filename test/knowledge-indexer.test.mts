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

import { test, describe, before, after } from "node:test";
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
