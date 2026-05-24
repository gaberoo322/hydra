/**
 * Regression test for abandonment.ts dead try/catch around blockByTitle (issue #573).
 *
 * Bug: `trackAbandonment` wraps `blockByTitle(anchorRef, ...)` in a try/catch
 * with the comment "No Kanban item to block for ..." — but `blockByTitle`
 * returns `false` silently when no matching item exists rather than throwing.
 * The catch never fires, so the diagnostic log line never appears for
 * work-queue/failing-test anchors that have no Kanban row, even though that
 * was the exact case the log was written to surface.
 *
 * Fix: Inspect the boolean return value of `blockByTitle` and emit the
 * appropriate log line. `blockByTitle`'s contract is "returns false silently
 * for not-found"; the caller is responsible for handling that.
 *
 * Requires Redis running on localhost:6379. Uses Redis DB 1 for tests.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;
let testing: any;
let trackAbandonment: any;

async function cleanKeys() {
  const patterns = ["hydra:anchors:*", "hydra:backlog:*"];
  for (const pat of patterns) {
    const keys = await redis.keys(pat);
    if (keys.length > 0) await redis.del(...keys);
  }
}

/** Capture console.log calls during fn(). Returns captured lines as a string array. */
async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: any[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("abandonment.ts dead try/catch around blockByTitle (issue #573)", () => {
  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
    }
    await cleanKeys();
    if (!trackAbandonment) {
      const mod = await import("../src/anchor-selection/abandonment.ts");
      const constants = await import("../src/anchor-selection/constants.ts");
      trackAbandonment = mod.trackAbandonment;
      testing = constants;
    }
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("escalation with no Kanban item logs the not-found diagnostic", async () => {
    const anchorRef = "work-queue:no-such-kanban-row-573";
    const task = { title: anchorRef, taskId: "wq-573", description: "" };

    // Drive the counter up to escalation. The last call escalates and
    // attempts to block the (non-existent) Kanban item.
    let escalated = false;
    const logs = await captureConsoleLog(async () => {
      for (let i = 0; i < testing.MAX_CONSECUTIVE_ABANDONMENTS; i++) {
        escalated = await trackAbandonment(anchorRef, task, `reason ${i + 1}`);
      }
    });

    assert.equal(escalated, true, "should escalate after MAX_CONSECUTIVE_ABANDONMENTS");

    // The "no kanban item" branch must have fired. Before the fix this log
    // line could never appear because blockByTitle does not throw.
    const noKanbanLog = logs.find((l) =>
      l.includes(`No Kanban item to block for "${anchorRef}"`),
    );
    assert.ok(
      noKanbanLog,
      `expected "No Kanban item to block for \"${anchorRef}\"" diagnostic, got logs:\n${logs.join("\n")}`,
    );

    // The "successfully blocked" log MUST NOT appear when the item didn't exist.
    const blockedLog = logs.find((l) =>
      l.includes(`Blocked Kanban item "${anchorRef}"`),
    );
    assert.equal(
      blockedLog,
      undefined,
      `should NOT log "Blocked Kanban item" when no item existed, but got: ${blockedLog}`,
    );
  });

  test("escalation with a real Kanban item logs the blocked-success diagnostic", async () => {
    const anchorRef = "kanban-row-for-573-test";
    const task = { title: anchorRef, taskId: "kb-573", description: "" };

    // Seed a real backlog item (via the public API) with matching title in
    // the queued lane so blockByTitle returns true.
    const { addToBacklog } = await import("../src/backlog/items.ts");
    const added = await addToBacklog({
      title: anchorRef,
      description: "seed item for issue #573 test",
      lane: "queued",
    });
    assert.equal(added.added, true, `expected seed to add cleanly, got ${JSON.stringify(added)}`);

    let escalated = false;
    const logs = await captureConsoleLog(async () => {
      for (let i = 0; i < testing.MAX_CONSECUTIVE_ABANDONMENTS; i++) {
        escalated = await trackAbandonment(anchorRef, task, `reason ${i + 1}`);
      }
    });

    assert.equal(escalated, true);

    const blockedLog = logs.find((l) =>
      l.includes(`Blocked Kanban item "${anchorRef}"`),
    );
    assert.ok(
      blockedLog,
      `expected "Blocked Kanban item \"${anchorRef}\"" diagnostic, got logs:\n${logs.join("\n")}`,
    );

    const noKanbanLog = logs.find((l) =>
      l.includes(`No Kanban item to block for "${anchorRef}"`),
    );
    assert.equal(
      noKanbanLog,
      undefined,
      `should NOT log "No Kanban item to block" when item existed, but got: ${noKanbanLog}`,
    );
  });
});
