/**
 * Source pins for the Today page's polling consolidation (issue #5093,
 * design-concept issue-5093 INV-8).
 *
 * The stuck panel (`/today/stuck`) and the attention feed (`/attention/feed`)
 * both resolve to the server's single-flight `readWaitingIssues`. They only
 * coalesce into one `gh` fetch per label when their polls overlap, so both
 * must poll at ONE cadence. The dashboard ships no JSX runner, so — like
 * test/dashboard-ticking-clock.test.mts — this reads the sources and asserts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const TODAY_DIR = new URL("../dashboard/src/components/pages/today/", import.meta.url);

function read(rel: string): Promise<string> {
  return readFile(new URL(rel, TODAY_DIR), "utf8");
}

describe("Today page polling (#5093)", () => {
  test("StuckItems reads /today/stuck at poll 30_000 and is its only read", async () => {
    const src = await read("StuckItems.jsx");
    assert.match(src, /useApi\("\/today\/stuck", \{ poll: 30_000 \}\)/);
    assert.equal((src.match(/useApi\(/g) ?? []).length, 1);
  });

  test("AttentionFeed reads /attention/feed at poll 30_000", async () => {
    const src = await read("AttentionFeed.jsx");
    assert.match(src, /usePageItems\("\/attention\/feed", \{\s*poll: 30_000,/);
  });

  test("no other today/*.jsx component reads /today/stuck or /attention/feed", async () => {
    const files = (await readdir(TODAY_DIR)).filter(
      (f) => f.endsWith(".jsx") && f !== "StuckItems.jsx" && f !== "AttentionFeed.jsx",
    );
    assert.ok(files.length > 0);
    for (const f of files) {
      const src = await read(f);
      assert.ok(!src.includes("/today/stuck"), `${f} reads /today/stuck`);
      assert.ok(!src.includes("/attention/feed"), `${f} reads /attention/feed`);
    }
  });

  test("Today.jsx no longer names the decision queue as a live section", async () => {
    const src = await readFile(new URL("../dashboard/src/pages/Today.jsx", import.meta.url), "utf8");
    assert.ok(!/overnight banner, decision queue/.test(src));
  });
});
