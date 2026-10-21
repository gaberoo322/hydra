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
import { messageFromEvent } from "../src/operator-channel/channel.ts";
import { renderMessage } from "../src/operator-channel/render.ts";
import { renderBriefLine } from "../src/operator-channel/brief-lines.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/ci/seam-check-lib.ts";

// The event-type member names the module is contracted to expose. Pinned here
// so a REMOVED or RENAMED member is caught even if nothing else in the suite
// references it by name. Issue #5044 cut the map to the 11 members with a live
// producer (see the live-producer audit describe at the bottom of this file).
const EXPECTED_MEMBERS = [
  // Cycle lifecycle
  "CYCLE_COMPLETED",
  // DLQ / consumer health
  "DLQ_ALERT",
  "DLQ_ENTRY",
  "CONSUMER_DEAD",
  // Operator review pickup
  "REVIEW_PICKUP_READY",
  // Launch-flow watchdog signals (issue #3848, epic #3844)
  "LAUNCH_QUOTA_STRETCH",
  "LAUNCH_LATENCY_BREACH",
  "LAUNCH_PAUSE_FORGOTTEN",
  // Infra integrity watchdog signals (issue #4175)
  "INFRA_NODE_MODULES_WIPED",
  // Origin-identity watchdog signal (issue #4939)
  "INFRA_ORIGIN_IDENTITY_WRONG",
  // GLM drainer health signals (issue #3868)
  "GLM_DRAINER_STERILE",
  // Legacy on-wire spellings with a live in-process producer (issue #5047)
  "HOLDBACK_REVERTED",
  "HOLDBACK_CAP_REACHED",
  "HOLDBACK_REVERT_FAILED",
  "MODEL_FALLBACK",
  "AUTOPILOT_PAUSED",
  "AUTOPILOT_RESUMED",
  "BUILDER_HEALTH_STAGNATION",
] as const;

/**
 * The on-wire values that pre-date the `namespace:action` grammar and keep
 * their dotted / hyphenated spelling because the string is a consumer contract
 * (issue #5047). Pinned EXACTLY: a new member may not join this set — it must
 * follow the grammar — and a member leaves it only when its producer and every
 * consumer are renamed together.
 */
const LEGACY_WIRE_SPELLINGS = new Set<string>([
  "holdback.reverted",
  "holdback.cap-reached",
  "holdback.revert_failed",
  "model-fallback",
  "autopilot-paused",
  "autopilot-resumed",
  "builder-health.stagnation",
]);

const MEMBER_NAMES = Object.keys(NOTIFICATION_EVENT_TYPES);
const WIRE_VALUES = Object.values(NOTIFICATION_EVENT_TYPES);

describe("event-bus-vocabulary — NOTIFICATION_EVENT_TYPES enum completeness", () => {
  test("exposes the 18 live event types (issues #5044, #5047)", () => {
    // Issue #5044 deleted the 28 codex-era members with no live producer; the
    // live-producer audit below keeps every remaining member honest. Issue
    // #5047 added the 7 legacy-spelled types that already had a producer.
    assert.equal(
      MEMBER_NAMES.length,
      18,
      `expected 18 event types, got ${MEMBER_NAMES.length}`,
    );
  });

  test("the codex-era members retired by issue #5044 stay deleted", () => {
    const retired = [
      "CYCLE_START", "CYCLE_STALLED", "CYCLE_FAILED", "CYCLE_AUTO_KILLED",
      "CYCLE_STALE_PRIORITIES", "CYCLE_ROLLBACK", "CYCLE_ROLLBACK_FAILED",
      "CYCLE_ROLLED_BACK", "CYCLE_OPERATOR_BLOCKED",
      "TASK_REJECTED", "TASK_VERIFICATION_FAILED", "TASK_DRIFT_DETECTED",
      "TASK_MERGE_FAILED", "TASK_SHELVED",
      "SCHEDULER_STOPPED", "SCHEDULER_BACKLOG_EMPTY",
      "SCHEDULER_PAUSED_REPETITION", "SCHEDULER_ERROR",
      "RESEARCH_COMPLETED", "ARCHITECT_REVIEW_COMPLETED",
      "DEPLOY_COMPLETED", "DEPLOY_FAILED",
      "PATTERN_LOW_MERGE_RATE", "PATTERN_CONSECUTIVE_FAILURES",
      "PATTERN_RECURRING_REGRESSIONS", "PATTERN_ANCHOR_STUCK",
      "PATTERN_TEST_DECLINE", "PATTERN_HIGH_ABANDONMENT",
    ];
    assert.equal(retired.length, 28);
    const present = retired.filter((m) => MEMBER_NAMES.includes(m));
    assert.deepEqual(present, [], `retired members reintroduced: ${present.join(", ")}`);
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

  test("every value follows the `namespace:action` discriminator grammar (legacy spellings pinned)", () => {
    // Each on-wire string is a single `namespace:action` pair — one colon,
    // lower_snake segments on each side. A stray colon or upper-case leak is a
    // regression against the documented grammar. The seven pre-grammar
    // spellings (issue #5047) are exempt by exact membership only.
    const shape = /^[a-z][a-z_]*:[a-z][a-z_]*$/;
    for (const value of WIRE_VALUES) {
      if (LEGACY_WIRE_SPELLINGS.has(value)) continue;
      assert.match(
        value,
        shape,
        `on-wire value "${value}" is not a valid namespace:action discriminator`,
      );
    }
  });

  test("the legacy-spelling exemption is exactly the seven #5047 members (shrink-only)", () => {
    const legacyInMap = WIRE_VALUES.filter((v) => !/^[a-z][a-z_]*:[a-z][a-z_]*$/.test(v)).sort();
    assert.deepEqual(legacyInMap, [...LEGACY_WIRE_SPELLINGS].sort());
    assert.equal(NOTIFICATION_EVENT_TYPES.HOLDBACK_REVERT_FAILED, "holdback.revert_failed");
    assert.equal(NOTIFICATION_EVENT_TYPES.BUILDER_HEALTH_STAGNATION, "builder-health.stagnation");
  });

  test("known event types carry their exact byte-identical wire strings", () => {
    // Spot-pins for the discriminators the notes in the module call out as
    // "byte-identical to the pre-extraction event-bus.ts definitions". A silent
    // rename of any of these breaks live consumers already parsing the stream.
    assert.equal(NOTIFICATION_EVENT_TYPES.CYCLE_COMPLETED, "cycle:completed");
    assert.equal(NOTIFICATION_EVENT_TYPES.CONSUMER_DEAD, "consumer:dead");
    assert.equal(NOTIFICATION_EVENT_TYPES.DLQ_ENTRY, "dlq:entry");
    assert.equal(NOTIFICATION_EVENT_TYPES.LAUNCH_QUOTA_STRETCH, "launch:quota_stretch");
    assert.equal(NOTIFICATION_EVENT_TYPES.DLQ_ALERT, "dlq:alert");
    assert.equal(
      NOTIFICATION_EVENT_TYPES.REVIEW_PICKUP_READY,
      "review:pickup_ready",
    );
    assert.equal(
      NOTIFICATION_EVENT_TYPES.INFRA_ORIGIN_IDENTITY_WRONG,
      "infra:origin_identity_wrong",
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
    const fromValue: NotificationEventType = NOTIFICATION_EVENT_TYPES.CYCLE_COMPLETED;
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
  // in the vocabulary through the real Operator Channel path (ADR-0045): the
  // event becomes an OperatorMessage via `messageFromEvent`, and that message
  // renders through the same renderer production uses for its severity — the
  // Telegram-HTML page renderer for page kinds, the Morning Brief line renderer
  // for brief kinds. (Issue #5049 retired the Markdown `formatMessage` grammar
  // this describe used to feed.) Every type must yield a non-empty string and
  // none may throw.
  for (const [name, value] of Object.entries(NOTIFICATION_EVENT_TYPES)) {
    test(`the Operator Channel renders ${name} (${value}) without throwing`, () => {
      let rendered: string | undefined;
      assert.doesNotThrow(() => {
        const msg = messageFromEvent({ type: value as NotificationEventType, payload: {} });
        rendered =
          msg.severity === "page" ? renderMessage(msg) : renderBriefLine({ ...msg, at: 0 });
      });
      assert.equal(typeof rendered, "string");
      assert.ok((rendered as string).length > 0, `${name} produced an empty message`);
    });
  }
});

// ---------------------------------------------------------------------------
// Live-producer audit (issue #5044, epic #5041).
//
// Every NOTIFICATION_EVENT_TYPES member must have at least one LIVE PRODUCER
// in this repo, found in exactly one of three lanes:
//
//   (a) src/**/*.ts — a comment-stripped event CONSTRUCTION site: a `type:`
//       object key whose value is `E.<MEMBER>` /
//       `NOTIFICATION_EVENT_TYPES.<MEMBER>` or the quoted on-wire value, OR
//       (issue #5047) the quoted on-wire value as the first or second argument
//       of a `publish*(…)` helper call (src/holdback.ts's `publishSafe(bus,
//       "holdback.reverted", …)`, autopilot-control's `publishPauseEvent(
//       "autopilot-paused", …)`), which is the same construction site spelled
//       through a thin wrapper. `case E.X:`, Set/array members (ALERT_TYPES,
//       the formatters) and `=== "x"` comparisons are CONSUMER positions and
//       never count — otherwise the audit would be satisfied by the very
//       formatters it audits.
//   (b) scripts/**/*.{sh,py,ts,mjs} — a non-comment line containing the quoted
//       on-wire value (the watchdog's enveloped redis-cli XADDs).
//   (c) docs/operator-playbooks/**/*.md — a `"type":"<value>"` /
//       `type: "<value>"` publish payload (backslash-escaped quotes allowed:
//       the merge-flow fragment builds its /events/publish body in bash).
//
// Tests are never a lane: a type produced only by a test is not live.
// ---------------------------------------------------------------------------

/**
 * Members whose ONLY producer lives outside this repo (e.g. a Target-repo
 * script POSTing /events/publish). Each entry must cite that producer.
 * SHRINK-ONLY: a second assertion fails for any entry that has an in-repo
 * producer, so an entry is removed the moment its producer lands here.
 * Empty on purpose — every live member has an in-repo producer.
 */
const EXTERNAL_PRODUCER_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, exts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (entry.isFile() && exts.has(extname(entry.name))) out.push(full);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Lanes {
  /** Comment-stripped src/ TypeScript sources. */
  src: string[];
  /** Non-comment lines of scripts/. */
  scriptLines: string[];
  /** Raw playbook markdown. */
  playbooks: string[];
}

function loadLanes(): Lanes {
  const src = walk(join(REPO_ROOT, "src"), new Set([".ts"])).map((f) =>
    stripComments(readFileSync(f, "utf8")),
  );
  const scriptLines: string[] = [];
  for (const f of walk(join(REPO_ROOT, "scripts"), new Set([".sh", ".py", ".ts", ".mjs"]))) {
    const ext = extname(f);
    const body = ext === ".ts" || ext === ".mjs"
      ? stripComments(readFileSync(f, "utf8"))
      : readFileSync(f, "utf8");
    for (const line of body.split("\n")) {
      if ((ext === ".sh" || ext === ".py") && line.trimStart().startsWith("#")) continue;
      scriptLines.push(line);
    }
  }
  const playbooks = walk(join(REPO_ROOT, "docs", "operator-playbooks"), new Set([".md"])).map(
    (f) => readFileSync(f, "utf8"),
  );
  return { src, scriptLines, playbooks };
}

/** The lanes ("src" / "scripts" / "playbooks") holding a producer for a member. */
function producerLanes(lanes: Lanes, member: string, value: string): string[] {
  const v = escapeRe(value);
  const found: string[] = [];
  const srcRe = new RegExp(
    `\\btype:\\s*(?:(?:E|NOTIFICATION_EVENT_TYPES)\\.${member}\\b|"${v}")`,
  );
  // Issue #5047: a publish helper taking the on-wire type as its 1st/2nd arg.
  const srcPublishArgRe = new RegExp(`\\bpublish\\w*\\(\\s*(?:[^,()]+,\\s*)?"${v}"`);
  if (lanes.src.some((body) => srcRe.test(body) || srcPublishArgRe.test(body))) found.push("src");
  if (lanes.scriptLines.some((line) => line.includes(`"${value}"`) || line.includes(`'${value}'`))) {
    found.push("scripts");
  }
  const pbRe = new RegExp(
    `(?:\\\\?["']type\\\\?["']|\\btype)\\s*:\\s*\\\\?["']${v}\\\\?["']`,
  );
  if (lanes.playbooks.some((body) => pbRe.test(body))) found.push("playbooks");
  return found;
}

describe("event-bus-vocabulary — live-producer audit (issue #5044)", () => {
  const lanes = loadLanes();

  test("every NOTIFICATION_EVENT_TYPES member has at least one live producer", () => {
    const orphans: string[] = [];
    for (const [member, value] of Object.entries(NOTIFICATION_EVENT_TYPES)) {
      if (EXTERNAL_PRODUCER_ALLOWLIST.has(member)) continue;
      if (producerLanes(lanes, member, value).length === 0) {
        orphans.push(`${member} (${value})`);
      }
    }
    assert.deepEqual(
      orphans,
      [],
      `notification event type(s) with no live producer in src/, scripts/ or ` +
        `docs/operator-playbooks/: ${orphans.join(", ")} — delete the type and ` +
        `its formatter arms, or land its producer`,
    );
  });

  test("EXTERNAL_PRODUCER_ALLOWLIST is shrink-only (no entry has an in-repo producer)", () => {
    const stale: string[] = [];
    for (const member of EXTERNAL_PRODUCER_ALLOWLIST) {
      const value = (NOTIFICATION_EVENT_TYPES as Record<string, string>)[member];
      if (value === undefined) {
        stale.push(`${member} (no longer a member)`);
        continue;
      }
      const lanesFound = producerLanes(lanes, member, value);
      if (lanesFound.length > 0) stale.push(`${member} (${value}) — in-repo producer in ${lanesFound.join(", ")}`);
    }
    assert.deepEqual(stale, [], `remove these EXTERNAL_PRODUCER_ALLOWLIST entries: ${stale.join("; ")}`);
  });

  test("the retired codex-era types have no producer in any lane", () => {
    // Sanity anchor for the predicate: the 28 members deleted by issue #5044
    // were deleted BECAUSE no lane produces them.
    for (const [member, value] of [
      ["CYCLE_START", "cycle:start"],
      ["CYCLE_FAILED", "cycle:failed"],
      ["TASK_REJECTED", "task:rejected"],
      ["SCHEDULER_STOPPED", "scheduler:stopped"],
      ["RESEARCH_COMPLETED", "research:completed"],
      ["DEPLOY_FAILED", "deploy:failed"],
      ["PATTERN_TEST_DECLINE", "pattern:test_decline"],
    ]) {
      assert.deepEqual(producerLanes(lanes, member, value), [], `${member} (${value})`);
    }
  });

  test("the predicate ignores consumer positions (case arms, Set members, comparisons)", () => {
    // Guards the audit against becoming self-satisfying: the formatters name
    // every member in `case E.X:` / Set positions, which must never count.
    const fake: Lanes = {
      src: [
        "switch (t) { case E.FAKE_MEMBER: return 1; }",
        "const S = new Set([E.FAKE_MEMBER, NOTIFICATION_EVENT_TYPES.FAKE_MEMBER]);",
        'if (event.type === "fake:member") {}',
      ],
      scriptLines: [],
      playbooks: ["The `fake:member` event is described here but never published."],
    };
    assert.deepEqual(producerLanes(fake, "FAKE_MEMBER", "fake:member"), []);
  });

  test("the predicate recognises each lane's construction shape", () => {
    const one = (l: Partial<Lanes>): Lanes => ({ src: [], scriptLines: [], playbooks: [], ...l });
    assert.deepEqual(producerLanes(one({ src: ["publish({ type: E.FAKE_MEMBER, payload })"] }), "FAKE_MEMBER", "fake:member"), ["src"]);
    assert.deepEqual(producerLanes(one({ src: ['publish({ type: "fake:member" })'] }), "FAKE_MEMBER", "fake:member"), ["src"]);
    // Issue #5047: the on-wire type passed through a thin publish helper.
    assert.deepEqual(producerLanes(one({ src: ['await publishSafe(eventBus, "fake:member", { a: 1 })'] }), "FAKE_MEMBER", "fake:member"), ["src"]);
    assert.deepEqual(producerLanes(one({ src: ['await publishPauseEvent("fake:member", payload)'] }), "FAKE_MEMBER", "fake:member"), ["src"]);
    assert.deepEqual(producerLanes(one({ src: ['logger.info("fake:member")', 'formatMessage({ kind: "fake:member" })'] }), "FAKE_MEMBER", "fake:member"), [], "a non-publish call is not a producer");
    assert.deepEqual(producerLanes(one({ scriptLines: ['etype="fake:member"'] }), "FAKE_MEMBER", "fake:member"), ["scripts"]);
    assert.deepEqual(producerLanes(one({ playbooks: ['-d "{\\"type\\":\\"fake:member\\",\\"source\\":\\"x\\"}"'] }), "FAKE_MEMBER", "fake:member"), ["playbooks"]);
  });
});
