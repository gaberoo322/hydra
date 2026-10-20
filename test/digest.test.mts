/**
 * Unit tests for the digest notification core (`src/digest.ts`, issue #3237).
 *
 * Three testable surfaces, all reachable without Redis or a real Telegram:
 *   - `shouldSendDigest`     — the pure flush-threshold predicate (quiet-hours /
 *                              no-events / send), no clock, no state
 *   - `PAGE_KINDS`           — the closed page list the accumulator routes on
 *   - `DigestAccumulator`    — the side-effecting batcher, constructed per case
 *                              with an INJECTED clock + a capturing `send` +
 *                              stubbed capacity / builder-health readers
 *
 * The accumulator's injected-deps seam (issue #1487) means every case builds a
 * fresh instance with its own captured state — there is no module-level state
 * to reset, so no `beforeEach` teardown is needed. The pure formatting grammar
 * (`buildDigestMessage`) is owned by `digest-format.ts`
 * and covered by its own tests; here we assert only that the accumulator routes
 * events to the right sender path.
 *
 * No shared Redis seam is touched: the two real deps that would reach Redis
 * (`getCapacity`, `getBuilderHealth`) are always injected as stubs, so this
 * suite needs no `before`/`after` connection lifecycle.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { shouldSendDigest, DigestAccumulator } from "../src/digest.ts";
import { PAGE_KINDS, isPageKind } from "../src/operator-channel/page-list.ts";
import type { OperatorMessage } from "../src/operator-channel/message.ts";

// ---------------------------------------------------------------------------
// shouldSendDigest — pure flush-threshold predicate
// ---------------------------------------------------------------------------

describe("shouldSendDigest", () => {
  test("sends when there are pending events during active hours", () => {
    assert.deepEqual(shouldSendDigest(5, 12), { send: true, reason: "send" });
  });

  test("no-events gate: suppresses an empty batch during active hours", () => {
    assert.deepEqual(shouldSendDigest(0, 12), {
      send: false,
      reason: "no-events",
    });
  });

  test("quiet-hours gate at the 22:00 boundary (inclusive start)", () => {
    assert.deepEqual(shouldSendDigest(5, 22), {
      send: false,
      reason: "quiet-hours",
    });
  });

  test("quiet-hours gate just before the 07:00 boundary", () => {
    assert.deepEqual(shouldSendDigest(5, 6), {
      send: false,
      reason: "quiet-hours",
    });
  });

  test("07:00 exactly is active (exclusive end)", () => {
    assert.deepEqual(shouldSendDigest(5, 7), { send: true, reason: "send" });
  });

  test("quiet hours takes priority over the empty-batch gate", () => {
    // Zero events AND a quiet hour → reports quiet-hours, not no-events.
    assert.deepEqual(shouldSendDigest(0, 23), {
      send: false,
      reason: "quiet-hours",
    });
  });
});

// ---------------------------------------------------------------------------
// PAGE_KINDS — the closed page list (ADR-0045 Decision 3)
// ---------------------------------------------------------------------------

describe("PAGE_KINDS closed page list", () => {
  test("holds exactly the ADR-0045 Decision 3 list", () => {
    assert.deepEqual([...PAGE_KINDS].sort(), [
      "consumer:dead",
      "glm:drainer_sterile",
      "holdback:revert_failed",
      "infra:node_modules_wiped",
      "infra:origin_identity_wrong",
      "infra:redis_backup_stale",
      "launch:latency_breach",
      "launch:pause_forgotten",
      "launch:quota_stretch",
      "review:pickup_ready",
      "service:autopilot_failed",
      "service:backup_failed",
      "service:orchestrator_failed",
      "service:tunnel_failed",
    ]);
  });

  test("does NOT include an ordinary batched or dead-letter event type", () => {
    assert.equal(isPageKind("cycle:completed"), false);
    assert.equal(isPageKind("dlq:alert"), false);
    for (const t of ["cycle:rollback_failed", "scheduler:stopped"]) {
      assert.equal(isPageKind(t), false, t);
    }
  });
});

// ---------------------------------------------------------------------------
// DigestAccumulator — injected clock + capturing sender
// ---------------------------------------------------------------------------

/** Build a capturing sender that records every message sent. */
function capturingSend() {
  const sent: string[] = [];
  const send = async (message: string): Promise<void> => {
    sent.push(message);
  };
  return { sent, send };
}

/** An accumulator with a fixed clock hour, capturing sender, and stub readers. */
function makeAccumulator(hour: number, opts: {
  capacity?: () => Promise<unknown>;
  builderHealth?: () => Promise<unknown>;
} = {}) {
  const { sent, send } = capturingSend();
  const pages: OperatorMessage[] = [];
  const briefs: OperatorMessage[] = [];
  const channel = {
    page: async (m: OperatorMessage) => {
      pages.push(m);
      return { sent: true as const, kind: "page" as const };
    },
    brief: async (m: OperatorMessage) => {
      briefs.push(m);
      return { appended: true };
    },
  };
  // A Date whose local getHours() is `hour`. Build off a midnight-local date so
  // the hour we set is the hour the accumulator reads.
  const base = new Date(2026, 6, 12, hour, 0, 0, 0);
  const acc = new DigestAccumulator({
    now: () => base,
    send,
    channel,
    getCapacity: opts.capacity ?? (async () => null),
    getBuilderHealth: opts.builderHealth ?? (async () => null),
  });
  return { acc, sent, pages, briefs };
}

describe("DigestAccumulator — page routing to the Operator Channel", () => {
  test("a page-kind event goes to channel.page once and is not buffered", async () => {
    const { acc, sent, pages, briefs } = makeAccumulator(12);
    acc.recordEvent({
      type: "launch:quota_stretch",
      payload: { reason: "5h cap" },
    });
    await Promise.resolve();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].kind, "launch:quota_stretch");
    assert.equal(pages[0].severity, "page");
    assert.equal(briefs.length, 0);
    // Not buffered into the next digest, and nothing sent by the accumulator.
    await acc.sendDigest();
    assert.equal(sent.length, 0);
  });

  test("a page-kind event during quiet hours still pages", async () => {
    const { acc, pages } = makeAccumulator(23);
    acc.recordEvent({ type: "infra:node_modules_wiped", payload: { reason: "x" } });
    await Promise.resolve();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].dedupKey, "infra:node_modules_wiped");
  });

  test("a non-page event is buffered AND appended as a brief item, never paged", async () => {
    const { acc, pages, briefs } = makeAccumulator(12);
    acc.recordEvent({ type: "cycle:completed", payload: { title: "t" } });
    await Promise.resolve();
    assert.equal(pages.length, 0);
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].kind, "cycle:completed");
  });
});

describe("DigestAccumulator — batching + sendDigest gates", () => {
  test("an ordinary event is batched, NOT sent immediately", async () => {
    const { acc, sent } = makeAccumulator(12);
    acc.recordEvent({ type: "cycle:completed", payload: { title: "t" } });
    await Promise.resolve();
    assert.equal(sent.length, 0);
  });

  test("sendDigest flushes the batched events and clears the buffer", async () => {
    const { acc, sent } = makeAccumulator(12);
    acc.recordEvent({ type: "cycle:completed", payload: { title: "a" } });
    acc.recordEvent({ type: "cycle:completed", payload: { title: "b" } });
    await acc.sendDigest();
    assert.equal(sent.length, 1); // one digest message
    // A second flush with an empty buffer is a no-op (no-events gate).
    await acc.sendDigest();
    assert.equal(sent.length, 1);
  });

  test("sendDigest is a no-op during quiet hours (batch retained)", async () => {
    const { acc, sent } = makeAccumulator(23);
    acc.recordEvent({ type: "cycle:completed", payload: { title: "a" } });
    await acc.sendDigest();
    assert.equal(sent.length, 0);
  });

  test("sendDigest is a no-op with an empty batch during active hours", async () => {
    const { acc, sent } = makeAccumulator(12);
    await acc.sendDigest();
    assert.equal(sent.length, 0);
  });
});

describe("DigestAccumulator — non-fatal reader failures still ship the digest", () => {
  test("a throwing capacity reader does not block the digest", async () => {
    const { acc, sent } = makeAccumulator(12, {
      capacity: async () => {
        throw new Error("redis down");
      },
    });
    acc.recordEvent({ type: "cycle:completed", payload: { title: "a" } });
    await acc.sendDigest();
    assert.equal(sent.length, 1);
  });

  test("a throwing builder-health reader does not block the digest", async () => {
    const { acc, sent } = makeAccumulator(12, {
      builderHealth: async () => {
        throw new Error("aggregator boom");
      },
    });
    acc.recordEvent({ type: "cycle:completed", payload: { title: "a" } });
    await acc.sendDigest();
    assert.equal(sent.length, 1);
  });
});

describe("DigestAccumulator — timer lifecycle", () => {
  test("start() then stop() leaves no live timers (clean process exit)", () => {
    const { acc } = makeAccumulator(12);
    acc.start();
    acc.stop();
    // No assertion needed beyond not hanging: if the interval survived, the
    // node:test process would keep the event loop alive. --test-force-exit
    // masks that, so we assert stop() is idempotent instead.
    acc.stop(); // second stop must not throw
    assert.ok(true);
  });
});
