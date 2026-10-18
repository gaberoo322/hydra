/**
 * test/notification-consumer.test.mts — covers the alert-routing grammar and
 * consumer-recovery policy. The grammar was extracted into its own focused
 * Seam at src/notification/alert-grammar.ts (issue #1979); the
 * consumer-recovery lifecycle stays in src/notification-consumer.ts.
 *
 * Imports are now split by owner so the test label matches the thing being
 * tested (the deletion-test locality win): the grammar symbols
 * (formatAlertMessage, classifyAlertSeverity, ALERT_TYPES, AlertSeverity,
 * AlertGrammarEvent) come from alert-grammar.ts; the recovery-lifecycle
 * symbols (startConsumerWithRecovery, MAX_CONSUMER_RESTARTS, BACKOFF_BASE_MS,
 * NotificationEvent) come from notification-consumer.ts. notification-consumer
 * re-exports the grammar symbols too, so importing them from there still
 * resolves — this split is the locality preference, not a hard requirement.
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
  type AlertSeverity,
  type AlertGrammarEvent,
} from "../src/notification/alert-grammar.ts";
import {
  startConsumerWithRecovery,
  MAX_CONSUMER_RESTARTS,
  BACKOFF_BASE_MS,
  type NotificationEvent,
} from "../src/notification-consumer.ts";

test("ALERT_TYPES is an exported, non-empty Set of event-type strings", () => {
  assert.ok(ALERT_TYPES instanceof Set, "ALERT_TYPES should be a Set instance");
  assert.ok(ALERT_TYPES.size > 0, "ALERT_TYPES should not be empty");
  for (const t of ALERT_TYPES) {
    assert.equal(typeof t, "string");
    assert.ok(t.length > 0, "each ALERT_TYPES entry should be a non-empty string");
  }
  // Spot-check a couple of the canonical members survived the extraction.
  assert.ok(ALERT_TYPES.has("launch:quota_stretch"));
  assert.ok(ALERT_TYPES.has("consumer:dead"));
});

test("ALERT_TYPES holds exactly the 7 live alert types (issue #5044)", () => {
  assert.deepEqual([...ALERT_TYPES].sort(), [
    "consumer:dead",
    "dlq:alert",
    "glm:drainer_sterile",
    "infra:node_modules_wiped",
    "infra:origin_identity_wrong",
    "launch:latency_breach",
    "launch:quota_stretch",
  ]);
  // launch:pause_forgotten is deliberately a digest line only, never an alert.
  assert.equal(ALERT_TYPES.has("launch:pause_forgotten"), false);
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

test("formatAlertMessage uses dedicated arms for the live alert types", () => {
  const stretch = formatAlertMessage({
    type: "launch:quota_stretch",
    payload: { reason: "5h cap", durationMs: 5400000, thresholdMs: 1800000 },
  });
  assert.ok(stretch.includes("5h cap"));
  assert.ok(stretch.includes("1.5h"));

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
    type: "infra:origin_identity_wrong",
    payload: { reason: "url mismatch", url: "https://elsewhere" },
  };
  const msg = formatAlertMessage(event);
  assert.ok(msg.includes("url mismatch"));
  assert.ok(msg.includes("https://elsewhere"));
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
  // Error tier: a dead consumer — the only live type with a dedicated arm.
  assert.equal(classifyAlertSeverity("consumer:dead"), "error");
  // Info tier: every other live type.
  for (const t of [
    "cycle:completed", "dlq:alert", "dlq:entry", "review:pickup_ready",
    "launch:quota_stretch", "launch:latency_breach", "launch:pause_forgotten",
    "infra:node_modules_wiped", "infra:origin_identity_wrong", "glm:drainer_sterile",
  ]) {
    assert.equal(classifyAlertSeverity(t), "info", t);
  }
});

test("classifyAlertSeverity: codex-era types retired by issue #5044 have no dedicated tier", () => {
  // cycle:failed / cycle:rolled_back (error) and cycle:stalled /
  // cycle:auto_killed (warning) lost their arms with the types themselves.
  for (const t of ["cycle:failed", "cycle:rolled_back", "cycle:stalled", "cycle:auto_killed"]) {
    assert.equal(classifyAlertSeverity(t), "info", t);
  }
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

test("formatAlertMessage renders every live alert type byte-identically (issue #5044)", () => {
  const cases: Array<[AlertGrammarEvent, string]> = [
    [{ type: "dlq:alert", payload: { eventType: "task:foo", deliveryCount: 3, error: "bad" } },
      "Dead letter: task:foo failed 3x — bad"],
    [{ type: "consumer:dead", payload: { consumer: "notifications", restarts: 6 } },
      "Consumer notifications died after 6 restarts"],
    [{ type: "launch:quota_stretch", payload: { reason: "5h cap", durationMs: 5400000, thresholdMs: 1800000 } },
      "Launch quota stretch: autopilot blocked (5h cap) for 1.5h — sustained past the 30min alarm threshold"],
    [{ type: "launch:latency_breach", payload: { durationMs: 45000, thresholdMs: 600000 } },
      "Launch latency breach: eligibility probe took 45s — sustained past the 10min alarm threshold"],
    [{ type: "infra:node_modules_wiped", payload: { signal: "/home/x/node_modules", reason: "absent" } },
      "node_modules integrity: /home/x/node_modules — absent"],
    [{ type: "infra:origin_identity_wrong", payload: { reason: "url mismatch", url: "https://evil" } },
      "~/hydra origin identity: url mismatch — observed origin https://evil; restore the orchestrator remote from an operator shell and fetch origin"],
    [{ type: "glm:drainer_sterile", payload: { durationMs: 7200000, thresholdMs: 3600000 } },
      "GLM drainer sterile: heartbeat live and eligible work queued, but zero drainer PRs — sustained 2h past the 1h threshold; the #3754 partition is hiding glm-eligible work from the Opus lane"],
    [{ type: "launch:pause_forgotten", payload: { a: 1 } },
      'launch:pause_forgotten: {"a":1}'],
  ];
  for (const [event, expected] of cases) {
    assert.equal(formatAlertMessage(event), expected, event.type);
  }
});

test("formatAlertMessage: codex-era types retired by issue #5044 reach only the default arm", () => {
  for (const type of ["cycle:failed", "cycle:operator_blocked", "scheduler:error", "research:completed"]) {
    assert.equal(formatAlertMessage({ type, payload: { a: 1 } }), `${type}: {"a":1}`);
  }
});
