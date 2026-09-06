/**
 * test/relative-time-format.test.mts — pins the dashboard's canonical
 * epoch → "Ns/Nm/Nh/Nd ago" bucket helper in
 * dashboard/src/lib/relative-time-format.ts (issue #4400).
 *
 * The three formatRelativeTime tests lived in
 * test/now-pixel-oak-tab-state.test.mts while the helper was homed there;
 * they moved with the function when the three hand-duplicated copies
 * (oak-tab-state.ts, console-state.ts's private formatRelativeStart,
 * autopilot-format.js's relativeTime) were consolidated into the one lib
 * module, and gained the exact 60/3600/86400 bucket boundaries no test
 * covered before.
 *
 * Same lib/*.ts testing seam as test/page-item-format.test.mts — the
 * dashboard ships no JSX test runner (issue #3706), so the deterministic
 * coverage lives here in the orchestrator suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRelativeTime } from "../dashboard/src/lib/relative-time-format.ts";

test("formatRelativeTime: seconds / minutes / hours / days bands", () => {
  const now = 1_000_000;
  assert.equal(formatRelativeTime(now - 12, now), "12s ago");
  assert.equal(formatRelativeTime(now - 240, now), "4m ago");
  assert.equal(formatRelativeTime(now - 7200, now), "2h ago");
  assert.equal(formatRelativeTime(now - 172_800, now), "2d ago");
});

test("formatRelativeTime: empty string for invalid input", () => {
  assert.equal(formatRelativeTime(null, 1_000_000), "");
  assert.equal(formatRelativeTime(undefined, 1_000_000), "");
  assert.equal(formatRelativeTime(0, 1_000_000), "");
  assert.equal(formatRelativeTime(Number.NaN, 1_000_000), "");
});

test("formatRelativeTime: future timestamps clamp to 0s ago (no negative diff)", () => {
  // Clock skew between the dashboard and the orchestrator process could
  // make a turn's epoch appear slightly in the future. Render "0s ago"
  // rather than "-3s ago" so the row stays readable.
  assert.equal(formatRelativeTime(1_000_010, 1_000_000), "0s ago");
});

test("formatRelativeTime: 60/3600/86400 bucket boundaries", () => {
  const now = 1_000_000;
  // one second short of each threshold stays in the lower bucket…
  assert.equal(formatRelativeTime(now - 59, now), "59s ago");
  assert.equal(formatRelativeTime(now - 3599, now), "59m ago");
  assert.equal(formatRelativeTime(now - 86_399, now), "23h ago");
  // …and the threshold itself rolls into the next one.
  assert.equal(formatRelativeTime(now - 60, now), "1m ago");
  assert.equal(formatRelativeTime(now - 3600, now), "1h ago");
  assert.equal(formatRelativeTime(now - 86_400, now), "1d ago");
});
