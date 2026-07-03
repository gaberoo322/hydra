/**
 * Regression tests for the wire-or-retire lane guard — issue #2721.
 *
 * moveItemToLane must reject the exact triple (item labeled 'wire-or-retire'
 * AND source lane 'triage' AND target lane 'backlog') with
 * { ok: false, error: "wire-or-retire items leave triage only as a WIRE task,
 * a RETIRE task, or ready-for-human" } — never throwing (CLAUDE.md
 * lane-mutation result-object convention). A triage-origin wire-or-retire
 * judgment item must leave triage only as a WIRE task or RETIRE task
 * (triage->queued after the verdict rewrite) or ready-for-human
 * (triage->blocked); it may NOT be laundered into the `backlog` lane where no
 * sweep looks (the item-685/687 failure this guard closes).
 *
 * The guard is scoped tightly: any OTHER item (non-wire-or-retire) and any
 * OTHER transition (including the backlog->triage migration direction that
 * restores the laundered items) is completely unaffected.
 *
 * Design note: this is a NEW top-level describe with its OWN before/after
 * lifecycle — NOT nested inside backlog.test.mts's shared describe. Per the
 * CLAUDE.md pitfall, the shared Redis teardown in backlog.test.mts fires when
 * that suite finishes; nesting here would run any later top-level suite
 * against a torn-down connection. Per-case state is reset in beforeEach so no
 * item leaks between cases.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Use Redis DB 1 for tests — same as the sibling backlog suites, cleaned
// between cases.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { addToBacklog } from "../src/backlog/items.ts";
import { moveItemToLane } from "../src/backlog/lanes.ts";
import { getItem } from "../src/backlog/internal.ts";

let redis: any;
let redisAvailable = false;

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

/**
 * Seed one item directly into a lane with the given labels and return its id.
 */
async function seedItem(
  title: string,
  lane: string,
  labels: string[],
): Promise<string> {
  const res = await addToBacklog({ title, lane, labels });
  assert.equal(res.added, true, `expected ${title} to be added`);
  return String(res.id);
}

const REJECT_MESSAGE =
  "wire-or-retire items leave triage only as a WIRE task, a RETIRE task, or ready-for-human";

describe("wire-or-retire lane guard (moveItemToLane, #2721)", () => {
  before(async () => {
    redis = new Redis(process.env.REDIS_URL!);
    try {
      await redis.ping();
      redisAvailable = true;
    } catch {
      redisAvailable = false;
    }
  });

  after(async () => {
    if (redisAvailable) {
      await cleanBacklogKeys();
      await redis.quit();
    } else if (redis) {
      redis.disconnect();
    }
  });

  beforeEach(async () => {
    if (redisAvailable) await cleanBacklogKeys();
  });

  test("rejects triage->backlog for a wire-or-retire item without moving it", async (t) => {
    requireRedis(t);
    const id = await seedItem(
      "cleanup(target): wire-or-retire src/foo.ts",
      "triage",
      ["wire-or-retire", "needs-triage"],
    );

    const result = await moveItemToLane(id, "backlog");
    assert.deepEqual(result, { ok: false, error: REJECT_MESSAGE });

    // The rejection returns before the atomic write — the item is untouched.
    const item = await getItem(id);
    assert.equal(item?.lane, "triage");
  });

  test("allows triage->queued for a wire-or-retire item (WIRE/RETIRE exit)", async (t) => {
    requireRedis(t);
    const id = await seedItem(
      "cleanup(target): wire-or-retire src/bar.ts",
      "triage",
      ["wire-or-retire", "needs-triage"],
    );

    const result = await moveItemToLane(id, "queued");
    assert.deepEqual(result, { ok: true });
    const item = await getItem(id);
    assert.equal(item?.lane, "queued");
  });

  test("allows triage->blocked with a reason for a wire-or-retire item (ready-for-human exit)", async (t) => {
    requireRedis(t);
    const id = await seedItem(
      "cleanup(target): wire-or-retire src/baz.ts",
      "triage",
      ["wire-or-retire", "needs-triage"],
    );

    const result = await moveItemToLane(id, "blocked", { reason: "needs operator decision" });
    assert.deepEqual(result, { ok: true });
    const item = await getItem(id);
    assert.equal(item?.lane, "blocked");
  });

  test("does NOT block triage->backlog for a NON-wire-or-retire item (guard is label-scoped)", async (t) => {
    requireRedis(t);
    const id = await seedItem(
      "an ordinary triage item without the wire-or-retire label",
      "triage",
      ["needs-triage"],
    );

    const result = await moveItemToLane(id, "backlog");
    assert.deepEqual(result, { ok: true });
    const item = await getItem(id);
    assert.equal(item?.lane, "backlog");
  });

  test("does NOT block the backlog->triage migration direction for a wire-or-retire item", async (t) => {
    requireRedis(t);
    // Simulates the one-off migration that restores a laundered item (e.g.
    // item-685/687) from backlog back to triage — the guard only fires on
    // triage->backlog, so the reverse direction stays open.
    const id = await seedItem(
      "cleanup(target): wire-or-retire src/qux.ts",
      "backlog",
      ["wire-or-retire", "needs-triage"],
    );

    const result = await moveItemToLane(id, "triage");
    assert.deepEqual(result, { ok: true });
    const item = await getItem(id);
    assert.equal(item?.lane, "triage");
  });
});
