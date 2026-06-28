/**
 * Tests for IndexerController — the background indexer lifecycle class
 * extracted from indexer.ts Section 4 (issue #2523).
 *
 * Each test case constructs a fresh IndexerController with injected stubs
 * so there is no shared module-level state to reset between cases.
 * Mirrors the HeartbeatController test approach (heartbeat-controller.test.mts).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  IndexerController,
  type IndexerControllerDeps,
} from "../src/knowledge-base/indexer-lifecycle.ts";
import {
  getCoverageStats,
  resetCoverageStats,
} from "../src/knowledge-base/indexer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op watch stub that silently accepts any path + callback. */
const noopWatch: NonNullable<IndexerControllerDeps["watch"]> = (
  _path,
  _opts,
  _cb
): void => { /* intentional: no-op in tests */ };

/** No-op setInterval that returns a dummy handle and never fires. */
const noopSetInterval: NonNullable<IndexerControllerDeps["setInterval"]> = (
  _cb,
  _ms
) => 0 as unknown as ReturnType<typeof setInterval>;

/** No-op clearInterval (pairs with noopSetInterval). */
const noopClearInterval: NonNullable<IndexerControllerDeps["clearInterval"]> = (
  _id
): void => { /* intentional */ };

/** Build a minimal deps bag that never fires timers or watches. */
function silentDeps(): IndexerControllerDeps {
  return {
    watch: noopWatch,
    setInterval: noopSetInterval,
    clearInterval: noopClearInterval,
    sourcePaths: [], // no source paths — no watch calls
    redisPollMs: 99999,
    configPath: "/nonexistent/config",
    debounceMs: 99999,
    getMemoryPatterns: async () => null,
    indexText: async () => { /* intentional: no-op */ },
    loadPersistedHashes: async () => 0,
    runSourceInitialPass: async () => ({ scanned: 0, indexed: 0, skipped: 0 }),
  };
}

// ---------------------------------------------------------------------------
// Construction and initial state
// ---------------------------------------------------------------------------

describe("IndexerController — construction", () => {
  test("constructs without throwing", () => {
    const ctrl = new IndexerController(silentDeps());
    assert.ok(ctrl instanceof IndexerController);
  });

  test("_getLastRuleCounts starts empty", () => {
    const ctrl = new IndexerController(silentDeps());
    assert.deepEqual(ctrl._getLastRuleCounts(), {});
  });

  test("_getPendingSize starts at 0", () => {
    const ctrl = new IndexerController(silentDeps());
    assert.equal(ctrl._getPendingSize(), 0);
  });
});

// ---------------------------------------------------------------------------
// start() / stop() lifecycle
// ---------------------------------------------------------------------------

describe("IndexerController — start/stop", () => {
  test("start() calls setInterval with the configured poll interval", () => {
    let capturedMs = -1;
    const ctrl = new IndexerController({
      ...silentDeps(),
      redisPollMs: 5000,
      setInterval: (_cb, ms) => {
        capturedMs = ms;
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
    });
    ctrl.start();
    assert.equal(capturedMs, 5000);
  });

  test("stop() calls clearInterval when started", () => {
    let cleared = false;
    const ctrl = new IndexerController({
      ...silentDeps(),
      setInterval: (_cb, _ms) => 42 as unknown as ReturnType<typeof setInterval>,
      clearInterval: (_id) => { cleared = true; },
    });
    ctrl.start();
    ctrl.stop();
    assert.ok(cleared, "clearInterval must be called on stop()");
  });

  test("stop() is idempotent — double-call does not throw", () => {
    let clearCount = 0;
    const ctrl = new IndexerController({
      ...silentDeps(),
      setInterval: (_cb, _ms) => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: (_id) => { clearCount++; },
    });
    ctrl.start();
    ctrl.stop();
    ctrl.stop(); // second call must not throw
    // clearInterval should only be called once (the second stop is a null-guard no-op)
    assert.equal(clearCount, 1);
  });

  test("start() invokes watch for the config path", () => {
    const watchedPaths: string[] = [];
    const ctrl = new IndexerController({
      ...silentDeps(),
      configPath: "/test/config",
      watch: (path, _opts, _cb) => { watchedPaths.push(path); },
    });
    ctrl.start();
    assert.ok(
      watchedPaths.includes("/test/config"),
      `expected /test/config in watchedPaths but got: ${JSON.stringify(watchedPaths)}`
    );
  });

  test("start() invokes watch for each source path", () => {
    const watchedPaths: string[] = [];
    const ctrl = new IndexerController({
      ...silentDeps(),
      sourcePaths: [
        { root: "/repo/src", ext: ".ts" },
        { root: "/repo/docs", ext: ".md" },
      ],
      watch: (path, _opts, _cb) => { watchedPaths.push(path); },
    });
    ctrl.start();
    assert.ok(watchedPaths.includes("/repo/src"), "src should be watched");
    assert.ok(watchedPaths.includes("/repo/docs"), "docs should be watched");
  });

  // Issue #2523 (INV-5): start() must publish the live watch set via
  // setWatchedPaths so /api/learning/coverage (getCoverageStats) reports it.
  // A prior QA pass FAILed the extraction because start() dropped this call,
  // leaving coverageStats.watchedPaths empty. This is the regression guard.
  test("start() records the watch set in coverage stats (INV-5)", () => {
    resetCoverageStats();
    const ctrl = new IndexerController({
      ...silentDeps(),
      configPath: "/test/config",
      sourcePaths: [
        { root: "/repo/src", ext: ".ts" },
        { root: "/repo/docs", ext: ".md" },
      ],
    });
    ctrl.start();
    const { watchedPaths } = getCoverageStats();
    assert.deepEqual(
      watchedPaths,
      ["/test/config", "/repo/src(.ts)", "/repo/docs(.md)"],
      `watchedPaths should list the config dir + each source root tagged ` +
        `with its extension, got: ${JSON.stringify(watchedPaths)}`
    );
    resetCoverageStats();
  });
});

// ---------------------------------------------------------------------------
// pollRedisContent — unit drive without the setInterval
// ---------------------------------------------------------------------------

describe("IndexerController — pollRedisContent", () => {
  test("indexes new patterns above the previous count", async () => {
    const indexed: { title: string; content: string }[] = [];
    const ctrl = new IndexerController({
      ...silentDeps(),
      getMemoryPatterns: async (agent) => {
        if (agent === "planner") {
          return JSON.stringify([
            { severity: "high", category: "test-cat", hitCount: 3, action: "retry", lastCycleId: "c1" },
          ]);
        }
        return null;
      },
      indexText: async (title, content) => {
        indexed.push({ title, content });
      },
    });

    await ctrl.pollRedisContent();

    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].title, "memory:planner:test-cat");
    assert.ok(
      indexed[0].content.includes("test-cat"),
      "content should mention the category"
    );
  });

  test("does not re-index patterns already counted", async () => {
    const indexed: string[] = [];
    const ctrl = new IndexerController({
      ...silentDeps(),
      getMemoryPatterns: async (agent) => {
        if (agent === "executor") {
          return JSON.stringify([
            { severity: "low", category: "cat-a", hitCount: 1, action: "note", lastCycleId: "c1" },
          ]);
        }
        return null;
      },
      indexText: async (title) => { indexed.push(title); },
    });

    // First poll: 1 pattern, prev=0 → indexes it
    await ctrl.pollRedisContent();
    assert.equal(indexed.length, 1);

    // Second poll: still 1 pattern, prev=1 → no new indexing
    await ctrl.pollRedisContent();
    assert.equal(indexed.length, 1, "no new indexing on second poll with same pattern count");
  });

  test("indexes new patterns added between polls", async () => {
    const indexed: string[] = [];
    let patternCount = 1;
    const ctrl = new IndexerController({
      ...silentDeps(),
      getMemoryPatterns: async (agent) => {
        if (agent === "skeptic") {
          const patterns = Array.from({ length: patternCount }, (_, i) => ({
            severity: "medium",
            category: `cat-${i}`,
            hitCount: i + 1,
            action: "warn",
            lastCycleId: `c${i}`,
          }));
          return JSON.stringify(patterns);
        }
        return null;
      },
      indexText: async (title) => { indexed.push(title); },
    });

    // First poll: 1 pattern
    await ctrl.pollRedisContent();
    assert.equal(indexed.length, 1);

    // Add 2 more patterns between polls
    patternCount = 3;

    // Second poll: 3 patterns, prev=1 → indexes 2 new ones
    await ctrl.pollRedisContent();
    assert.equal(indexed.length, 3, "should index the 2 new patterns");
  });

  test("skips unparseable pattern JSON without throwing", async () => {
    const ctrl = new IndexerController({
      ...silentDeps(),
      getMemoryPatterns: async (agent) => {
        if (agent === "planner") return "not-valid-json";
        return null;
      },
      indexText: async () => { throw new Error("should not be called"); },
    });

    // Must not throw
    await ctrl.pollRedisContent();
  });

  test("handles getMemoryPatterns failure without throwing", async () => {
    const ctrl = new IndexerController({
      ...silentDeps(),
      getMemoryPatterns: async () => {
        throw new Error("Redis down");
      },
    });

    // Must not throw — errors are logged, not re-thrown
    await ctrl.pollRedisContent();
  });

  test("tracks lastRuleCounts per agent independently", async () => {
    const indexed: string[] = [];
    const ctrl = new IndexerController({
      ...silentDeps(),
      getMemoryPatterns: async (agent) => {
        if (agent === "planner") {
          return JSON.stringify([
            { severity: "high", category: "planner-cat", hitCount: 2, action: "a", lastCycleId: "c1" },
          ]);
        }
        if (agent === "executor") {
          return JSON.stringify([
            { severity: "low", category: "exec-cat", hitCount: 1, action: "b", lastCycleId: "c2" },
          ]);
        }
        return null;
      },
      indexText: async (title) => { indexed.push(title); },
    });

    await ctrl.pollRedisContent();
    // Both planner-cat and exec-cat should be indexed
    assert.ok(indexed.some(t => t.includes("planner")), "planner pattern indexed");
    assert.ok(indexed.some(t => t.includes("executor")), "executor pattern indexed");

    // Second poll: counts stay at 1 each — no new indexing
    const countBefore = indexed.length;
    await ctrl.pollRedisContent();
    assert.equal(indexed.length, countBefore, "no re-indexing on stable patterns");
  });
});

// ---------------------------------------------------------------------------
// Module-level delegators (zero-diff import path contract)
// ---------------------------------------------------------------------------

describe("module-level delegators", () => {
  test("startKnowledgeIndexer and stopKnowledgeIndexer are re-exported from indexer.ts", async () => {
    // This import must succeed with zero change to the import path
    const mod = await import("../src/knowledge-base/indexer.ts");
    assert.equal(typeof mod.startKnowledgeIndexer, "function");
    assert.equal(typeof mod.stopKnowledgeIndexer, "function");
  });

  test("IndexerController is exported from indexer.ts", async () => {
    const mod = await import("../src/knowledge-base/indexer.ts");
    assert.equal(typeof mod.IndexerController, "function");
    // Should be constructable with the same deps type
    const inst = new mod.IndexerController(silentDeps());
    assert.ok(inst instanceof IndexerController);
  });
});
