/**
 * DigestAccumulator seam tests (issue #1487).
 *
 * Exercises the last side-effecting surface of the digest module — event
 * batching, page routing, and quiet-hours skip — by constructing a
 * FRESH `DigestAccumulator` per case with an injected clock and a capturing
 * sender. No module-level state to reset: each test owns its own instance.
 *
 * Deps injected: `now` (a fixed-hour clock so quiet-hours is deterministic),
 * `send` (captures every outbound message), and stubbed `getCapacity` /
 * `getBuilderHealth` so `sendDigest` never touches Redis.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { DigestAccumulator, shouldSendDigest } from "../src/digest.ts";
import { PAGE_KINDS, isPageKind } from "../src/operator-channel/page-list.ts";
import type { OperatorMessage } from "../src/operator-channel/message.ts";
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
  const pages: OperatorMessage[] = [];
  const channel = {
    page: async (m: OperatorMessage) => {
      pages.push(m);
      return { sent: true as const, kind: "page" as const };
    },
    brief: async () => ({ appended: true }),
  };
  const acc = new DigestAccumulator({
    channel,
    now,
    send: async (message: string) => {
      sent.push(message);
    },
    getCapacity: async () => null,
    getBuilderHealth: async () => null,
  });
  return { acc, sent, pages };
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

describe("DigestAccumulator — page routing", () => {
  it("routes a page-kind event to the channel, not the batch", async () => {
    const { acc, sent, pages } = makeAccumulator(DAYTIME);

    acc.recordEvent({
      type: E.INFRA_NODE_MODULES_WIPED,
      payload: { signal: "/home/x/node_modules", reason: "absent" },
    });

    await Promise.resolve();
    assert.equal(pages.length, 1);
    assert.equal(sent.length, 0);

    // The paged event is NOT also buffered into the next digest.
    await acc.sendDigest();
    assert.equal(sent.length, 0);
  });

  it("treats every member of the page list as a page", async () => {
    for (const type of PAGE_KINDS) {
      const { acc, pages } = makeAccumulator(DAYTIME);
      acc.recordEvent({ type, payload: {} });
      await Promise.resolve();
      assert.equal(pages.length, 1, `expected a page for ${type}`);
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

  it("page-kind events still page during quiet hours", async () => {
    const { acc, pages } = makeAccumulator(NIGHT);

    acc.recordEvent({ type: E.LAUNCH_QUOTA_STRETCH, payload: {} });
    await Promise.resolve();

    assert.equal(pages.length, 1);
  });

  it("daily heartbeat always sends, ignoring quiet hours", async () => {
    const { acc, sent } = makeAccumulator(NIGHT);

    await acc.sendDailyHeartbeat();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /💓 \*Hydra Daily Heartbeat\*/);
  });
});

describe("shouldSendDigest — flush-threshold policy (issue #2212)", () => {
  it("fires a digest when daytime and events are pending", () => {
    assert.deepEqual(shouldSendDigest(5, 12), { send: true, reason: "send" });
  });

  it("suppresses during quiet hours even with pending events", () => {
    assert.deepEqual(shouldSendDigest(5, 23), {
      send: false,
      reason: "quiet-hours",
    });
  });

  it("suppresses at the quiet-start boundary (22:00 is quiet)", () => {
    assert.deepEqual(shouldSendDigest(5, 22), {
      send: false,
      reason: "quiet-hours",
    });
  });

  it("fires at the quiet-end boundary (07:00 is daytime)", () => {
    assert.deepEqual(shouldSendDigest(5, 7), { send: true, reason: "send" });
  });

  it("suppresses an empty batch during daytime", () => {
    assert.deepEqual(shouldSendDigest(0, 12), {
      send: false,
      reason: "no-events",
    });
  });

  it("reports quiet-hours before no-events when both gates apply", () => {
    // Quiet-hours is checked first, matching the original inline guard order.
    assert.deepEqual(shouldSendDigest(0, 23), {
      send: false,
      reason: "quiet-hours",
    });
  });
});

describe("page list — membership (ADR-0045)", () => {
  it("includes every watchdog signal that used to bypass the digest", () => {
    for (const type of [
      E.LAUNCH_QUOTA_STRETCH,
      E.LAUNCH_LATENCY_BREACH,
      E.LAUNCH_PAUSE_FORGOTTEN,
      E.INFRA_NODE_MODULES_WIPED,
      E.INFRA_ORIGIN_IDENTITY_WRONG,
      E.GLM_DRAINER_STERILE,
    ]) {
      assert.ok(isPageKind(type), `expected ${type} on the page list`);
    }
  });

  it("does not include a routine batched event type", () => {
    assert.equal(isPageKind(E.CYCLE_COMPLETED), false);
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
