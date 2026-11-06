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
  type AlertGrammarEvent,
} from "../src/notification/alert-grammar.ts";
import { ALERT_TYPES } from "../src/operator-channel/page-list.ts";
import { OperatorChannel } from "../src/operator-channel/channel.ts";
import type { DashboardAlert } from "../src/redis/alerts.ts";
import {
  startConsumerWithRecovery,
  MAX_CONSUMER_RESTARTS,
  BACKOFF_BASE_MS,
  type NotificationEvent,
  startConsumers,
} from "../src/notification-consumer.ts";
import type { OperatorMessage } from "../src/operator-channel/message.ts";
import type { EventBus } from "../src/event-bus.ts";

/** A recording channel so consumer tests never reach Redis or Telegram. */
function stubChannel() {
  const reports: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const resolved: string[] = [];
  return {
    reports,
    resolved,
    report: async (kind: string, payload: Record<string, unknown> = {}) => {
      reports.push({ kind, payload });
      return {
        disposition: "page" as const,
        delivered: true,
        alertWritten: false,
        unknownKind: false,
        outcome: { sent: true as const, kind: "page" as const },
      };
    },
    resolve: async (key: string) => {
      resolved.push(key);
      return { sent: false as const, reason: "not-bad" as const };
    },
  };
}

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
    stubChannel(),
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
      stubChannel(),
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
    // #5065: the watchdog self-heals; the repaired / failed arms say so.
    [{ type: "infra:origin_identity_wrong", payload: { reason: "wrong-origin-url", url: "https://evil", repair: "repaired", newUrl: "https://github.com/gaberoo322/hydra.git", fetch: "ok" } },
      "~/hydra origin identity auto-repaired: wrong-origin-url — origin https://evil -> https://github.com/gaberoo322/hydra.git, fetch ok; find the writer via the .git/config change breadcrumb in the watchdog journal"],
    [{ type: "infra:origin_identity_wrong", payload: { reason: "origin-master-missing", url: "https://github.com/gaberoo322/hydra.git", repair: "failed", note: "auto-repair FAILED: origin fetch failed (rc=128)" } },
      "~/hydra origin identity: origin-master-missing — observed origin https://github.com/gaberoo322/hydra.git; auto-repair FAILED: origin fetch failed (rc=128); restore the orchestrator remote from an operator shell and fetch origin"],
    [{ type: "infra:origin_identity_wrong", payload: { reason: "wrong-origin-url", url: "https://evil", repair: "not-attempted" } },
      "~/hydra origin identity: wrong-origin-url — observed origin https://evil; restore the orchestrator remote from an operator shell and fetch origin"],
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

test("a dead consumer is paged once through the channel, deduped per consumer name", async () => {
  const ch = stubChannel();
  await startConsumerWithRecovery(
    "dlq",
    async () => { throw new Error("boom"); },
    async () => {},
    ch,
  );
  assert.equal(ch.reports.length, 1);
  assert.equal(ch.reports[0].kind, "consumer:dead");
  assert.equal(ch.reports[0].payload.consumer, "dlq");
  assert.equal(ch.reports[0].payload.restarts, MAX_CONSUMER_RESTARTS + 1);
});

test("a dead consumer through a real channel pages once, dedupes per consumer name and writes an error alert", async () => {
  const alerts: DashboardAlert[] = [];
  let sent = 0;
  const dedup = new Map<string, unknown>();
  const channel = new OperatorChannel({
    store: {
      readDedup: async (k: string) => (dedup.get(k) as never) ?? null,
      writeDedup: async (k: string, s: unknown) => void dedup.set(k, s),
      incrSuppressed: async () => {},
      delDedup: async (k: string) => void dedup.delete(k),
      appendBrief: async () => {},
      appendLog: async () => {},
    },
    transport: async () => {
      sent++;
      return { ok: true, mode: "html" } as never;
    },
    alerts: async (a) => (alerts.push(a), true),
  });
  await startConsumerWithRecovery("dlq", async () => { throw new Error("boom"); }, async () => {}, channel);
  assert.equal(sent, 1, "one page");
  assert.equal(dedup.has("consumer:dead:dlq"), true, "deduped per consumer name");
  assert.equal(alerts.length, 1, "the consumer:dead alert is now actually written");
  assert.equal(alerts[0].type, "consumer:dead");
  assert.equal(alerts[0].severity, "error");
});

test("startConsumers resolves consumer:dead:<name> for every consumer at boot", () => {
  const ch = stubChannel();
  // consume() never settles, so the registered consumers just park.
  const bus = {
    consume: () => new Promise(() => {}),
  } as unknown as EventBus;
  startConsumers(bus, ch);
  assert.deepEqual(ch.resolved.sort(), [
    "consumer:dead:dlq",
    "consumer:dead:notifications",
    "consumer:dead:recs-engine",
    "consumer:dead:slot-events-bridge",
  ]);
});
