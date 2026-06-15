/**
 * test/notification-consumer.test.mts — covers the alert-routing grammar and
 * consumer-recovery policy extracted from src/index.ts into the
 * notification-consumer Module (issue #1376).
 *
 * Three contracts are pinned here:
 *   1. formatAlertMessage maps every ALERT_TYPES event to a non-empty string,
 *      and the default branch fires for an unknown event type.
 *   2. ALERT_TYPES is an exported Set const (not an inline closure literal).
 *   3. startConsumerWithRecovery caps at MAX_CONSUMER_RESTARTS and backs off
 *      linearly — asserted via an injected synchronous sleep so the restart
 *      logic is exercised without real timers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatAlertMessage,
  classifyAlertSeverity,
  ALERT_TYPES,
  startConsumerWithRecovery,
  MAX_CONSUMER_RESTARTS,
  BACKOFF_BASE_MS,
  type AlertSeverity,
  type NotificationEvent,
  type AlertGrammarEvent,
} from "../src/notification-consumer.ts";

test("ALERT_TYPES is an exported, non-empty Set of event-type strings", () => {
  assert.ok(ALERT_TYPES instanceof Set, "ALERT_TYPES should be a Set instance");
  assert.ok(ALERT_TYPES.size > 0, "ALERT_TYPES should not be empty");
  for (const t of ALERT_TYPES) {
    assert.equal(typeof t, "string");
    assert.ok(t.length > 0, "each ALERT_TYPES entry should be a non-empty string");
  }
  // Spot-check a couple of the canonical members survived the extraction.
  assert.ok(ALERT_TYPES.has("cycle:failed"));
  assert.ok(ALERT_TYPES.has("consumer:dead"));
});

test("formatAlertMessage maps every ALERT_TYPES event to a non-empty string", () => {
  for (const type of ALERT_TYPES) {
    const event: NotificationEvent = { type, payload: {} };
    const msg = formatAlertMessage(event);
    assert.equal(typeof msg, "string");
    assert.ok(msg.length > 0, `formatAlertMessage(${type}) should be non-empty`);
  }
});

test("formatAlertMessage default branch fires for an unknown event type", () => {
  const event: NotificationEvent = {
    type: "totally:unknown_event",
    payload: { foo: "bar" },
  };
  const msg = formatAlertMessage(event);
  // The default arm prefixes the raw event type and JSON-stringifies the payload.
  assert.ok(msg.startsWith("totally:unknown_event:"), `unexpected default message: ${msg}`);
  assert.ok(msg.includes("foo"), "default branch should include the payload");
});

test("formatAlertMessage uses dedicated arms for known cycle events", () => {
  const failed = formatAlertMessage({
    type: "cycle:failed",
    payload: { taskTitle: "build X", reason: "tsc error" },
  });
  assert.ok(failed.includes("build X"));
  assert.ok(failed.includes("tsc error"));

  const dead = formatAlertMessage({
    type: "consumer:dead",
    payload: { consumer: "notifications", restarts: 6 },
  });
  assert.ok(dead.includes("notifications"));
  assert.ok(dead.includes("6"));
});

test("formatAlertMessage accepts a typed AlertGrammarEvent (issue #1889)", () => {
  // The typed event interface names exactly the payload fields the alert
  // grammar dereferences — mirroring FormatMessageEvent (notify-format.ts) and
  // DigestGrammarEvent (digest-format.ts). A field declared here is contract-
  // checked at the access site, so a renamed read field is a compile error.
  const event: AlertGrammarEvent = {
    type: "cycle:operator_blocked",
    payload: { title: "ship the thing", blockedReason: "needs creds" },
  };
  const msg = formatAlertMessage(event);
  assert.ok(msg.includes("ship the thing"));
  assert.ok(msg.includes("needs creds"));
});

test("AlertGrammarEvent is a structural subset of NotificationEvent (assignable both ways at the call site)", () => {
  // handleNotificationEvent carries NotificationEvent and passes it to
  // formatAlertMessage(AlertGrammarEvent); this pins that the bus-fed shape
  // stays assignable to the narrower grammar type.
  const busEvent: NotificationEvent = {
    type: "dlq:alert",
    payload: { eventType: "cycle:failed", deliveryCount: 3, error: "boom" },
  };
  const narrowed: AlertGrammarEvent = busEvent;
  const msg = formatAlertMessage(narrowed);
  assert.ok(msg.includes("cycle:failed"));
  assert.ok(msg.includes("3"));
});

test("classifyAlertSeverity maps each tier from its canonical event type", () => {
  // One row per severity tier — the boundary the inline ternary used to spell
  // out (issue #1855). Error tier: failed / rolled-back / dead.
  assert.equal(classifyAlertSeverity("cycle:failed"), "error");
  assert.equal(classifyAlertSeverity("cycle:rolled_back"), "error");
  assert.equal(classifyAlertSeverity("consumer:dead"), "error");
  // Warning tier: stalled / auto-killed.
  assert.equal(classifyAlertSeverity("cycle:stalled"), "warning");
  assert.equal(classifyAlertSeverity("cycle:auto_killed"), "warning");
  // Info tier: everything else.
  assert.equal(classifyAlertSeverity("research:completed"), "info");
  assert.equal(classifyAlertSeverity("scheduler:error"), "info");
  assert.equal(classifyAlertSeverity("dlq:alert"), "info");
  assert.equal(classifyAlertSeverity("pattern:low_merge_rate"), "info");
});

test("classifyAlertSeverity returns 'info' for unknown event types (default branch)", () => {
  assert.equal(classifyAlertSeverity("totally:unknown_event"), "info");
  assert.equal(classifyAlertSeverity(""), "info");
});

test("classifyAlertSeverity returns one of the three documented tiers for every ALERT_TYPES member", () => {
  const tiers: AlertSeverity[] = ["error", "warning", "info"];
  for (const type of ALERT_TYPES) {
    const sev = classifyAlertSeverity(type);
    assert.ok(tiers.includes(sev), `classifyAlertSeverity(${type}) = ${sev} is not a documented tier`);
  }
});

test("classifyAlertSeverity is byte-identical to the pre-extraction inline ternary for ALERT_TYPES", () => {
  // Pins behaviour preservation: the extracted function must agree with the
  // exact substring ternary that lived inline in handleNotificationEvent for
  // every event type that can reach it (issue #1855).
  const legacy = (t: string): AlertSeverity =>
    t.includes("failed") || t.includes("dead") || t.includes("rolled_back")
      ? "error"
      : t.includes("stalled") || t.includes("auto_killed")
        ? "warning"
        : "info";
  for (const type of ALERT_TYPES) {
    assert.equal(
      classifyAlertSeverity(type),
      legacy(type),
      `severity drift for ${type}: extracted=${classifyAlertSeverity(type)} legacy=${legacy(type)}`,
    );
  }
});

test("startConsumerWithRecovery returns immediately when startFn succeeds (no restarts)", async () => {
  let calls = 0;
  const delays: number[] = [];
  await startConsumerWithRecovery(
    "ok-consumer",
    async () => { calls++; },
    async (ms) => { delays.push(ms); },
  );
  assert.equal(calls, 1, "startFn should be invoked exactly once on success");
  assert.equal(delays.length, 0, "no backoff sleeps should occur on a clean start");
});

test("startConsumerWithRecovery caps at MAX_CONSUMER_RESTARTS with linear backoff", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await startConsumerWithRecovery(
    "always-crashes",
    async () => { attempts++; throw new Error("boom"); },
    async (ms) => { delays.push(ms); },
  );

  // Loop body runs MAX_CONSUMER_RESTARTS + 1 times: restarts increment to 1..5
  // (each followed by a backoff sleep), then the 6th attempt pushes restarts to
  // 6 (> MAX) and breaks via the CONSUMER_DEAD branch with NO trailing sleep.
  assert.equal(attempts, MAX_CONSUMER_RESTARTS + 1, "startFn should be retried up to the ceiling");
  assert.equal(delays.length, MAX_CONSUMER_RESTARTS, "one backoff sleep per restart below the ceiling");

  // Backoff is linear: BACKOFF_BASE_MS * restartCount for restarts 1..5.
  const expected = Array.from({ length: MAX_CONSUMER_RESTARTS }, (_, i) => BACKOFF_BASE_MS * (i + 1));
  assert.deepEqual(delays, expected, "backoff should be BACKOFF_BASE_MS * restarts");
});

test("startConsumerWithRecovery never throws to its caller on persistent crash", async () => {
  // The whole point of the recovery wrapper: a dead consumer alerts, it does
  // not crash the process. So this must resolve, never reject.
  await assert.doesNotReject(
    startConsumerWithRecovery(
      "noisy",
      async () => { throw new Error("persistent failure"); },
      async () => { /* no-op sleep */ },
    ),
  );
});
