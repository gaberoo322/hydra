/**
 * Unit tests for the event -> Operator Channel router (`src/digest.ts`).
 *
 * The 4h batched digest, 24h heartbeat, quiet hours and `DigestAccumulator`
 * were retired by the Morning Brief (issue #5047, ADR-0045 Decision 7); only
 * `recordEvent` survives. Two surfaces, both reachable without Redis or a real
 * Telegram:
 *   - `PAGE_KINDS`    — the closed page list the router routes on
 *   - `recordEvent`   — page kinds go to `channel.page`, everything else is
 *                       appended as a Morning Brief item
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { recordEvent } from "../src/digest.ts";
import { PAGE_KINDS, isPageKind } from "../src/operator-channel/page-list.ts";
import { NOTIFICATION_EVENT_TYPES } from "../src/event-bus-vocabulary.ts";
import type { OperatorMessage } from "../src/operator-channel/message.ts";

describe("PAGE_KINDS closed page list", () => {
  test("holds exactly the ADR-0045 Decision 3 list", () => {
    assert.deepEqual([...PAGE_KINDS].sort(), [
      "consumer:dead",
      "glm:drainer_sterile",
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

  test("the holdback page kind is the on-wire (dot) spelling the producer emits", () => {
    assert.equal(isPageKind(NOTIFICATION_EVENT_TYPES.HOLDBACK_REVERT_FAILED), true);
    assert.equal(isPageKind("holdback:revert_failed"), false);
  });

  test("does NOT include an ordinary batched or dead-letter event type", () => {
    assert.equal(isPageKind("cycle:completed"), false);
    assert.equal(isPageKind("dlq:alert"), false);
    for (const t of ["cycle:rollback_failed", "scheduler:stopped"]) {
      assert.equal(isPageKind(t), false, t);
    }
  });
});

describe("recordEvent — routing to the Operator Channel", () => {
  function makeChannel() {
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
    return { channel, pages, briefs };
  }

  test("a page-kind event goes to channel.page once and is not appended as a brief item", async () => {
    const { channel, pages, briefs } = makeChannel();
    recordEvent({ type: "launch:quota_stretch", payload: { reason: "5h cap" } }, channel);
    await Promise.resolve();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].kind, "launch:quota_stretch");
    assert.equal(pages[0].severity, "page");
    assert.equal(briefs.length, 0);
  });

  test("every member of the page list is paged", async () => {
    for (const kind of PAGE_KINDS) {
      const { channel, pages, briefs } = makeChannel();
      recordEvent({ type: kind, payload: {} }, channel);
      await Promise.resolve();
      assert.equal(pages.length, 1, kind);
      assert.equal(briefs.length, 0, kind);
    }
  });

  test("a non-page event is appended as a brief item, never paged", async () => {
    const { channel, pages, briefs } = makeChannel();
    recordEvent({ type: "cycle:completed", payload: { title: "t" } }, channel);
    await Promise.resolve();
    assert.equal(pages.length, 0);
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].kind, "cycle:completed");
  });

  test("a failing channel never throws to the producer", async () => {
    const channel = {
      page: async () => {
        throw new Error("redis down");
      },
      brief: async () => {
        throw new Error("redis down");
      },
    };
    recordEvent({ type: "cycle:completed" }, channel as any);
    recordEvent({ type: "consumer:dead" }, channel as any);
    await new Promise((r) => setImmediate(r));
    assert.ok(true);
  });
});
