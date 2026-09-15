/**
 * test/now-console-status-strip-state.test.mts — the StatusStrip widgets'
 * derivations (issue #2411, now-status-5, parent #2408; carried verbatim
 * from test/now-console-state.test.mts when #4382 split the module into
 * concern-scoped leaves).
 *
 * The dashboard ships no JSX test runner and deliberately will not adopt one
 * (issue #3706), so the derivations live in the pure
 * dashboard/src/pages/now-console/status-strip-state.ts leaf and are pinned
 * here in the orchestrator suite — the same pattern as
 * now-pixel-oak-tab-state.test.mts.
 *
 * Covers:
 *   - next-dispatch countdown formatting (counting / due / unknown)
 *   - in-flight slot list derivation (order, degradation, empty states)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatNextDispatchCountdown,
  deriveInflightSlots,
} from "../dashboard/src/pages/now-console/status-strip-state.ts";

// ---------------------------------------------------------------------------
// StatusStrip widgets (issue #2411) — next-dispatch countdown
// ---------------------------------------------------------------------------

test("formatNextDispatchCountdown: future ISO renders Xm Ys countdown", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  const c = formatNextDispatchCountdown("2026-06-24T02:02:05.000Z", now);
  assert.equal(c.state, "counting");
  assert.equal(c.label, "next dispatch attempt in 2m 5s");
});

test("formatNextDispatchCountdown: under a minute omits the minutes segment", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  const c = formatNextDispatchCountdown("2026-06-24T02:00:42.000Z", now);
  assert.equal(c.state, "counting");
  assert.equal(c.label, "next dispatch attempt in 42s");
});

test("formatNextDispatchCountdown: null timestamp degrades to unknown", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  assert.deepEqual(formatNextDispatchCountdown(null, now), {
    label: "unknown",
    state: "unknown",
  });
  assert.deepEqual(formatNextDispatchCountdown(undefined, now), {
    label: "unknown",
    state: "unknown",
  });
  assert.deepEqual(formatNextDispatchCountdown("", now), {
    label: "unknown",
    state: "unknown",
  });
});

test("formatNextDispatchCountdown: unparseable timestamp degrades to unknown", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  assert.equal(formatNextDispatchCountdown("not-a-date", now).state, "unknown");
});

test("formatNextDispatchCountdown: past timestamp is due now", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  const c = formatNextDispatchCountdown("2026-06-24T01:59:30.000Z", now);
  assert.equal(c.state, "due");
  assert.equal(c.label, "due now");
});

// ---------------------------------------------------------------------------
// StatusStrip widgets (issue #2411) — in-flight slots
// ---------------------------------------------------------------------------

test("deriveInflightSlots: empty / missing / malformed slots → []", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  assert.deepEqual(deriveInflightSlots({}, now), []);
  assert.deepEqual(deriveInflightSlots(null, now), []);
  assert.deepEqual(deriveInflightSlots(undefined, now), []);
  // a non-object slot value is skipped, not crashed on
  assert.deepEqual(deriveInflightSlots({ a: null, b: undefined as never }, now), []);
});

test("deriveInflightSlots: maps skill + relative start, sorted oldest-first", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  const nowSec = Math.floor(now / 1000);
  const rows = deriveInflightSlots(
    {
      "wt-newer": { skill: "qa_orch", task_id: "t2", started_epoch: nowSec - 90 },
      "wt-older": { skill: "dev_orch", task_id: "t1", started_epoch: nowSec - 600 },
    },
    now,
  );
  assert.equal(rows.length, 2);
  // oldest (600s ago) leads
  assert.equal(rows[0].skill, "dev_orch");
  assert.equal(rows[0].key, "wt-older");
  assert.equal(rows[0].relativeStart, "started 10m ago");
  assert.equal(rows[1].skill, "qa_orch");
  assert.equal(rows[1].relativeStart, "started 1m ago");
});

test("deriveInflightSlots: missing skill/epoch degrade safely", () => {
  const now = Date.parse("2026-06-24T02:00:00.000Z");
  const rows = deriveInflightSlots({ "wt-x": { task_id: "t" } }, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skill, "unknown");
  assert.equal(rows[0].relativeStart, ""); // no usable epoch → omitted segment
  assert.equal(rows[0].taskId, "t");
});
