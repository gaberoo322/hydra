/**
 * test/now-pixel-oak-crier-state.test.mts — pins the pure folds extracted out
 * of OakTownCrier.jsx (issue #3706).
 *
 * The component previously carried these inline, where nothing could reach
 * them: the dashboard ships no JSX runner, and adding one would need four new
 * devDeps behind the ADR-0005 allowlist AND a `dashboard-build` CI job that has
 * no test step to hook — so the suite would be advisory and could never block a
 * regression. Extracting to a `.ts` sibling puts the behaviour in the REQUIRED
 * `test` job instead, at zero dependency cost. Same seam as
 * now-pixel-oak-tab-state / now-pixel-derive-sprite-state.
 *
 * Not covered here, on purpose: the `ws.subscribe("*")` / `off?.()` lifecycle
 * and the hover-pause `scrollTop = scrollHeight` auto-scroll. A test over those
 * asserts that React and the DOM work, not that Hydra works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_BUBBLE_SOURCE,
  MAX_BUBBLES,
  MAX_BUBBLE_TEXT,
  appendBubble,
  bubbleFrom,
  eventSummary,
  restingNoteFrom,
} from "../dashboard/src/pages/now-pixel/oak-crier-state.ts";

const NOW_ISO = "2026-07-30T12:00:00.000Z";

test("eventSummary — subagent_stop folds slot/status/summary into one line", () => {
  const s = eventSummary({
    type: "slot-event",
    payload: {
      event: "subagent_stop",
      slot: "dev_orch",
      status: "merged",
      summary: "PR #123",
    },
  });
  assert.deepEqual(s, {
    source: "dev_orch",
    text: "dev_orch merged · PR #123",
    kind: "stop",
  });
});

test("eventSummary — subagent_stop defaults status and omits an absent summary", () => {
  const s = eventSummary({
    type: "slot-event",
    payload: { event: "subagent_stop", slot: "qa_orch" },
  });
  assert.equal(s?.text, "qa_orch stopped");
  assert.equal(s?.kind, "stop");
});

test("eventSummary — subagent_stop falls back to 'slot' when the slot is absent", () => {
  const s = eventSummary({
    type: "slot-event",
    payload: { event: "subagent_stop", subagent_type: "hydra-dev" },
  });
  // Source falls through to subagent_type, but the text default is literal.
  assert.equal(s?.source, "hydra-dev");
  assert.equal(s?.text, "slot stopped");
});

test("eventSummary — slot_waiting_permission names the tool when present", () => {
  const withTool = eventSummary({
    type: "slot-event",
    payload: { event: "slot_waiting_permission", slot: "sweep_orch", tool: "Bash" },
  });
  assert.deepEqual(withTool, {
    source: "sweep_orch",
    text: "sweep_orch waiting on permission (Bash)",
    kind: "wait",
  });

  const withoutTool = eventSummary({
    type: "slot-event",
    payload: { event: "slot_waiting_permission", slot: "sweep_orch" },
  });
  assert.equal(withoutTool?.text, "sweep_orch waiting on permission");
});

test("eventSummary — any other slot-event renders the raw event name", () => {
  const named = eventSummary({
    type: "slot-event",
    payload: { event: "slot_started", slot: "retro_orch" },
  });
  assert.deepEqual(named, {
    source: "retro_orch",
    text: "slot_started",
    kind: "slot",
  });

  const unnamed = eventSummary({ type: "slot-event", payload: { slot: "retro_orch" } });
  assert.equal(unnamed?.text, "slot event");
});

test("eventSummary — the 'connected' heartbeat hello is suppressed", () => {
  assert.equal(eventSummary({ type: "connected" }), null);
  assert.equal(eventSummary({ type: "connected", payload: { message: "hi" } }), null);
});

test("eventSummary — a slot-event named 'connected' is NOT suppressed", () => {
  // Branch ordering matters: the slot-event arms run before the heartbeat rule.
  const s = eventSummary({
    type: "slot-event",
    payload: { event: "connected", slot: "health" },
  });
  assert.equal(s?.kind, "slot");
  assert.equal(s?.text, "connected");
});

test("eventSummary — generic frames walk the message fallback chain", () => {
  assert.equal(
    eventSummary({ type: "alert", payload: { message: "m", text: "t", summary: "s" } })?.text,
    "m",
  );
  assert.equal(eventSummary({ type: "alert", payload: { text: "t", summary: "s" } })?.text, "t");
  assert.equal(eventSummary({ type: "alert", payload: { summary: "s" } })?.text, "s");
  assert.equal(eventSummary({ type: "alert", payload: {} })?.text, "alert");
  assert.equal(eventSummary({})?.text, "event");
  assert.equal(eventSummary(null)?.text, "event");
});

test("eventSummary — generic source prefers payload.source, then subagent_type, then type", () => {
  assert.equal(eventSummary({ type: "alert", payload: { source: "a", subagent_type: "b" } })?.source, "a");
  assert.equal(eventSummary({ type: "alert", payload: { subagent_type: "b" } })?.source, "b");
  assert.equal(eventSummary({ type: "alert", payload: {} })?.source, "alert");
  assert.equal(eventSummary({ payload: {} })?.source, undefined);
});

test("eventSummary — generic text is truncated to MAX_BUBBLE_TEXT", () => {
  const long = "x".repeat(MAX_BUBBLE_TEXT + 40);
  const s = eventSummary({ type: "alert", payload: { message: long } });
  assert.equal(s?.text.length, MAX_BUBBLE_TEXT);
  assert.equal(MAX_BUBBLE_TEXT, 120);
});

test("eventSummary — a non-string message never reaches .slice()", () => {
  // The old inline `p.message || …` chain handed an object straight to
  // .slice() and threw inside the WS callback; only strings qualify now.
  const s = eventSummary({ type: "alert", payload: { message: { nested: true } } });
  assert.equal(s?.text, "alert");
});

test("bubbleFrom — carries the frame timestamp, falling back to now", () => {
  const summary = { source: "dev_orch", text: "hello", kind: "generic" as const };
  const withTs = bubbleFrom({ type: "alert", timestamp: "2026-01-01T00:00:00.000Z" }, summary, 7, "#fff", NOW_ISO);
  assert.equal(withTs.ts, "2026-01-01T00:00:00.000Z");
  assert.equal(withTs.id, 7);
  assert.equal(withTs.color, "#fff");

  const withoutTs = bubbleFrom({ type: "alert" }, summary, 8, "#fff", NOW_ISO);
  assert.equal(withoutTs.ts, NOW_ISO);
});

test("bubbleFrom — a sourceless summary renders as the system fallback", () => {
  const b = bubbleFrom({}, { source: undefined, text: "t", kind: "generic" }, 1, "#000", NOW_ISO);
  assert.equal(b.source, FALLBACK_BUBBLE_SOURCE);
  assert.equal(FALLBACK_BUBBLE_SOURCE, "system");
});

test("appendBubble — appends without mutating the previous array", () => {
  const prev = Object.freeze([1, 2, 3]);
  const next = appendBubble(prev, 4);
  assert.deepEqual(next, [1, 2, 3, 4]);
  assert.deepEqual(prev, [1, 2, 3]);
  assert.notEqual(next, prev);
});

test("appendBubble — trims the oldest entries at the MAX_BUBBLES ceiling", () => {
  assert.equal(MAX_BUBBLES, 50);
  let feed: number[] = [];
  for (let i = 0; i < MAX_BUBBLES + 25; i++) feed = appendBubble(feed, i);
  assert.equal(feed.length, MAX_BUBBLES);
  // The newest entry is last and the oldest 25 are gone.
  assert.equal(feed.at(-1), MAX_BUBBLES + 24);
  assert.equal(feed[0], 25);
});

test("appendBubble — trims an already-oversized array back to the ceiling in one call", () => {
  const oversized = Array.from({ length: 80 }, (_, i) => i);
  const next = appendBubble(oversized, 999, 10);
  assert.equal(next.length, 10);
  assert.equal(next.at(-1), 999);
});

test("appendBubble — tolerates a null/undefined previous list", () => {
  assert.deepEqual(appendBubble(null, "a"), ["a"]);
  assert.deepEqual(appendBubble(undefined, "a"), ["a"]);
});

test("restingNoteFrom — parses the oak_resting envelope's spend/cap pair", () => {
  const note = restingNoteFrom(
    {
      type: "oak_resting",
      timestamp: "2026-02-02T00:00:00.000Z",
      payload: { daily_spend_usd: 4.5, daily_cap_usd: 5 },
    },
    NOW_ISO,
  );
  assert.deepEqual(note, { spend: 4.5, cap: 5, ts: "2026-02-02T00:00:00.000Z" });
});

test("restingNoteFrom — missing amounts coerce to 0 and a missing ts falls back to now", () => {
  const note = restingNoteFrom({ type: "oak_resting" }, NOW_ISO);
  assert.deepEqual(note, { spend: 0, cap: 0, ts: NOW_ISO });
});

test("restingNoteFrom — returns null for every other frame type", () => {
  assert.equal(restingNoteFrom({ type: "slot-event", payload: {} }, NOW_ISO), null);
  assert.equal(restingNoteFrom({ type: "connected" }, NOW_ISO), null);
  assert.equal(restingNoteFrom(null, NOW_ISO), null);
  assert.equal(restingNoteFrom(undefined, NOW_ISO), null);
});
