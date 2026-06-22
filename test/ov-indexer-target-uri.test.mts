/**
 * Regression test for OV indexer target URI (incident 2026-05-10).
 *
 * Bug: indexFile() POSTed to /api/v1/resources without a `to:` field, so OV
 * defaulted the destination to viking://resources/<basename-without-ext>,
 * stripping the parent directory. Re-indexing direction/priorities.md wrote
 * to viking://resources/priorities (top level), which after the first run
 * existed as an orphan and caused every subsequent rename to fail with
 * "file exists" / point-lock errors. The direction docs went un-indexed for
 * ~10 days, leaving agent semantic search stale.
 *
 * Fix: pass an explicit `to: viking://resources/${rel}` so OV writes to the
 * proper nested location and rename targets are stable across re-indexes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexerTargetUri } from "../src/knowledge-base/indexer.ts";

describe("OV indexer target URI", () => {
  test("nested config path becomes nested viking URI", () => {
    assert.equal(
      indexerTargetUri("direction/priorities.md"),
      "viking://resources/direction/priorities.md",
    );
  });

  test("top-level config file maps to top-level resource", () => {
    assert.equal(
      indexerTargetUri("AGENTS.md"),
      "viking://resources/AGENTS.md",
    );
  });

  test("deeply nested path preserves all segments", () => {
    assert.equal(
      indexerTargetUri("agents/research/director.md"),
      "viking://resources/agents/research/director.md",
    );
  });

  test("extension is preserved (not stripped)", () => {
    const uri = indexerTargetUri("direction/roadmap.md");
    assert.ok(uri.endsWith(".md"), `expected .md suffix, got ${uri}`);
  });
});
