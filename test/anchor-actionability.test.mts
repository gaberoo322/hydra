/**
 * Regression tests for issue #270 — pre-planner actionability gate.
 *
 * Bug: noWork outcomes from the planner cost $5–$11 each in frontier-tier
 * inference. The planner was being asked to plan against anchors that had
 * already been addressed by completed priorities or recently merged cycles,
 * burning context just to decide "no work to do".
 *
 * Fix: `isAnchorActionable()` runs BEFORE the planner. For research,
 * user-request, and doc anchors it normalises the anchor reference (reusing
 * `plan-cache.normalizeReference`) and checks against:
 *   1. The "What's been completed" section of priorities.md
 *   2. The titles of the last 50 merged cycles (Redis metrics).
 *
 * On match, returns `{ actionable: false }` and the caller short-circuits
 * with a `__noWork` sentinel — the cycle still records an abandonment so
 * the circuit breaker counts it, but no frontier call is made.
 *
 * Tests cover:
 *   - Completed-priorities match (filesystem)
 *   - Recent-merged-title match (Redis)
 *   - Novel anchor passes through
 *   - Normalisation (parentheticals, word order, stopwords)
 *   - Recovery anchor types (failing-test, prior-failure, reframe,
 *     codebase-health) bypass the gate
 *
 * Uses Redis DB 1 and a temp config directory to avoid touching real state.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let redis: any;
let tempConfigRoot: string;
let originalConfigPath: string | undefined;
let actionability: typeof import("../src/anchor-actionability.ts");

async function cleanRedisKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

async function writePriorities(completedLines: string[]) {
  const direction = join(tempConfigRoot, "direction");
  await mkdir(direction, { recursive: true });
  const body = [
    "# Operator priorities",
    "",
    "- one thing to do",
    "",
    "# What's been completed",
    "",
    ...completedLines.map((l) => `- ${l}`),
    "",
    "# What NOT to work on",
    "",
    "- some excluded thing",
    "",
  ].join("\n");
  await writeFile(join(direction, "priorities.md"), body, "utf-8");
}

async function recordMergedCycle(cycleId: string, taskTitle: string) {
  // Mirror what `recordCycleMetrics` writes: a hash + an entry in the sorted
  // index. We only need the fields the actionability gate reads.
  await redis.hset(`hydra:metrics:${cycleId}`, {
    cycleId,
    taskTitle,
    tasksMerged: "1",
    tasksAttempted: "1",
  });
  await redis.zadd("hydra:metrics:index", Date.now(), cycleId);
}

describe("anchor actionability gate (issue #270)", () => {
  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
    }
    tempConfigRoot = await mkdtemp(join(tmpdir(), "hydra-actionability-"));
    originalConfigPath = process.env.HYDRA_CONFIG_PATH;
    process.env.HYDRA_CONFIG_PATH = tempConfigRoot;
    await cleanRedisKeys();
    // Re-import each run so the module picks up the env change deterministically.
    actionability = await import(`../src/anchor-actionability.ts?ts=${Date.now()}`);
  });

  after(async () => {
    if (redis) {
      await cleanRedisKeys();
      redis.disconnect();
    }
    if (tempConfigRoot) {
      await rm(tempConfigRoot, { recursive: true, force: true });
    }
    if (originalConfigPath === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = originalConfigPath;
  });

  // -------------------------------------------------------------------------
  // Recovery anchor types bypass the gate entirely (no FS / Redis touched).
  // -------------------------------------------------------------------------

  test("failing-test anchors are not gated", async () => {
    const r = await actionability.isAnchorActionable({
      type: "failing-test",
      reference: "test/some-feature.test.mts > should handle X",
    });
    assert.equal(r.actionable, true);
    assert.match(r.reason, /not gated/);
  });

  test("prior-failure anchors are not gated", async () => {
    const r = await actionability.isAnchorActionable({
      type: "prior-failure",
      reference: "Add cost cap to control loop",
    });
    assert.equal(r.actionable, true);
  });

  test("reframe anchors are not gated", async () => {
    const r = await actionability.isAnchorActionable({
      type: "reframe",
      reference: "Refine planner prompt for codebase-health",
    });
    assert.equal(r.actionable, true);
  });

  test("codebase-health anchors are not gated", async () => {
    const r = await actionability.isAnchorActionable({
      type: "codebase-health",
      reference: "codebase-health: large-file in src/control-loop.ts",
    });
    assert.equal(r.actionable, true);
  });

  // -------------------------------------------------------------------------
  // Completed priorities match — primary use case from the issue body.
  // -------------------------------------------------------------------------

  test("matches completed priority — exact phrasing", async () => {
    await writePriorities([
      "Make league-info table reuse the shared DB pool",
      "Add cost attribution route",
    ]);

    const r = await actionability.isAnchorActionable({
      type: "research",
      reference: "Make league-info table reuse the shared DB pool",
    });
    assert.equal(r.actionable, false);
    assert.match(r.reason, /anchor-already-addressed/);
    assert.match(r.reason, /league-info/);
  });

  test("matches completed priority — word order + parentheticals (normalisation)", async () => {
    await writePriorities([
      "Make league-info table reuse the shared DB pool (cuts query count by 40%)",
    ]);

    const r = await actionability.isAnchorActionable({
      type: "research",
      // Same nouns, different surface form, extra metric clause.
      reference: "league-info table shared DB pool reuse (0 tests, regression)",
    });
    assert.equal(r.actionable, false);
    assert.match(r.reason, /anchor-already-addressed/);
  });

  test("matches completed priority for user-request anchors", async () => {
    await writePriorities(["Add a /api/metrics/cost-attribution endpoint"]);

    const r = await actionability.isAnchorActionable({
      type: "user-request",
      reference: "Add /api/metrics/cost-attribution endpoint",
    });
    assert.equal(r.actionable, false);
  });

  test("matches completed priority for doc anchors", async () => {
    await writePriorities(["Refresh priorities document after stale detection"]);

    const r = await actionability.isAnchorActionable({
      type: "doc",
      reference: "Refresh priorities document after stale detection",
    });
    assert.equal(r.actionable, false);
  });

  // -------------------------------------------------------------------------
  // Recent-merge match — the second leg of the gate.
  // -------------------------------------------------------------------------

  test("matches recently merged task title", async () => {
    await writePriorities(["Some unrelated completed item"]);
    await recordMergedCycle("cycle-2026-05-10-1200", "Add /api/metrics/cost-attribution route");

    const r = await actionability.isAnchorActionable({
      type: "research",
      reference: "Add /api/metrics/cost-attribution route",
    });
    assert.equal(r.actionable, false);
    assert.match(r.reason, /recently merged/);
  });

  test("only considers cycles with tasksMerged > 0", async () => {
    await writePriorities(["Some unrelated completed item"]);
    // Record a cycle with the same title but tasksMerged=0 — should NOT block.
    await redis.hset("hydra:metrics:cycle-2026-05-10-1200", {
      cycleId: "cycle-2026-05-10-1200",
      taskTitle: "Add foo bar baz route",
      tasksMerged: "0",
    });
    await redis.zadd("hydra:metrics:index", Date.now(), "cycle-2026-05-10-1200");

    const r = await actionability.isAnchorActionable({
      type: "research",
      reference: "Add foo bar baz route",
    });
    assert.equal(r.actionable, true);
  });

  // -------------------------------------------------------------------------
  // Novel anchor — must pass through (don't starve the planner of new work).
  // -------------------------------------------------------------------------

  test("novel anchor passes through", async () => {
    await writePriorities(["Something completely different that was finished"]);
    await recordMergedCycle("cycle-2026-05-10-1200", "Unrelated previous merge");

    const r = await actionability.isAnchorActionable({
      type: "research",
      reference: "Investigate adversarial validation harness for executor",
    });
    assert.equal(r.actionable, true);
  });

  test("anchor without reference passes through", async () => {
    const r = await actionability.isAnchorActionable({
      type: "research",
      reference: "",
    });
    assert.equal(r.actionable, true);
    assert.match(r.reason, /no reference/);
  });

  test("very short reference is not gated (avoids false positives)", async () => {
    await writePriorities(["The fix landed"]);

    const r = await actionability.isAnchorActionable({
      type: "research",
      // Normalises to a single token — too short to be a meaningful match.
      reference: "Fix",
    });
    assert.equal(r.actionable, true);
    assert.match(r.reason, /too short/);
  });

  // -------------------------------------------------------------------------
  // Resilience — missing priorities.md or Redis problems must not block work.
  // -------------------------------------------------------------------------

  test("missing priorities.md does not block legitimate work", async () => {
    // No writePriorities() call — file does not exist.
    const r = await actionability.isAnchorActionable({
      type: "research",
      reference: "Implement some entirely new feature with several words",
    });
    assert.equal(r.actionable, true);
  });
});
