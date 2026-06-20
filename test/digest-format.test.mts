/**
 * Pure-core digest formatter tests (issue #1181).
 *
 * Exercises `buildDigestMessage` and `formatCriticalAlert` directly — no
 * Telegram calls, no timers, no dynamic imports, no module state. The two async
 * fan-out assemblers (`buildDailyHeartbeat`, `buildWeeklySummary`) moved to
 * `src/digest-fanout.ts` in issue #2215 and are tested in
 * `test/digest-fanout.test.mts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDigestMessage,
  formatCriticalAlert,
} from "../src/digest-format.ts";

// ---------------------------------------------------------------------------
// buildDigestMessage
// ---------------------------------------------------------------------------
describe("buildDigestMessage", () => {
  it("renders the header and an empty-period digest with no events", () => {
    const msg = buildDigestMessage([]);
    assert.match(msg, /📊 \*Hydra Digest\*/);
    assert.match(msg, /\*Cycles:\* None completed in this period/);
    // Capacity block always renders, even with no snapshot.
    assert.match(msg, /\*Capacity split:\*/);
    assert.match(msg, /No cycle history yet/);
    // Builder-health block always renders its header.
    assert.match(msg, /\*Builder health:\*/);
    assert.match(msg, /No builder-health data yet/);
    assert.match(msg, /_Period: no events_/);
  });

  it("summarises merged and failed cycles", () => {
    const events = [
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T08:00:00.000Z",
        payload: { task: { title: "Add thing", finalState: "merged" }, commitSha: "abcdef1234567" },
      },
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T09:00:00.000Z",
        payload: { task: { title: "Broke thing", finalState: "failed" } },
      },
    ];
    const msg = buildDigestMessage(events);
    assert.match(msg, /\*Cycles:\* 2 completed — 1 merged, 1 failed, 0 abandoned/);
    assert.match(msg, /\*Merged:\*/);
    assert.match(msg, /• Add thing/);
    assert.match(msg, /\*Failed:\*/);
    assert.match(msg, /• Broke thing — failed/);
  });

  it("renders the capacity split when a snapshot is supplied", () => {
    const snapshot = {
      orchestrator: { share: 0.3, count: 3, window: 10, floor: 0.25 },
      target: { share: 0.7, count: 7 },
      idle: { count: 0 },
      floorMet: true,
      recent: [],
    };
    const msg = buildDigestMessage([], snapshot);
    assert.match(msg, /• Orchestrator: 30% \(3\/10\) ✅ floor 25%/);
    assert.match(msg, /• Target: 70% \(7\/10\)/);
  });

  it("flags an action item when verification failures cross the threshold", () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      type: "task:verification_failed",
      timestamp: `2026-06-07T0${i}:00:00.000Z`,
      payload: {},
    }));
    const msg = buildDigestMessage(events);
    assert.match(msg, /\*Action items:\*/);
    assert.match(msg, /3 verification failures/);
  });

  it("truncates messages that exceed the Telegram limit", () => {
    // A single merged event with a >4000-char title overflows the message
    // (the merged list caps at 10 rows, so length must come from row width).
    const events = [
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T08:00:00.000Z",
        payload: {
          task: { title: "X".repeat(5000), finalState: "merged" },
        },
      },
    ];
    const msg = buildDigestMessage(events);
    assert.ok(msg.length <= 4000, `expected <= 4000 chars, got ${msg.length}`);
    assert.match(msg, /_\(truncated\)_$/);
  });
});

// ---------------------------------------------------------------------------
// formatCriticalAlert
// ---------------------------------------------------------------------------
describe("formatCriticalAlert", () => {
  it("formats a rollback-failed alert", () => {
    const out = formatCriticalAlert({
      type: "cycle:rollback_failed",
      payload: { title: "Risky change", commitSha: "deadbeefcafe", error: "merge conflict" },
    });
    assert.match(out, /🚨 \*CRITICAL: Rollback Failed\*/);
    assert.match(out, /Task: Risky change/);
    assert.match(out, /deadbee/);
    assert.match(out, /merge conflict/);
  });

  it("formats a scheduler-stopped alert", () => {
    const out = formatCriticalAlert({
      type: "scheduler:stopped",
      payload: { reason: "budget exhausted", cyclesRun: 12 },
    });
    assert.match(out, /🛑 \*Scheduler Stopped\*/);
    assert.match(out, /Reason: budget exhausted/);
    assert.match(out, /Cycles run: 12/);
  });

  it("falls back to a generic alert for unknown types", () => {
    const out = formatCriticalAlert({ type: "something:weird", payload: { a: 1 } });
    assert.match(out, /⚠️ \*something:weird\*/);
    assert.match(out, /"a":1/);
  });
});
