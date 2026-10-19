/**
 * Unit tests for the pure Notification Formatter (`src/notify-format.ts`,
 * issue #1512) — the formatting grammar lifted out of `src/notify.ts`.
 *
 * These exercise every arm of the `formatMessage` switch (the live event
 * types, the dual-shape `cycle:completed` payload, and the two `default`
 * fallbacks) with **no network, no env vars, and no `fetch` stub** — the
 * testability win the extraction exists to deliver. The codex-era types
 * retired by issue #5044 (no live producer) are pinned as falling to the
 * generic `default` arm, and every live type is pinned byte-for-byte. The formatter is imported directly from
 * `notify-format.ts` to prove it stands alone, independent of the transport.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { formatMessage } from "../src/notify-format.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";

describe("formatMessage — cycle lifecycle", () => {
  test("cycle:completed (task shape, merged) renders icon, task, tests, commit, files, duration", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: {
        cycleId: "c-2",
        task: { finalState: "merged", title: "Add X" },
        grounding: { before: { passed: 10 }, after: { passed: 12 } },
        commitSha: "abcdef1234567890",
        filesChanged: ["a.ts", "b.ts"],
        durationMs: 4200,
      },
    });
    assert.ok(msg.includes("✅"));
    assert.ok(msg.includes("Cycle Complete — merged"));
    assert.ok(msg.includes("Task: Add X"));
    assert.ok(msg.includes("10 → 12 passing"));
    assert.ok(msg.includes("abcdef1")); // 7-char short sha
    assert.ok(msg.includes("Files: 2 changed"));
    assert.ok(msg.includes("Duration: 4s"));
  });

  test("cycle:completed (task shape, rolled-back) shows the rollback icon + regression + risk", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: {
        cycleId: "c-3",
        task: { finalState: "rolled-back", title: "Risky" },
        rolledBack: true,
        rollbackRisk: "high",
      },
    });
    assert.ok(msg.includes("⏪"));
    assert.ok(msg.includes("auto-reverted"));
    assert.ok(msg.includes("Risk: HIGH"));
    assert.ok(msg.includes("Duration: ?")); // no durationMs -> "?"
  });

  test("cycle:completed (task shape, other final state) uses the default icon", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: { cycleId: "c-3b", task: { finalState: "failed", title: "Nope" } },
    });
    assert.ok(msg.includes("📋"));
    assert.ok(msg.includes("Cycle Complete — failed"));
  });

  test("cycle:completed (count-only fallback shape) renders the succeeded/failed counts", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: { total: 5, completed: 4, failed: 1 },
    });
    assert.ok(msg.includes("Cycle Complete"));
    assert.ok(msg.includes("4/5 tasks succeeded"));
    assert.ok(msg.includes("1 failed"));
  });

  test("cycle:completed (count-only, zero failed) omits the failed clause", () => {
    const msg = formatMessage({
      type: E.CYCLE_COMPLETED,
      payload: { total: 3, completed: 3 },
    });
    assert.ok(msg.includes("3/3 tasks succeeded"));
    assert.ok(!msg.includes("failed"));
  });
});

describe("formatMessage — DLQ", () => {
  test("dlq:alert renders stream/event/error/attempts", () => {
    const msg = formatMessage({
      type: E.DLQ_ALERT,
      payload: { originalStream: "hydra:x", eventType: "task:foo", error: "bad", deliveryCount: 3 },
    });
    assert.ok(msg.includes("Dead Letter"));
    assert.ok(msg.includes("hydra:x"));
    assert.ok(msg.includes("task:foo"));
    assert.ok(msg.includes("Attempts: 3"));
  });
});

describe("formatMessage — review pickup", () => {
  test("review:pickup_ready renders count (plural), command, first item + link", () => {
    const msg = formatMessage({
      type: E.REVIEW_PICKUP_READY,
      payload: { count: 3, firstTitle: "Decide tier", firstUrl: "https://x/710" },
    });
    assert.ok(msg.includes("3 items"));
    assert.ok(msg.includes("/hydra-review"));
    assert.ok(msg.includes("First: Decide tier — https://x/710"));
  });

  test("review:pickup_ready singular wording for one item, omits link when no url", () => {
    const msg = formatMessage({
      type: E.REVIEW_PICKUP_READY,
      payload: { count: 1, firstTitle: "Only one" },
    });
    assert.ok(msg.includes("1 item need"));
    assert.ok(!msg.includes("1 items"));
    assert.ok(msg.includes("First: Only one"));
  });

  test("review:pickup_ready omits the first-item line when no title", () => {
    const msg = formatMessage({ type: E.REVIEW_PICKUP_READY, payload: { count: 0 } });
    assert.ok(msg.includes("0 items"));
    assert.ok(!msg.includes("First:"));
  });
});

describe("formatMessage — default arms", () => {
  test("unknown type containing 'failed' uses the warning fallback", () => {
    const msg = formatMessage({ type: "widget:failed", payload: { reason: "kaput" } });
    assert.ok(msg.includes("widget:failed"));
    assert.ok(msg.includes("kaput"));
    assert.ok(msg.startsWith("⚠️"));
  });

  test("unknown non-failed type uses the clipboard fallback (summary/title)", () => {
    const msg = formatMessage({ type: "widget:happened", payload: { title: "hello" } });
    assert.ok(msg.includes("widget:happened"));
    assert.ok(msg.includes("hello"));
    assert.ok(msg.startsWith("📋"));
  });

  test("missing type defaults to 'unknown' and serializes payload", () => {
    const msg = formatMessage({ payload: { foo: "bar" } });
    assert.ok(msg.includes("unknown"));
    assert.ok(msg.includes("bar"));
  });

  test("empty event is handled without throwing", () => {
    const msg = formatMessage({});
    assert.ok(msg.includes("unknown"));
  });
});

// Issue #5044: the codex-era event types that had no live producer were
// deleted from NOTIFICATION_EVENT_TYPES together with their dedicated arms.
// Their on-wire strings now reach only the generic `default` arm.
const RETIRED_WIRE_VALUES = [
  "cycle:start", "cycle:stalled", "cycle:failed", "cycle:auto_killed",
  "cycle:stale_priorities", "cycle:rollback", "cycle:rollback_failed",
  "cycle:rolled_back", "cycle:operator_blocked",
  "task:rejected", "task:verification_failed", "task:drift_detected",
  "task:merge_failed", "task:shelved",
  "scheduler:stopped", "scheduler:backlog_empty", "scheduler:paused_repetition",
  "scheduler:error",
  "research:completed", "architect:review_completed",
  "deploy:completed", "deploy:failed",
  "pattern:low_merge_rate", "pattern:consecutive_failures",
  "pattern:recurring_regressions", "pattern:anchor_stuck",
  "pattern:test_decline", "pattern:high_abandonment",
] as const;

describe("formatMessage — retired codex-era types (issue #5044)", () => {
  for (const type of RETIRED_WIRE_VALUES) {
    test(`${type} has no dedicated arm and falls to the generic default`, () => {
      const msg = formatMessage({ type, payload: { summary: "s" } });
      const icon = type.includes("failed") ? "⚠️" : "📋";
      assert.equal(msg, `${icon} *${type}*\ns`);
    });
  }
});

describe("formatMessage — live types render byte-identically (issue #5044)", () => {
  test("cycle:completed task shape", () => {
    assert.equal(
      formatMessage({
        type: E.CYCLE_COMPLETED,
        payload: {
          cycleId: "c-2",
          task: { finalState: "merged", title: "Add X" },
          grounding: { before: { passed: 10 }, after: { passed: 12 } },
          filesChanged: ["a.ts", "b.ts"],
          rolledBack: true,
          rollbackRisk: "high",
          durationMs: 4200,
        },
      }),
      "✅ *Cycle Complete — merged*\n`c-2`\nTask: Add X\nTests: 10 → 12 passing\nFiles: 2 changed\n⚠️ Regression detected — auto-reverted\nRisk: HIGH\nDuration: 4s",
    );
  });

  test("cycle:completed count-only shape", () => {
    assert.equal(
      formatMessage({ type: E.CYCLE_COMPLETED, payload: { total: 5, completed: 4, failed: 1 } }),
      "✅ *Cycle Complete*\n4/5 tasks succeeded, 1 failed",
    );
  });

  test("dlq:alert", () => {
    assert.equal(
      formatMessage({
        type: E.DLQ_ALERT,
        payload: { originalStream: "hydra:x", eventType: "task:foo", error: "bad", deliveryCount: 3 },
      }),
      "🔴 *Dead Letter*\nStream: hydra:x\nEvent: task:foo\nError: bad\nAttempts: 3",
    );
  });

  test("review:pickup_ready", () => {
    assert.equal(
      formatMessage({
        type: E.REVIEW_PICKUP_READY,
        payload: { count: 3, firstTitle: "Decide tier", firstUrl: "https://x/710" },
      }),
      "📥 *Review queue — 3 items need attention*\nRun `/hydra-review` to triage.\n\nFirst: Decide tier — https://x/710",
    );
  });

  test("consumer:dead / dlq:entry / launch:quota_stretch reach the default arm unchanged", () => {
    assert.equal(
      formatMessage({ type: E.CONSUMER_DEAD, payload: { consumer: "notifications", error: "boom", restarts: 6 } }),
      '📋 *consumer:dead*\n{"consumer":"notifications","error":"boom","restarts":6}',
    );
    assert.equal(formatMessage({ type: E.DLQ_ENTRY, payload: { summary: "s" } }), "📋 *dlq:entry*\ns");
    assert.equal(
      formatMessage({ type: E.LAUNCH_QUOTA_STRETCH, payload: { reason: "r" } }),
      '📋 *launch:quota_stretch*\n{"reason":"r"}',
    );
  });
});
