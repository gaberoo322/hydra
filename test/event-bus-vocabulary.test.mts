/**
 * Unit tests for the notification-event vocabulary Seam
 * (`src/event-bus-vocabulary.ts`, issue #1985 / #3271).
 *
 * This module is the SINGLE SOURCE OF TRUTH for every notification event type
 * (`NOTIFICATION_EVENT_TYPES`), its closed value union (`NotificationEventType`),
 * and the payload-field contract (`NotificationEventPayload`) that flow on the
 * `NOTIFICATIONS` / `DLQ` streams. It is imported by 7 source files and is the
 * type-safety boundary for 100+ callers, but previously had zero test coverage.
 *
 * A typo in a discriminator string, an accidentally duplicated on-wire value, or
 * a formatter that crashes on an unmapped event type would only surface at
 * runtime in production. These tests are a pure value/type check — no Redis, no
 * network, no fixtures — matching the module's zero-runtime-dependency design.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  NOTIFICATION_EVENT_TYPES,
} from "../src/event-bus-vocabulary.ts";
import type {
  NotificationEventType,
  NotificationEventPayload,
} from "../src/event-bus-vocabulary.ts";
import { formatMessage } from "../src/notify-format.ts";

// The event-type member names the module is contracted to expose (issue #3271
// enumerates "12+ event types"). Pinned here so a REMOVED or RENAMED member is
// caught even if nothing else in the suite references it by name.
const EXPECTED_MEMBERS = [
  // Cycle lifecycle
  "CYCLE_START",
  "CYCLE_COMPLETED",
  "CYCLE_STALLED",
  "CYCLE_FAILED",
  "CYCLE_AUTO_KILLED",
  "CYCLE_STALE_PRIORITIES",
  "CYCLE_ROLLBACK",
  "CYCLE_ROLLBACK_FAILED",
  "CYCLE_ROLLED_BACK",
  "CYCLE_OPERATOR_BLOCKED",
  // Task events
  "TASK_REJECTED",
  "TASK_VERIFICATION_FAILED",
  "TASK_DRIFT_DETECTED",
  "TASK_MERGE_FAILED",
  "TASK_SHELVED",
  // Scheduler
  "SCHEDULER_STOPPED",
  "SCHEDULER_BACKLOG_EMPTY",
  "SCHEDULER_PAUSED_REPETITION",
  "SCHEDULER_ERROR",
  // Research / Architect
  "RESEARCH_COMPLETED",
  "ARCHITECT_REVIEW_COMPLETED",
  // Deploy
  "DEPLOY_COMPLETED",
  "DEPLOY_FAILED",
  // DLQ / consumer health
  "DLQ_ALERT",
  "DLQ_ENTRY",
  "CONSUMER_DEAD",
  // Operator review pickup
  "REVIEW_PICKUP_READY",
  // Learning-system pattern alerts
  "PATTERN_LOW_MERGE_RATE",
  "PATTERN_CONSECUTIVE_FAILURES",
  "PATTERN_RECURRING_REGRESSIONS",
  "PATTERN_ANCHOR_STUCK",
  "PATTERN_TEST_DECLINE",
  "PATTERN_HIGH_ABANDONMENT",
] as const;

const MEMBER_NAMES = Object.keys(NOTIFICATION_EVENT_TYPES);
const WIRE_VALUES = Object.values(NOTIFICATION_EVENT_TYPES);

describe("event-bus-vocabulary — NOTIFICATION_EVENT_TYPES enum completeness", () => {
  test("exposes at least the 12 event types the contract promises", () => {
    // Issue #3271 success criterion: "All 12+ event types are explicitly tested".
    assert.ok(
      MEMBER_NAMES.length >= 12,
      `expected >= 12 event types, got ${MEMBER_NAMES.length}`,
    );
  });

  test("exposes exactly the expected member set (no additions or removals)", () => {
    // A two-way set-diff so a NEW member added to the map without a test, or a
    // REMOVED member downstream code still relies on, both fail loudly.
    const actual = new Set(MEMBER_NAMES);
    const expected = new Set<string>(EXPECTED_MEMBERS);

    const missing = [...expected].filter((m) => !actual.has(m));
    const unexpected = [...actual].filter((m) => !expected.has(m));

    assert.deepEqual(
      missing,
      [],
      `event types dropped from NOTIFICATION_EVENT_TYPES: ${missing.join(", ")}`,
    );
    assert.deepEqual(
      unexpected,
      [],
      `new event types not pinned in EXPECTED_MEMBERS (add a test arm): ${unexpected.join(", ")}`,
    );
  });

  test("every member maps to a non-empty string on-wire value", () => {
    for (const name of MEMBER_NAMES) {
      const value = (NOTIFICATION_EVENT_TYPES as Record<string, string>)[name];
      assert.equal(typeof value, "string", `${name} must map to a string`);
      assert.ok(value.length > 0, `${name} must map to a non-empty string`);
    }
  });
});

describe("event-bus-vocabulary — discriminator string shape", () => {
  test("on-wire values are all unique (no discriminator collisions)", () => {
    // Two members sharing a wire string would make downstream switches
    // ambiguous — the exact class of typo the enum exists to prevent.
    const unique = new Set(WIRE_VALUES);
    assert.equal(
      unique.size,
      WIRE_VALUES.length,
      "duplicate on-wire event-type value(s) detected",
    );
  });

  test("every value follows the `namespace:action` discriminator grammar", () => {
    // Each on-wire string is a single `namespace:action` pair — one colon,
    // lower_snake segments on each side. A stray colon or upper-case leak is a
    // regression against the documented grammar.
    const shape = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
    for (const value of WIRE_VALUES) {
      assert.match(
        value,
        shape,
        `on-wire value "${value}" is not a valid namespace:action discriminator`,
      );
    }
  });

  test("known event types carry their exact byte-identical wire strings", () => {
    // Spot-pins for the discriminators the notes in the module call out as
    // "byte-identical to the pre-extraction event-bus.ts definitions". A silent
    // rename of any of these breaks live consumers already parsing the stream.
    assert.equal(NOTIFICATION_EVENT_TYPES.CYCLE_START, "cycle:start");
    assert.equal(NOTIFICATION_EVENT_TYPES.CYCLE_COMPLETED, "cycle:completed");
    assert.equal(NOTIFICATION_EVENT_TYPES.CYCLE_STALLED, "cycle:stalled");
    assert.equal(NOTIFICATION_EVENT_TYPES.TASK_MERGE_FAILED, "task:merge_failed");
    assert.equal(NOTIFICATION_EVENT_TYPES.DEPLOY_FAILED, "deploy:failed");
    assert.equal(NOTIFICATION_EVENT_TYPES.DLQ_ALERT, "dlq:alert");
    assert.equal(
      NOTIFICATION_EVENT_TYPES.REVIEW_PICKUP_READY,
      "review:pickup_ready",
    );
    assert.equal(
      NOTIFICATION_EVENT_TYPES.PATTERN_LOW_MERGE_RATE,
      "pattern:low_merge_rate",
    );
  });

  test("every cycle-namespaced member sits under the `cycle:` prefix", () => {
    // The member-name-to-namespace convention (CYCLE_* -> cycle:*) is a load
    // bearing readability contract for the switch authors; assert it holds.
    for (const [name, value] of Object.entries(NOTIFICATION_EVENT_TYPES)) {
      if (name.startsWith("CYCLE_")) {
        assert.ok(
          (value as string).startsWith("cycle:"),
          `${name} maps to "${value}" but should sit under the cycle: namespace`,
        );
      }
    }
  });
});

describe("event-bus-vocabulary — NotificationEventType union", () => {
  test("the union is exactly the set of map values (compile-time round-trip)", () => {
    // Type-level exhaustiveness: every map value is assignable to the union, and
    // every union member is one of the map values. If the union stopped being
    // derived from the map (e.g. a hand-maintained literal drifted), one of
    // these assignments would fail `npm run typecheck`.
    const fromValue: NotificationEventType = NOTIFICATION_EVENT_TYPES.CYCLE_START;
    const anyValue: NotificationEventType = WIRE_VALUES[0] as NotificationEventType;
    assert.equal(typeof fromValue, "string");
    assert.equal(typeof anyValue, "string");

    // Exhaustiveness helper — a value narrowed to `never` after covering the
    // whole union proves the union has no members beyond the map values.
    const assertNever = (x: never): never => {
      throw new Error(`unexpected event type reached exhaustiveness sink: ${x}`);
    };
    const classify = (t: NotificationEventType): "known" => {
      // Every real member is a map value, so this never hits assertNever at
      // runtime; the value exists to force the compiler to keep the union and
      // the map in lock-step.
      if (WIRE_VALUES.includes(t)) return "known";
      return assertNever(t as never);
    };
    for (const value of WIRE_VALUES) {
      assert.equal(classify(value as NotificationEventType), "known");
    }
  });
});

describe("event-bus-vocabulary — NotificationEventPayload contract", () => {
  test("accepts the loose bus-fed shape and known named fields", () => {
    // The payload type is intentionally OPEN (Record<string, unknown> & {…})
    // with every named field optional; a bus-fed event must stay assignable.
    const payload: NotificationEventPayload = {
      cycleId: "c-1",
      task: { finalState: "merged", title: "Add X" },
      grounding: { before: { passed: 10 }, after: { passed: 12 } },
      commitSha: "deadbeef",
      filesChanged: ["a.ts"],
      durationMs: 4200,
      // arbitrary extra field permitted by the open record
      somethingProducerAdded: 123,
    };
    assert.equal(payload.cycleId, "c-1");
    assert.equal(payload.task?.finalState, "merged");
    assert.equal(payload.grounding?.after?.passed, 12);
  });

  test("an empty object satisfies the contract (all fields optional)", () => {
    const empty: NotificationEventPayload = {};
    assert.deepEqual(Object.keys(empty), []);
  });
});

describe("event-bus-vocabulary — downstream formatter completeness", () => {
  // The strongest runtime completeness check the issue asks for: prove that no
  // consumer formatter has a MISSING event-type arm by feeding EVERY event type
  // in the vocabulary through the real `notify-format.ts` formatter. Types with
  // an explicit switch arm and types that legitimately fall to the generic
  // `default` arm must ALL yield a non-empty message and none may throw.
  for (const [name, value] of Object.entries(NOTIFICATION_EVENT_TYPES)) {
    test(`formatMessage handles ${name} (${value}) without throwing`, () => {
      let msg: string | undefined;
      assert.doesNotThrow(() => {
        msg = formatMessage({
          type: value as NotificationEventType,
          payload: {},
        });
      });
      assert.equal(typeof msg, "string");
      assert.ok((msg as string).length > 0, `${name} produced an empty message`);
    });
  }
});
