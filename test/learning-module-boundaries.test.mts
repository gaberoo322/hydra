/**
 * Regression test for issue #211 — verify the source-indexer + ov-upload
 * extractions stay extracted. learning.ts has historically grown back when
 * pieces were merged in mid-edit. This test asserts:
 *
 *   1. The two extracted modules exist as standalone files.
 *   2. They export the public symbols they own.
 *   3. learning.ts re-exports the source-indexer's public API so existing
 *      callers (api/misc.ts, knowledge-indexer.test.mts, etc.) keep
 *      compiling without changes.
 *
 * If a future edit deletes the modules or removes the re-exports, this
 * test fails fast and tells the next agent to read PR #211's body for
 * the deferred-seam list.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

describe("learning module boundaries (issue #211)", () => {
  test("src/learning/source-indexer.ts exists", () => {
    assert.ok(
      existsSync(resolve(repoRoot, "src/learning/source-indexer.ts")),
      "source-indexer.ts must exist as the extracted module"
    );
  });

  test("src/learning/ov-upload.ts exists", () => {
    assert.ok(
      existsSync(resolve(repoRoot, "src/learning/ov-upload.ts")),
      "ov-upload.ts must exist as the extracted module"
    );
  });

  test("source-indexer exports the public source-indexing API", async () => {
    const mod = await import("../src/learning/source-indexer.ts");
    const expected = [
      "parseSourcePaths",
      "SOURCE_PATHS",
      "SOURCE_INITIAL_WINDOW_MS",
      "shouldIndexSource",
      "enumerateSourceFiles",
      "buildSourceTitle",
      "runSourceInitialPass",
      "makeSourceWatcher",
      "getCoverageStats",
      "resetCoverageStats",
    ];
    for (const name of expected) {
      assert.ok(
        name in mod,
        `source-indexer must export ${name} (regression: do not re-merge into learning.ts)`
      );
    }
  });

  test("ov-upload exports the OV upload helpers", async () => {
    const mod = await import("../src/learning/ov-upload.ts");
    assert.equal(typeof (mod as any).indexFile, "function");
    assert.equal(typeof (mod as any).indexText, "function");
  });

  test("learning.ts re-exports source-indexer public API for backward compat", async () => {
    const learning = await import("../src/learning.ts");
    const expected = [
      "parseSourcePaths",
      "shouldIndexSource",
      "enumerateSourceFiles",
      "buildSourceTitle",
      "runSourceInitialPass",
      "getCoverageStats",
      "resetCoverageStats",
    ];
    for (const name of expected) {
      assert.ok(
        name in learning,
        `learning.ts must re-export ${name} so existing callers keep working`
      );
    }
  });
});
