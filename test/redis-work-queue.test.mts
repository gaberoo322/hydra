/**
 * Unit tests for the anchor work-queue Redis seam
 * (`src/redis/work-queue.ts`, issue #269) — slice of #2972.
 *
 * Two top-level suites:
 *   1. Pure dedup/marker helpers (`isTerminalMarker`, `normalizeForDedup`,
 *      `isFuzzyDuplicate`) — no Redis, no OV.
 *   2. The Redis-backed list round-trips (`pushToWorkQueue`, `getWorkQueueItems`,
 *      `getWorkQueueLen`, `removeWorkQueueItem`, `cleanWorkQueue`) against the
 *      real `hydra:anchors:work-queue` list key.
 *
 * The OV-coupled dedup readers (`searchOVForDedup`, `findWorkQueueDuplicate`,
 * `indexWorkItem`) are intentionally NOT exercised here — they hit OpenViking
 * over HTTP and belong in an integration test, not this unit slice. Note
 * `pushToWorkQueue` fires a fire-and-forget `indexWorkItem` that catches its
 * own errors when OV is unreachable, so it is safe to call offline.
 *
 * REDIS_URL is set by the test launcher to a per-worktree DB (never DB 0). The
 * queue key is production-shaped (not test-namespaced), so this suite cleans it
 * in its own before/after lifecycle — never a FLUSHDB of the shared test DB.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  isTerminalMarker,
  normalizeForDedup,
  isFuzzyDuplicate,
  pushToWorkQueue,
  getWorkQueueItems,
  getWorkQueueLen,
  removeWorkQueueItem,
  cleanWorkQueue,
} = await import("../src/redis/work-queue.ts");

const WORK_QUEUE_KEY = "hydra:anchors:work-queue";
const item = (reference: string, source = "test") =>
  JSON.stringify({ reference, source });

// ---------------------------------------------------------------------------
// Suite 1 — pure helpers (no Redis)
// ---------------------------------------------------------------------------

describe("redis/work-queue — pure dedup/marker helpers", () => {
  test("isTerminalMarker matches COMPLETED:/CLOSED: case-insensitively", () => {
    assert.equal(isTerminalMarker("COMPLETED: #123"), true);
    assert.equal(isTerminalMarker("closed: fixed it"), true);
    assert.equal(isTerminalMarker("  CLOSED: leading space"), true);
  });

  test("isTerminalMarker rejects actionable work and non-strings", () => {
    assert.equal(isTerminalMarker("Implement the widget"), false);
    assert.equal(isTerminalMarker("completely unrelated"), false);
    assert.equal(isTerminalMarker(42 as unknown as string), false);
    assert.equal(isTerminalMarker(null), false);
  });

  test("normalizeForDedup lowercases, collapses whitespace, trims", () => {
    assert.equal(normalizeForDedup("  Fix   THE  Bug  "), "fix the bug");
  });

  test("isFuzzyDuplicate: exact + substring + non-match + empty", () => {
    assert.equal(isFuzzyDuplicate("Fix the bug", "fix   the   bug"), true);
    assert.equal(isFuzzyDuplicate("fix the bug now", "fix the bug"), true); // substring
    assert.equal(isFuzzyDuplicate("build widget", "ship rocket"), false);
    assert.equal(isFuzzyDuplicate("", "anything"), false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Redis list round-trips (own before/after lifecycle)
// ---------------------------------------------------------------------------

describe("redis/work-queue — list round-trips", () => {
  let raw: any;

  before(() => {
    raw = new Redis(process.env.REDIS_URL as string);
  });

  // Fresh-per-case: the queue is shared list state; a sibling case would read
  // items a prior case pushed without a per-case clean (CLAUDE.md pitfall).
  beforeEach(async () => {
    await raw.del(WORK_QUEUE_KEY);
  });

  after(async () => {
    await raw.del(WORK_QUEUE_KEY);
    raw.disconnect();
  });

  test("push → items/len round-trip preserves FIFO order", async () => {
    assert.equal(await pushToWorkQueue(item("alpha")), true);
    assert.equal(await pushToWorkQueue(item("beta")), true);
    assert.equal(await getWorkQueueLen(), 2);
    const refs = (await getWorkQueueItems()).map((r) => JSON.parse(r).reference);
    assert.deepEqual(refs, ["alpha", "beta"]);
  });

  test("push refuses a terminal-state marker (no-op, returns false)", async () => {
    assert.equal(await pushToWorkQueue(item("COMPLETED: #99")), false);
    assert.equal(await pushToWorkQueue(item("CLOSED: done")), false);
    assert.equal(await getWorkQueueLen(), 0);
  });

  test("push queues a non-JSON payload (can't be a terminal marker)", async () => {
    assert.equal(await pushToWorkQueue("just-a-raw-string"), true);
    assert.deepEqual(await getWorkQueueItems(), ["just-a-raw-string"]);
  });

  test("removeWorkQueueItem removes ALL occurrences of the raw value", async () => {
    const dup = item("recurring");
    await pushToWorkQueue(dup);
    await raw.rpush(WORK_QUEUE_KEY, dup); // second identical entry (issue #1690)
    await pushToWorkQueue(item("keep-me"));
    const removed = await removeWorkQueueItem(dup);
    assert.equal(removed, 2);
    const refs = (await getWorkQueueItems()).map((r) => JSON.parse(r).reference);
    assert.deepEqual(refs, ["keep-me"]);
  });

  test("removeWorkQueueItem on a non-matching value is a safe 0", async () => {
    await pushToWorkQueue(item("present"));
    assert.equal(await removeWorkQueueItem(item("absent")), 0);
    assert.equal(await getWorkQueueLen(), 1);
  });

  test("cleanWorkQueue strips terminal markers and fuzzy duplicates", async () => {
    // Seed directly (bypassing pushToWorkQueue's own marker refusal) so the
    // startup GC path is what removes the marker.
    await raw.rpush(WORK_QUEUE_KEY, item("Build the widget"));
    await raw.rpush(WORK_QUEUE_KEY, item("COMPLETED: old task"));
    await raw.rpush(WORK_QUEUE_KEY, item("build   THE   widget")); // fuzzy dup of #1
    await raw.rpush(WORK_QUEUE_KEY, item("Ship the rocket"));

    const { removedCompleted, removedDuplicates } = await cleanWorkQueue();
    assert.equal(removedCompleted, 1);
    assert.equal(removedDuplicates, 1);

    const refs = (await getWorkQueueItems()).map((r) => JSON.parse(r).reference);
    assert.deepEqual(refs, ["Build the widget", "Ship the rocket"]);
  });

  test("cleanWorkQueue on a clean queue removes nothing", async () => {
    await raw.rpush(WORK_QUEUE_KEY, item("only work here"));
    const res = await cleanWorkQueue();
    assert.deepEqual(res, { removedCompleted: 0, removedDuplicates: 0 });
    assert.equal(await getWorkQueueLen(), 1);
  });
});
