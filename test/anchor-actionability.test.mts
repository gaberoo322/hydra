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
 * `anchor-selection/normalize-reference.ts`) and checks against:
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

// =============================================================================
// Issue #285 — doc-anchor saturation gate.
//
// In the 2026-05-11 50-cycle window, 9 cycles spent ~$60 each on the same doc
// anchor with abandonReason "Drift: ...". `isDocAnchorSaturated()` short-
// circuits this loop BEFORE the planner runs by counting consecutive recent
// drift-rejected cycles with the same anchor reference.
// =============================================================================

describe("doc-anchor saturation gate (issue #285)", () => {
  // Use a dedicated Redis client so the outer suite's `after` disconnect
  // doesn't close out from under us (test order is not guaranteed).
  let satRedis: any;
  let satTempConfigRoot: string;
  let satOriginalConfigPath: string | undefined;
  let satActionability: typeof import("../src/anchor-actionability.ts");

  async function cleanSatRedisKeys() {
    const keys = await satRedis.keys("hydra:*");
    if (keys.length > 0) await satRedis.del(...keys);
  }

  beforeEach(async () => {
    if (!satRedis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      satRedis = new Redis(redisUrl);
    }
    satTempConfigRoot = await mkdtemp(join(tmpdir(), "hydra-saturation-"));
    satOriginalConfigPath = process.env.HYDRA_CONFIG_PATH;
    process.env.HYDRA_CONFIG_PATH = satTempConfigRoot;
    await cleanSatRedisKeys();
    delete process.env.HYDRA_DOC_SATURATION_THRESHOLD;
    satActionability = await import(`../src/anchor-actionability.ts?ts=${Date.now()}`);
  });

  after(async () => {
    if (satRedis) {
      await cleanSatRedisKeys();
      satRedis.disconnect();
    }
    if (satTempConfigRoot) {
      await rm(satTempConfigRoot, { recursive: true, force: true });
    }
    if (satOriginalConfigPath === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = satOriginalConfigPath;
    delete process.env.HYDRA_DOC_SATURATION_THRESHOLD;
  });

  /**
   * Record a synthetic cycle in the metrics index. Newer ts -> newer cycle.
   * `outcome` is one of:
   *   - "drift"       — drift-rejected via planner (post-spend abandon)
   *   - "drift-pre"   — drift-rejected via the pre-filter (cheap abandon)
   *   - "merge"       — produced a merge
   *   - "other"       — some other failure (no abandonReason)
   */
  async function recordCycle(opts: {
    cycleId: string;
    anchorType: string;
    anchorReference: string;
    outcome: "drift" | "drift-pre" | "merge" | "other";
    ts: number;
  }) {
    const fields: Record<string, string> = {
      cycleId: opts.cycleId,
      anchorType: opts.anchorType,
      anchorReference: opts.anchorReference,
      taskTitle: `synthetic-${opts.cycleId}`,
      tasksAttempted: "1",
      tasksMerged: opts.outcome === "merge" ? "1" : "0",
      tasksAbandoned: opts.outcome === "merge" ? "0" : "1",
    };
    if (opts.outcome === "drift") fields.abandonReason = "Drift: Title 'foo' is 92% similar to 'bar' from cycle-x";
    else if (opts.outcome === "drift-pre") fields.abandonReason = "drift-pre-filter";
    else if (opts.outcome === "other") fields.abandonReason = "Planner produced no task";
    await satRedis.hset(`hydra:metrics:${opts.cycleId}`, fields);
    await satRedis.zadd("hydra:metrics:index", opts.ts, opts.cycleId);
  }

  test("non-doc anchor types are not gated", async () => {
    const r = await satActionability.isDocAnchorSaturated("research", "anything");
    assert.equal(r.saturated, false);
    assert.match(r.reason, /not a doc anchor/);
  });

  test("missing reference returns not-saturated", async () => {
    const r = await satActionability.isDocAnchorSaturated("doc", "");
    assert.equal(r.saturated, false);
    assert.match(r.reason, /no reference/);
  });

  test("no recent cycles returns not-saturated", async () => {
    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, false);
    assert.equal(r.consecutiveDriftCount, 0);
  });

  test("2 consecutive drift-rejected doc cycles → saturated (default threshold N=2)", async () => {
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 2000 });
    await recordCycle({ cycleId: "c2", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, true);
    assert.equal(r.consecutiveDriftCount, 2);
    assert.match(r.reason, /2 consecutive drift-rejected/);
  });

  test("matches AC: 2 prior drift cycles → 3rd doc anchor short-circuits before any planner cost", async () => {
    // Acceptance criterion from issue #285:
    // "2 prior drift-rejected doc cycles → 3rd doc anchor returns
    //  { actionable: false, reason: ... } before any planner cost is incurred."
    const now = Date.now();
    await recordCycle({ cycleId: "doc-cycle-1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 2000 });
    await recordCycle({ cycleId: "doc-cycle-2", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, true, "3rd doc-anchor cycle must be flagged saturated");
    assert.ok(r.consecutiveDriftCount >= 2);
  });

  test("1 drift cycle is below default threshold", async () => {
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, false);
    assert.equal(r.consecutiveDriftCount, 1);
  });

  test("drift-pre-filter abandons also count toward saturation", async () => {
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift-pre", ts: now - 2000 });
    await recordCycle({ cycleId: "c2", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift-pre", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, true);
    assert.equal(r.consecutiveDriftCount, 2);
  });

  test("non-drift abandon breaks the consecutive run", async () => {
    // [drift, other, drift] — the "other" failure breaks the streak.
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 3000 });
    await recordCycle({ cycleId: "c2", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "other", ts: now - 2000 });
    await recordCycle({ cycleId: "c3", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, false);
    // Newest-first scan: c3 is drift → counter=1; c2 is "other" → break.
    assert.equal(r.consecutiveDriftCount, 1);
  });

  test("merged interleaved cycle (for any anchor) resets the streak", async () => {
    // [drift on doc, merge on queue, drift on doc] — the queue merge resets.
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 3000 });
    await recordCycle({ cycleId: "c2", anchorType: "queue", anchorReference: "some other thing", outcome: "merge", ts: now - 2000 });
    await recordCycle({ cycleId: "c3", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, false);
    assert.equal(r.consecutiveDriftCount, 1);
  });

  test("other-anchor cycles without a merge don't reset the streak", async () => {
    // [drift on doc, fail on queue (not merged), drift on doc] — saturated.
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 3000 });
    await recordCycle({ cycleId: "c2", anchorType: "queue", anchorReference: "queue item", outcome: "other", ts: now - 2000 });
    await recordCycle({ cycleId: "c3", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, true);
    assert.equal(r.consecutiveDriftCount, 2);
  });

  test("different doc reference doesn't trigger saturation", async () => {
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/other.md", outcome: "drift", ts: now - 2000 });
    await recordCycle({ cycleId: "c2", anchorType: "doc", anchorReference: "direction/other.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, false);
    assert.equal(r.consecutiveDriftCount, 0);
  });

  test("HYDRA_DOC_SATURATION_THRESHOLD env var tunes threshold", async () => {
    process.env.HYDRA_DOC_SATURATION_THRESHOLD = "3";
    satActionability = await import(`../src/anchor-actionability.ts?ts=${Date.now()}`);

    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 2000 });
    await recordCycle({ cycleId: "c2", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    // 2 cycles, threshold=3 → not saturated yet.
    const r1 = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r1.saturated, false);

    await recordCycle({ cycleId: "c3", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now });

    const r2 = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r2.saturated, true);
    assert.equal(r2.consecutiveDriftCount, 3);
  });

  test("HYDRA_DOC_SATURATION_THRESHOLD=0 disables the gate", async () => {
    process.env.HYDRA_DOC_SATURATION_THRESHOLD = "0";
    satActionability = await import(`../src/anchor-actionability.ts?ts=${Date.now()}`);

    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 2000 });
    await recordCycle({ cycleId: "c2", anchorType: "doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("doc", "direction/priorities.md");
    assert.equal(r.saturated, false);
    assert.match(r.reason, /disabled/);
  });

  test("priorities-doc alias is gated alongside 'doc'", async () => {
    const now = Date.now();
    await recordCycle({ cycleId: "c1", anchorType: "priorities-doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 2000 });
    await recordCycle({ cycleId: "c2", anchorType: "priorities-doc", anchorReference: "direction/priorities.md", outcome: "drift", ts: now - 1000 });

    const r = await satActionability.isDocAnchorSaturated("priorities-doc", "direction/priorities.md");
    assert.equal(r.saturated, true);
  });
});
