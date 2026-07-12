/**
 * learning-lifecycle.test.mts — orchestration-wrapper coverage for
 * src/learning-lifecycle.ts (issue #3238).
 *
 * The module's staleness detector `detectAndClearStaleSourceIndex` is ALREADY
 * fully covered (all four branches) by test/source-index-staleness.test.mts.
 * Per the design-concept invariant for #3238, this file MUST NOT re-test it —
 * it targets ONLY the two genuinely-untested lifecycle wrappers:
 *
 *   - consolidate()  — the daily maintenance pass. Its contract is best-effort:
 *     it prunes agent patterns then sweeps promoted-rule effectiveness inside a
 *     try/catch, so a failure in the second step never propagates. We drive it
 *     against the Redis test-DB (it operates on pattern-memory keys and is
 *     idempotent on empty/seeded state) and assert it resolves without throwing.
 *   - initLearning() — the boot wrapper. It fires registerSkills() fire-and-
 *     forget, awaits the (already-covered) staleness detector, and starts the
 *     background knowledge indexer. Its observable contract is: resolves without
 *     throwing, and leaves the indexer in a stoppable state. We invoke it once
 *     and immediately stopKnowledgeIndexer() to tear down the fs watchers /
 *     poll interval it starts, so it leaks no handle into sibling suites.
 *
 * Redis-touching suites are authored as NEW top-level describe blocks with their
 * own before/after lifecycle (CLAUDE.md authoring rule); per-case reset lives in
 * beforeEach. The indexer-lifecycle suite drives its OWN IndexerController
 * instances (never the default singleton), so stopping the default singleton
 * here does not collide with it.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

// Pattern-memory Redis keys consolidate() reads/writes (the "memory" namespace:
// hydra:memory:{agent}:patterns — src/redis/keys.ts memoryPatterns). Prefix-
// scoped cleanup so we never disturb unrelated keys in the shared test DB.
const AGENT_PATTERN_KEY = (agent: string) => `hydra:memory:${agent}:patterns`;
const AGENTS = ["planner", "executor", "skeptic"];

let redis: any;
let consolidate: () => Promise<void>;
let initLearning: () => Promise<void>;
let stopKnowledgeIndexer: () => void;

describe("learning-lifecycle.consolidate (#3238)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ consolidate } = await import("../src/learning-lifecycle.ts"));
  });

  after(async () => {
    for (const a of AGENTS) await redis.del(AGENT_PATTERN_KEY(a));
    redis.disconnect();
  });

  beforeEach(async () => {
    for (const a of AGENTS) await redis.del(AGENT_PATTERN_KEY(a));
  });

  test("resolves without throwing on an empty pattern store (no patterns to prune)", async () => {
    await assert.doesNotReject(() => consolidate());
  });

  test("prunes a stale, unpromoted, low-hit pattern from an agent's store", async () => {
    // A pattern that is old (lastSeen well before the 14-day cutoff), has
    // hitCount < 2, and is not promoted → it must be pruned by
    // consolidateAgentPatterns (the first step of consolidate()).
    const stalePattern = {
      category: "stale-cat-3238",
      hitCount: 1,
      lastSeen: "2000-01-01",
      promoted: false,
    };
    await redis.set(AGENT_PATTERN_KEY("planner"), JSON.stringify([stalePattern]));

    await consolidate();

    const raw = await redis.get(AGENT_PATTERN_KEY("planner"));
    const kept = raw ? JSON.parse(raw) : [];
    assert.equal(kept.length, 0, "a stale low-hit unpromoted pattern must be pruned");
  });

  test("keeps a fresh or promoted pattern (retention predicate holds)", async () => {
    // hitCount >= 2 → retained regardless of age; and a promoted pattern is
    // retained even when stale. Both survive consolidate().
    const patterns = [
      { category: "hot-cat-3238", hitCount: 5, lastSeen: "2000-01-01", promoted: false },
      { category: "promoted-cat-3238", hitCount: 1, lastSeen: "2000-01-01", promoted: true },
    ];
    await redis.set(AGENT_PATTERN_KEY("executor"), JSON.stringify(patterns));

    await consolidate();

    const raw = await redis.get(AGENT_PATTERN_KEY("executor"));
    const kept = raw ? JSON.parse(raw) : [];
    assert.equal(kept.length, 2, "a high-hit pattern and a promoted pattern must both survive");
    const cats = kept.map((p: any) => p.category).sort();
    assert.deepEqual(cats, ["hot-cat-3238", "promoted-cat-3238"]);
  });

  test("is idempotent — a second run over already-consolidated state is a no-op", async () => {
    const patterns = [
      { category: "keep-3238", hitCount: 9, lastSeen: "2000-01-01", promoted: false },
    ];
    await redis.set(AGENT_PATTERN_KEY("skeptic"), JSON.stringify(patterns));

    await consolidate();
    const afterFirst = await redis.get(AGENT_PATTERN_KEY("skeptic"));
    await consolidate();
    const afterSecond = await redis.get(AGENT_PATTERN_KEY("skeptic"));

    assert.deepEqual(
      JSON.parse(afterSecond),
      JSON.parse(afterFirst),
      "a second consolidate over stable state must not mutate the store",
    );
  });
});

describe("learning-lifecycle.initLearning (#3238)", () => {
  before(async () => {
    ({ initLearning } = await import("../src/learning-lifecycle.ts"));
    ({ stopKnowledgeIndexer } = await import("../src/knowledge-base/indexer.ts"));
  });

  after(() => {
    // Tear down the fs watchers + poll interval the boot wrapper starts, so no
    // handle leaks into a sibling suite. Idempotent (issue #866).
    stopKnowledgeIndexer();
  });

  test("resolves without throwing and leaves the indexer in a stoppable state", async () => {
    // initLearning() fires registerSkills() fire-and-forget (best-effort,
    // .catch'd), awaits the staleness detector (best-effort), and starts the
    // background indexer. All three legs degrade gracefully when OpenViking is
    // unreachable, so the wrapper must resolve without throwing.
    await assert.doesNotReject(() => initLearning());
    // Stopping the indexer it started must not throw (idempotent teardown).
    assert.doesNotThrow(() => stopKnowledgeIndexer());
  });
});
