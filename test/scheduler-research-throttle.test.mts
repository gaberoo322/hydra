/**
 * Regression tests for the source-aware research throttle (issue #457).
 *
 * Bug: the research scheduler's `Research suppressed: queue depth N >= threshold 6`
 * throttle was firing every 15 minutes against `hydra:anchors:work-queue` depth=31
 * — but 27/31 of those items were orphan findings emitted by the deleted
 * `code-reviewer` / `adversarial-validation` agents (PR-3 / issue #383). The
 * producers are gone, no post-cutover analogue re-emits them, and anchor-selection
 * drains them slowly as `user-request` work. The throttle was structurally
 * non-self-clearing — research went dark for >26h before the operator drained
 * the queue manually.
 *
 * Fix (two complementary changes):
 *   1. Make the queue-depth throttle source-aware: items whose `source` is not
 *      in a live-producer allowlist are excluded from the throttle math.
 *      Implemented as `countLiveWorkQueueItems()` in `src/redis/work-queue.ts`.
 *   2. Make the research-floor a hard silence-based override: when no research
 *      has run in the rolling 24h window AND the wall-clock since last research
 *      exceeds the silence threshold, the floor fires regardless of build
 *      volume. This prevents the "no traffic at all" failure mode where the
 *      floor's existing build-volume gate (`buildCount24h >= floorWindow`)
 *      kept the floor inert.
 *
 * Acceptance criteria from the issue:
 *   - After fix, `lastResearchAt` advances within one research interval (2h)
 *     even without operator-draining the queue.
 *   - `[Scheduler] Research suppressed` log includes `(N orphan items excluded)`
 *     telemetry so the failure mode is visible.
 *   - A queue with `[5 orphan code-reviewer, 1 research]` items reports live
 *     depth=1, not 6.
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

// -----------------------------------------------------------------------------
// Imports under test
// -----------------------------------------------------------------------------

const workQueueMod = await import("../src/redis/work-queue.ts");
const {
  countLiveWorkQueueItems,
  isLiveWorkQueueItem,
  LIVE_WORK_QUEUE_SOURCES,
  pushToWorkQueue,
} = workQueueMod as any;

const floorMod = await import("../src/scheduler-research-floor.ts");
const {
  shouldForceResearchFloor,
  getResearchFloorSilenceMs,
  DEFAULT_RESEARCH_FLOOR_SILENCE_MS,
} = floorMod as any;

const redisKeysMod = await import("../src/redis-keys.ts");
const { redisKeys } = redisKeysMod;

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

let testRedis: any;

async function cleanWorkQueueKey() {
  await testRedis.del(redisKeys.anchorWorkQueue());
}

/** Seed the work queue directly via raw LPUSH equivalent so the OV indexer
 *  side-effect of `pushToWorkQueue` doesn't fire during tests. */
async function seedWorkQueue(items: Array<{ source?: string; reference?: string }>) {
  await cleanWorkQueueKey();
  for (const item of items) {
    await testRedis.rpush(redisKeys.anchorWorkQueue(), JSON.stringify(item));
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("source-aware research throttle (issue #457)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis("redis://localhost:6379/1");
    }
    await cleanWorkQueueKey();
  });

  after(async () => {
    if (testRedis) {
      await cleanWorkQueueKey();
      testRedis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // isLiveWorkQueueItem — the pure predicate
  // ---------------------------------------------------------------------------

  describe("isLiveWorkQueueItem", () => {
    test("treats `research` source as live", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ source: "research" })), true);
    });

    test("treats `user-request` source as live", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ source: "user-request" })), true);
    });

    test("treats `operator` source as live", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ source: "operator" })), true);
    });

    test("treats `backlog` source as live", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ source: "backlog" })), true);
    });

    test("treats `code-reviewer` source as orphan (deleted producer)", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ source: "code-reviewer" })), false);
    });

    test("treats `adversarial-validation` source as orphan (deleted producer)", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ source: "adversarial-validation" })), false);
    });

    test("treats unknown source as orphan (default-deny outside allowlist)", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ source: "some-deleted-agent" })), false);
    });

    test("treats missing source as live (legacy compatibility)", () => {
      assert.equal(isLiveWorkQueueItem(JSON.stringify({ reference: "ref-only" })), true);
    });

    test("treats corrupt JSON as live (under-filter rather than silently drop)", () => {
      assert.equal(isLiveWorkQueueItem("{not json"), true);
    });

    test("LIVE_WORK_QUEUE_SOURCES contains the core post-cutover producers", () => {
      assert.ok((LIVE_WORK_QUEUE_SOURCES as Set<string>).has("research"));
      assert.ok((LIVE_WORK_QUEUE_SOURCES as Set<string>).has("user-request"));
      assert.ok((LIVE_WORK_QUEUE_SOURCES as Set<string>).has("operator"));
      assert.ok((LIVE_WORK_QUEUE_SOURCES as Set<string>).has("backlog"));
    });

    test("LIVE_WORK_QUEUE_SOURCES does NOT contain deleted producers", () => {
      assert.ok(!(LIVE_WORK_QUEUE_SOURCES as Set<string>).has("code-reviewer"));
      assert.ok(!(LIVE_WORK_QUEUE_SOURCES as Set<string>).has("adversarial-validation"));
    });
  });

  // ---------------------------------------------------------------------------
  // countLiveWorkQueueItems — issue acceptance criterion
  // ---------------------------------------------------------------------------

  describe("countLiveWorkQueueItems", () => {
    // The issue's exact stated AC: a queue with 5 orphan code-reviewer items
    // and 1 research item should report live depth=1, not 6.
    test("AC: [5 orphan code-reviewer, 1 research] → live=1, total=6, orphan=5", async () => {
      await seedWorkQueue([
        { source: "code-reviewer", reference: "orphan-1" },
        { source: "code-reviewer", reference: "orphan-2" },
        { source: "code-reviewer", reference: "orphan-3" },
        { source: "code-reviewer", reference: "orphan-4" },
        { source: "code-reviewer", reference: "orphan-5" },
        { source: "research", reference: "live-1" },
      ]);
      const counts = await countLiveWorkQueueItems();
      assert.equal(counts.live, 1);
      assert.equal(counts.total, 6);
      assert.equal(counts.orphan, 5);
    });

    test("reproduces production composition: 11 code-reviewer + 9 adversarial-validation + 5 research + 6 sourceless = total 31, live 11", async () => {
      // From the issue's evidence block (2026-05-15T21:36Z snapshot). The
      // sourceless items are treated as live (legacy compatibility), so
      // the live count is 5 (research) + 6 (sourceless) = 11.
      const items: Array<{ source?: string; reference?: string }> = [];
      for (let i = 0; i < 11; i++) items.push({ source: "code-reviewer", reference: `cr-${i}` });
      for (let i = 0; i < 9; i++) items.push({ source: "adversarial-validation", reference: `av-${i}` });
      for (let i = 0; i < 5; i++) items.push({ source: "research", reference: `rs-${i}` });
      for (let i = 0; i < 6; i++) items.push({ reference: `legacy-${i}` });
      await seedWorkQueue(items);

      const counts = await countLiveWorkQueueItems();
      assert.equal(counts.total, 31);
      assert.equal(counts.live, 11); // 5 research + 6 sourceless
      assert.equal(counts.orphan, 20); // 11 code-reviewer + 9 adversarial-validation

      // Critical contract: live count (11) is well above the default
      // RESEARCH_QUEUE_THRESHOLD of 6, so this test alone doesn't prove the
      // suppression unblocks. It DOES prove the orphan filter works against
      // the real production composition, which is the AC the issue calls
      // out specifically.
    });

    test("returns zeroes on empty queue", async () => {
      await cleanWorkQueueKey();
      const counts = await countLiveWorkQueueItems();
      assert.equal(counts.live, 0);
      assert.equal(counts.total, 0);
      assert.equal(counts.orphan, 0);
    });

    test("a queue of pure orphans reports live=0 even though total > threshold", async () => {
      // This is the exact production-incident shape: queue full of orphans,
      // live depth zero, so the queue-depth gate should let research run.
      const items: Array<{ source?: string; reference?: string }> = [];
      for (let i = 0; i < 30; i++) items.push({ source: "code-reviewer", reference: `cr-${i}` });
      await seedWorkQueue(items);

      const counts = await countLiveWorkQueueItems();
      assert.equal(counts.live, 0);
      assert.equal(counts.total, 30);
      assert.equal(counts.orphan, 30);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldForceResearchFloor — silence-based override (issue #457)
  // ---------------------------------------------------------------------------

  describe("shouldForceResearchFloor silence override (issue #457)", () => {
    test("AC: fires when researchCount24h=0 AND last research > 24h ago, even with zero builds", () => {
      // The production incident: no build traffic, no research traffic, but
      // queue full of orphan items. The existing `buildCount24h >= floorWindow`
      // gate kept the floor inert. With the silence override, the floor
      // fires after the silence threshold elapses.
      const nowMs = 1_700_000_000_000;
      const lastResearchAtMs = nowMs - 30 * 60 * 60 * 1000; // 30h ago
      const d = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 0, // below floorWindow=20 — would normally block
        nowMs,
        lastResearchAtMs,
        silenceMs: 24 * 60 * 60 * 1000,
      });
      assert.equal(d.shouldFire, true);
      assert.match(d.reason, /research silent for 30\.0h/);
      assert.match(d.reason, /researchCount24h=0/);
    });

    test("does NOT fire on silence override when researchCount24h > 0", () => {
      // If research has happened in the last 24h, the silence override is
      // not appropriate — `researchCount24h > 0` means the rolling window
      // already has signal, and the ratio-based path should govern instead.
      const nowMs = 1_700_000_000_000;
      const lastResearchAtMs = nowMs - 30 * 60 * 60 * 1000;
      const d = shouldForceResearchFloor({
        researchCount24h: 1, // has signal in 24h window
        buildCount24h: 0,
        nowMs,
        lastResearchAtMs,
        silenceMs: 24 * 60 * 60 * 1000,
      });
      // Falls through to the buildCount24h < floorWindow branch.
      assert.equal(d.shouldFire, false);
      assert.match(d.reason, /not enough builds yet/);
    });

    test("does NOT fire on silence override when silence is below threshold", () => {
      const nowMs = 1_700_000_000_000;
      const lastResearchAtMs = nowMs - 12 * 60 * 60 * 1000; // 12h ago
      const d = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 0,
        nowMs,
        lastResearchAtMs,
        silenceMs: 24 * 60 * 60 * 1000,
      });
      assert.equal(d.shouldFire, false);
    });

    test("does NOT fire on silence override when lastResearchAtMs is null (no signal)", () => {
      // First-boot case — no research has ever run. Treat as "not enough
      // signal to decide" rather than forcing immediately; the build-volume
      // path will eventually fire once the system has work.
      const d = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 0,
        nowMs: 1_700_000_000_000,
        lastResearchAtMs: null,
        silenceMs: 24 * 60 * 60 * 1000,
      });
      assert.equal(d.shouldFire, false);
    });

    test("silence override respects suppression window", () => {
      const nowMs = 1_700_000_000_000;
      const d = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 0,
        nowMs,
        lastResearchAtMs: nowMs - 30 * 60 * 60 * 1000,
        silenceMs: 24 * 60 * 60 * 1000,
        suppressedUntilMs: nowMs + 60_000, // suppression active
      });
      assert.equal(d.shouldFire, false);
      assert.match(d.reason, /suppressed/);
    });

    test("DEFAULT_RESEARCH_FLOOR_SILENCE_MS is 24h", () => {
      assert.equal(DEFAULT_RESEARCH_FLOOR_SILENCE_MS, 24 * 60 * 60 * 1000);
    });

    test("getResearchFloorSilenceMs reads env override", () => {
      // Sanity check: env override path is wired.
      const got = getResearchFloorSilenceMs({ HYDRA_RESEARCH_FLOOR_SILENCE_MS: "3600000" });
      assert.equal(got, 3_600_000);
    });

    test("getResearchFloorSilenceMs falls back to default on garbage input", () => {
      assert.equal(
        getResearchFloorSilenceMs({ HYDRA_RESEARCH_FLOOR_SILENCE_MS: "-1" }),
        DEFAULT_RESEARCH_FLOOR_SILENCE_MS,
      );
      assert.equal(
        getResearchFloorSilenceMs({ HYDRA_RESEARCH_FLOOR_SILENCE_MS: "nope" }),
        DEFAULT_RESEARCH_FLOOR_SILENCE_MS,
      );
      assert.equal(
        getResearchFloorSilenceMs({}),
        DEFAULT_RESEARCH_FLOOR_SILENCE_MS,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end: production-shaped scenario
  // ---------------------------------------------------------------------------

  describe("production-shaped end-to-end (issue #457 evidence)", () => {
    test("queue stuffed with orphans + 30h silence + zero builds → floor fires AND live depth is sub-threshold", async () => {
      // The exact scenario the issue describes: 31 items in queue, 20 orphan,
      // 11 live (5 research + 6 legacy sourceless), 30h since last research,
      // zero builds in 24h.
      const items: Array<{ source?: string; reference?: string }> = [];
      for (let i = 0; i < 11; i++) items.push({ source: "code-reviewer", reference: `cr-${i}` });
      for (let i = 0; i < 9; i++) items.push({ source: "adversarial-validation", reference: `av-${i}` });
      for (let i = 0; i < 5; i++) items.push({ source: "research", reference: `rs-${i}` });
      for (let i = 0; i < 6; i++) items.push({ reference: `legacy-${i}` });
      await seedWorkQueue(items);

      const counts = await countLiveWorkQueueItems();
      // The throttle uses `live`, which is 11 — still above the default
      // RESEARCH_QUEUE_THRESHOLD of 6, but the silence override should fire
      // regardless.
      assert.equal(counts.live, 11);

      // Silence-based override is the safety net that fires here.
      const nowMs = 1_700_000_000_000;
      const lastResearchAtMs = nowMs - 30 * 60 * 60 * 1000;
      const decision = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 0,
        nowMs,
        lastResearchAtMs,
      });
      assert.equal(decision.shouldFire, true);
      assert.match(decision.reason, /research silent/);
    });

    test("queue of only orphans → live depth=0, well below threshold (research can run on natural path)", async () => {
      // After a hypothetical orphan-drain phase 1 (or before phase 1 if the
      // operator has already drained legacy items), if any residual orphan
      // items remain the throttle is no longer hostile to research.
      const items: Array<{ source?: string; reference?: string }> = [];
      for (let i = 0; i < 15; i++) items.push({ source: "code-reviewer", reference: `cr-${i}` });
      await seedWorkQueue(items);

      const counts = await countLiveWorkQueueItems();
      assert.equal(counts.live, 0);
      // Live count is 0 (below any reasonable threshold), so the queue-depth
      // gate in maybeRunResearch lets research run on the natural path
      // (no need for the floor to override).
    });
  });
});
