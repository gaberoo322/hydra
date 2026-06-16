/**
 * DigestAccumulator seam tests (issue #1487).
 *
 * Exercises the last side-effecting surface of the digest module — event
 * batching, critical-event bypass, and quiet-hours skip — by constructing a
 * FRESH `DigestAccumulator` per case with an injected clock and a capturing
 * sender. No module-level state to reset: each test owns its own instance.
 *
 * Deps injected: `now` (a fixed-hour clock so quiet-hours is deterministic),
 * `send` (captures every outbound message), and stubbed `getCapacity` /
 * `getBuilderHealth` so `sendDigest` never touches Redis.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { DigestAccumulator } from "../src/digest.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";

// A clock pinned to a daytime hour (noon) on a fixed date, so isQuietHours()
// is deterministic regardless of when the suite runs. `at(hour)` builds a
// Date at the given local hour for the quiet-hours cases.
const at = (hour: number) => new Date(2026, 5, 9, hour, 0, 0);
const DAYTIME = () => at(12); // noon — never quiet
const NIGHT = () => at(23); // 11pm — quiet hours (>= 22)

/** Build a fresh accumulator with a capturing sender and stubbed readers. */
function makeAccumulator(now: () => Date) {
  const sent: string[] = [];
  const acc = new DigestAccumulator({
    now,
    send: async (message: string) => {
      sent.push(message);
    },
    getCapacity: async () => null,
    getBuilderHealth: async () => null,
  });
  return { acc, sent };
}

describe("DigestAccumulator — batching", () => {
  it("buffers non-critical events and ships them in one digest", async () => {
    const { acc, sent } = makeAccumulator(DAYTIME);

    acc.recordEvent({ type: E.CYCLE_COMPLETED, payload: { cycleId: "c1" } });
    acc.recordEvent({ type: E.CYCLE_COMPLETED, payload: { cycleId: "c2" } });

    // Nothing sent until the digest fires.
    assert.equal(sent.length, 0);

    await acc.sendDigest();

    // Exactly one batched digest covering both events.
    assert.equal(sent.length, 1);
    assert.match(sent[0], /📊 \*Hydra Digest\*/);
  });

  it("drains pending events after a digest — a second digest with no new events skips", async () => {
    const { acc, sent } = makeAccumulator(DAYTIME);

    acc.recordEvent({ type: E.CYCLE_COMPLETED, payload: { cycleId: "c1" } });
    await acc.sendDigest();
    assert.equal(sent.length, 1);

    // No new events recorded → empty-skip, no second send.
    await acc.sendDigest();
    assert.equal(sent.length, 1);
  });

  it("skips when no events have been recorded", async () => {
    const { acc, sent } = makeAccumulator(DAYTIME);
    await acc.sendDigest();
    assert.equal(sent.length, 0);
  });
});

describe("DigestAccumulator — critical-event bypass", () => {
  it("sends a critical event immediately, bypassing the batch", async () => {
    const { acc, sent } = makeAccumulator(DAYTIME);

    acc.recordEvent({
      type: E.CYCLE_ROLLBACK_FAILED,
      payload: { cycleId: "c1", error: "boom" },
    });

    // recordEvent fires the immediate send synchronously (fire-and-forget);
    // the capturing sender resolves on the microtask queue.
    await Promise.resolve();
    assert.equal(sent.length, 1);

    // The bypassed event is NOT also buffered into the next digest.
    await acc.sendDigest();
    assert.equal(sent.length, 1);
  });

  it("treats every member of the critical set as a bypass", async () => {
    const critical = [
      E.CYCLE_ROLLBACK_FAILED,
      E.SCHEDULER_STOPPED,
      E.SCHEDULER_PAUSED_REPETITION,
      E.SCHEDULER_BACKLOG_EMPTY,
    ];

    for (const type of critical) {
      const { acc, sent } = makeAccumulator(DAYTIME);
      acc.recordEvent({ type, payload: {} });
      await Promise.resolve();
      assert.equal(sent.length, 1, `expected immediate send for ${type}`);
    }
  });
});

describe("DigestAccumulator — quiet-hours skip", () => {
  it("skips the batched digest during quiet hours even with pending events", async () => {
    const { acc, sent } = makeAccumulator(NIGHT);

    acc.recordEvent({ type: E.CYCLE_COMPLETED, payload: { cycleId: "c1" } });
    await acc.sendDigest();

    // Quiet hours → no send; events stay pending for a later daytime digest.
    assert.equal(sent.length, 0);
  });

  it("critical events still send during quiet hours", async () => {
    const { acc, sent } = makeAccumulator(NIGHT);

    acc.recordEvent({ type: E.CYCLE_ROLLBACK_FAILED, payload: {} });
    await Promise.resolve();

    assert.equal(sent.length, 1);
  });

  it("daily heartbeat always sends, ignoring quiet hours", async () => {
    const { acc, sent } = makeAccumulator(NIGHT);

    await acc.sendDailyHeartbeat();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /💓 \*Hydra Daily Heartbeat\*/);
  });
});

describe("DigestAccumulator — per-instance isolation", () => {
  // beforeEach is a no-op here on purpose: each test constructs its own
  // accumulator, so there is no shared module state to reset between cases.
  beforeEach(() => {});

  it("two accumulators do not share pending state", async () => {
    const a = makeAccumulator(DAYTIME);
    const b = makeAccumulator(DAYTIME);

    a.acc.recordEvent({ type: E.CYCLE_COMPLETED, payload: { cycleId: "a1" } });

    // b never got the event → b's digest skips, a's digest ships.
    await b.acc.sendDigest();
    assert.equal(b.sent.length, 0);

    await a.acc.sendDigest();
    assert.equal(a.sent.length, 1);
  });
});
