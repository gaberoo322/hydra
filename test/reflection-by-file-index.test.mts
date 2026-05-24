/**
 * Regression tests for issue #326 — reflection injection at 0%.
 *
 * Problem: reflections were keyed only by the verbatim `anchor.reference`
 * string, but 103/127 stored reflection keys were unique within the first 40
 * chars. Across 20 production cycles, zero reflections matched.
 *
 * Fix: add a by-file secondary index (`hydra:reflections:by-file:<path>` ->
 * Set of anchor keys). On retrieval the planner-context loader now fans out
 * to every file the new anchor touches and pulls reflections recorded by any
 * past anchor that touched the same file.
 *
 * Tests cover:
 *   - file extraction from anchor reference strings
 *   - by-file index writes on `recordAnchorReflection`
 *   - cross-anchor retrieval through the by-file path
 *   - opportunistic backfill on legacy-key hit
 *   - bucketing of `reflectionMatchSource` for metrics
 *
 * Requires Redis on localhost:6379 (DB 1, like the sibling reflection tests).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

let reflections: any;
let learning: any;
let cb: any;
let metrics: any;
let redis: any;
let redisAvailable = false;

async function cleanReflectionKeys() {
  const keys = await redis.keys("hydra:reflections:*");
  if (keys.length > 0) await redis.del(...keys);
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

describe("issue #326: reflection by-file index", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch {
        console.error("Redis unavailable at localhost:6379/1, skipping by-file reflection tests");
        return;
      }
      reflections = await import("../src/reflections/reflections.ts");
      learning = await import("../src/learning.ts");
      cb = await import("../src/context-builder.ts");
      metrics = await import("../src/metrics/trend.ts");
    }
    if (!redisAvailable) return;
    await cleanReflectionKeys();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanReflectionKeys();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  // ---------- pure helpers --------------------------------------------------

  test("extractFilesFromAnchor pulls path-shaped tokens from the reference", () => {
    const anchorRef = "Fix deep-review finding in web/src/lib/calibration/sync-forecast-outcomes.ts: `deriveSport`";
    const files = reflections.extractFilesFromAnchor(anchorRef);
    assert.ok(files.includes("web/src/lib/calibration/sync-forecast-outcomes.ts"));
  });

  test("extractFilesFromAnchor prefers explicit scope files", () => {
    const files = reflections.extractFilesFromAnchor(
      "vague anchor with no paths",
      ["src/foo.ts", "src/bar.ts"],
    );
    assert.deepEqual(files.sort(), ["src/bar.ts", "src/foo.ts"]);
  });

  test("extractFilesFromAnchor strips ./ prefix and wrapping backticks", () => {
    const files = reflections.extractFilesFromAnchor("Touched `./src/redis/reflections.ts` and bar.json");
    assert.ok(files.includes("src/redis/reflections.ts"));
  });

  test("extractFilesFromAnchor returns [] when no path-shaped tokens", () => {
    const files = reflections.extractFilesFromAnchor("Refactor authentication flow", null);
    assert.deepEqual(files, []);
  });

  test("reflectionMatchSource buckets the source list correctly", () => {
    assert.equal(cb.reflectionMatchSource([]), "none");
    assert.equal(cb.reflectionMatchSource(["per-anchor"]), "by-anchor");
    assert.equal(cb.reflectionMatchSource(["by-file"]), "by-file");
    assert.equal(cb.reflectionMatchSource(["per-anchor", "by-file"]), "both");
    assert.equal(cb.reflectionMatchSource(["global"]), "global");
    assert.equal(cb.reflectionMatchSource(["per-anchor", "global"]), "mixed");
  });

  test("deriveReflectionMatchSource buckets the raw comma-separated string", () => {
    assert.equal(metrics.deriveReflectionMatchSource(""), "none");
    assert.equal(metrics.deriveReflectionMatchSource("per-anchor"), "by-anchor");
    assert.equal(metrics.deriveReflectionMatchSource("by-file"), "by-file");
    assert.equal(metrics.deriveReflectionMatchSource("per-anchor,by-file"), "both");
    assert.equal(metrics.deriveReflectionMatchSource("per-anchor,global"), "mixed");
    assert.equal(metrics.deriveReflectionMatchSource(undefined), "none");
  });

  test("inspectReflections detects the new by-file section", async () => {
    const formatted = [
      "## RELATED FILES — Prior Failures (2 matched by file)",
      "",
      "### cycle-1 (file: src/foo.ts)",
      "- **Anchor**: anchor 1",
      "",
      "### cycle-2 (file: src/foo.ts)",
      "- **Anchor**: anchor 2",
    ].join("\n");
    const result = cb.inspectReflections(formatted);
    assert.equal(result.count, 2);
    assert.deepEqual(result.sources, ["by-file"]);
  });

  // ---------- Redis-backed behaviour ---------------------------------------

  test("recordAnchorReflection writes to the by-file index when scopeFiles given", async (t) => {
    requireRedis(t);
    await reflections.recordAnchorReflection({
      cycleId: "cycle-A",
      anchorRef: "Fix bug in calibration/sync-forecast-outcomes.ts deriveSport",
      taskTitle: "Fix deriveSport mapping",
      outcome: "verification-failed",
      reason: "test failure",
      scopeFiles: ["src/calibration/sync-forecast-outcomes.ts"],
    });

    const members = await redis.smembers("hydra:reflections:by-file:src/calibration/sync-forecast-outcomes.ts");
    assert.equal(members.length, 1);
    assert.ok(members[0].startsWith("hydra:reflections:"));
  });

  test("recordAnchorReflection auto-derives files from anchor.reference when scopeFiles missing", async (t) => {
    requireRedis(t);
    await reflections.recordAnchorReflection({
      cycleId: "cycle-B",
      anchorRef: "Fix issue in web/src/lib/foo.ts: helper",
      taskTitle: "Fix helper",
      outcome: "no-diff",
      reason: "executor produced no changes",
    });

    const members = await redis.smembers("hydra:reflections:by-file:web/src/lib/foo.ts");
    assert.equal(members.length, 1);
  });

  test("loadAnchorReflectionsByFile retrieves reflections across different anchor strings", async (t) => {
    requireRedis(t);
    // First anchor records a failure on foo.ts.
    await reflections.recordAnchorReflection({
      cycleId: "cycle-original",
      anchorRef: "Fix deep-review finding in src/foo.ts: deriveSport mismatch",
      taskTitle: "Fix deriveSport",
      outcome: "verification-failed",
      reason: "tests broke",
      scopeFiles: ["src/foo.ts"],
    });

    // Second anchor — completely different reference string — touches the same file.
    const newAnchorRef = "Codebase health: split src/foo.ts module into helpers";
    const formatted = await reflections.loadAnchorReflectionsByFile(
      ["src/foo.ts"],
      newAnchorRef,
    );

    assert.ok(formatted.length > 0, "should retrieve at least one reflection by file");
    assert.ok(formatted.includes("RELATED FILES"), "should use the by-file header");
    assert.ok(formatted.includes("cycle-original"), "should include original cycleId");
    assert.ok(formatted.includes("deriveSport"), "should include reflection content");
  });

  test("loadAnchorReflectionsByFile excludes the current anchor's own key", async (t) => {
    requireRedis(t);
    const anchorRef = "Refactor src/foo.ts helpers";
    await reflections.recordAnchorReflection({
      cycleId: "cycle-1",
      anchorRef,
      taskTitle: "Refactor",
      outcome: "no-diff",
      reason: "no changes",
      scopeFiles: ["src/foo.ts"],
    });

    const formatted = await reflections.loadAnchorReflectionsByFile(["src/foo.ts"], anchorRef);
    // The exact-same anchor would already be loaded via the legacy key, so we
    // skip it here to avoid duplicate injection.
    assert.equal(formatted, "");
  });

  test("loadAnchorReflectionsByFile dedupes the same reflection seen via multiple files", async (t) => {
    requireRedis(t);
    await reflections.recordAnchorReflection({
      cycleId: "cycle-multi",
      anchorRef: "Cross-file fix touching foo.ts and bar.ts",
      taskTitle: "Cross-file",
      outcome: "verification-failed",
      reason: "tests broke",
      scopeFiles: ["src/foo.ts", "src/bar.ts"],
    });

    const formatted = await reflections.loadAnchorReflectionsByFile(
      ["src/foo.ts", "src/bar.ts"],
      "unrelated-anchor",
    );
    // Should appear exactly once even though indexed under both files.
    const occurrences = formatted.match(/cycle-multi/g);
    assert.equal(occurrences?.length, 1);
  });

  test("backfillByFileIndex idempotently indexes a legacy reflection by its files", async (t) => {
    requireRedis(t);
    // Simulate a pre-#326 reflection: written directly without by-file fan-out
    // (we use the same write path but ignore the resulting index, then check
    // backfill rewrites it correctly even after SREM).
    const anchorRef = "Fix something in src/legacy/thing.ts: someSymbol";
    await reflections.recordAnchorReflection({
      cycleId: "cycle-legacy",
      anchorRef,
      taskTitle: "Legacy task",
      outcome: "verification-failed",
      reason: "tests broke",
    });
    // Wipe the by-file index to simulate the pre-fix state.
    await redis.del("hydra:reflections:by-file:src/legacy/thing.ts");

    const indexed = await reflections.backfillByFileIndex(anchorRef);
    assert.equal(indexed, 1);

    const members = await redis.smembers("hydra:reflections:by-file:src/legacy/thing.ts");
    assert.equal(members.length, 1);

    // Idempotent: a second call should not duplicate.
    const indexedAgain = await reflections.backfillByFileIndex(anchorRef);
    assert.equal(indexedAgain, 1);
    const membersAgain = await redis.smembers("hydra:reflections:by-file:src/legacy/thing.ts");
    assert.equal(membersAgain.length, 1);
  });

  test("getContext('planner', anchor) surfaces a by-file reflection from a different anchor", async (t) => {
    requireRedis(t);
    // Record reflection under a verbose, one-off anchor reference (the actual
    // production failure mode that motivated this issue).
    await reflections.recordAnchorReflection({
      cycleId: "cycle-prev",
      anchorRef: "Fix deep-review finding in src/reflections/reflections.ts: extractFilesFromAnchor edge case",
      taskTitle: "Fix extractFilesFromAnchor edge case",
      outcome: "verification-failed",
      reason: "regression in adjacent helper",
      scopeFiles: ["src/reflections/reflections.ts"],
    });

    // Now a different planner pass picks up a completely different anchor that
    // touches the same file.
    const ctx = await learning.getContext("planner", {
      type: "codebase-health",
      reference: "Codebase health: consolidate small helpers in src/reflections/reflections.ts",
    });

    assert.ok(ctx.includes("RELATED FILES"), "context should include by-file section");
    assert.ok(ctx.includes("cycle-prev"), "should surface the prior reflection across anchors");
  });

});
