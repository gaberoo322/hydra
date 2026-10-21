/**
 * Unit tests for the notification event -> Operator Channel router
 * (`src/digest.ts`, ADR-0045, issues #5045 / #5047).
 *
 * Since issue #5047 `src/digest.ts` is ONLY the thin `recordEvent` router the
 * notification consumer imports: page-kind events go to `channel.page()`,
 * everything else is appended as a Morning Brief item via `channel.brief()`.
 * The 4h digest accumulator, its quiet-hours gate, both timers and the daily
 * heartbeat are gone (the Morning Brief replaced them — see
 * test/operator-channel-brief.test.mts).
 *
 * No shared Redis seam is touched: the channel is always injected.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as digest from "../src/digest.ts";
import { recordEvent } from "../src/digest.ts";
import { PAGE_KINDS, isPageKind } from "../src/operator-channel/page-list.ts";
import type { OperatorMessage } from "../src/operator-channel/message.ts";

// ---------------------------------------------------------------------------
// PAGE_KINDS — the closed page list (ADR-0045 Decision 3)
// ---------------------------------------------------------------------------

describe("PAGE_KINDS closed page list", () => {
  test("holds exactly the ADR-0045 Decision 3 list", () => {
    assert.deepEqual([...PAGE_KINDS].sort(), [
      "consumer:dead",
      "glm:drainer_sterile",
      // The on-wire spelling src/holdback.ts publishes (issue #5047 fixed the
      // former `holdback:revert_failed` literal that no producer emitted).
      "holdback.revert_failed",
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

  test("does NOT include an ordinary brief-severity or dead-letter event type", () => {
    assert.equal(isPageKind("cycle:completed"), false);
    assert.equal(isPageKind("dlq:alert"), false);
    assert.equal(isPageKind("holdback.reverted"), false);
    assert.equal(isPageKind("holdback:revert_failed"), false, "the mis-spelled literal is gone");
    for (const t of ["cycle:rollback_failed", "scheduler:stopped"]) {
      assert.equal(isPageKind(t), false, t);
    }
  });
});

// ---------------------------------------------------------------------------
// recordEvent — routing with an injected channel
// ---------------------------------------------------------------------------

function fakeChannel(opts: { reject?: boolean } = {}) {
  const pages: OperatorMessage[] = [];
  const briefs: OperatorMessage[] = [];
  const channel = {
    page: async (m: OperatorMessage) => {
      if (opts.reject) throw new Error("channel down");
      pages.push(m);
      return { sent: true as const, kind: "page" as const };
    },
    brief: async (m: OperatorMessage) => {
      if (opts.reject) throw new Error("channel down");
      briefs.push(m);
      return { appended: true };
    },
  };
  return { channel, pages, briefs };
}

describe("recordEvent — routing to the Operator Channel", () => {
  test("a page-kind event goes to channel.page once and is not buffered", async () => {
    const { channel, pages, briefs } = fakeChannel();
    recordEvent({ type: "launch:quota_stretch", payload: { reason: "5h cap" } }, channel);
    await Promise.resolve();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].kind, "launch:quota_stretch");
    assert.equal(pages[0].severity, "page");
    assert.equal(briefs.length, 0);
  });

  test("a non-page event is appended as a brief item, never paged", async () => {
    const { channel, pages, briefs } = fakeChannel();
    recordEvent({ type: "cycle:completed", payload: { title: "t" } }, channel);
    await Promise.resolve();
    assert.equal(pages.length, 0);
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].kind, "cycle:completed");
    assert.equal(briefs[0].severity, "brief");
  });

  test("a self-healed origin identity (repair=repaired) is a brief item, not a page", async () => {
    const { channel, pages, briefs } = fakeChannel();
    recordEvent({ type: "infra:origin_identity_wrong", payload: { repair: "repaired" } }, channel);
    await Promise.resolve();
    assert.equal(pages.length, 0);
    assert.equal(briefs.length, 1);
  });

  test("a rejecting channel is logged and never thrown to the consumer", async () => {
    const { channel } = fakeChannel({ reject: true });
    assert.doesNotThrow(() => recordEvent({ type: "cycle:completed", payload: {} }, channel));
    assert.doesNotThrow(() => recordEvent({ type: "consumer:dead", payload: { consumer: "x" } }, channel));
    await new Promise((r) => setImmediate(r));
  });
});

describe("the 4h digest and 24h heartbeat machinery is gone (issue #5047)", () => {
  test("src/digest.ts exports only the recordEvent router", () => {
    assert.deepEqual(Object.keys(digest).sort(), ["recordEvent"]);
    for (const retired of ["DigestAccumulator", "shouldSendDigest", "startDigest", "stopDigest", "sendDigestNow", "sendDailyHeartbeatNow"]) {
      assert.equal(retired in digest, false, `${retired} must not be exported`);
    }
  });
});
