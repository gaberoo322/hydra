/**
 * test/now-pixel-reaping-animation.test.mts — pins the status → icon map
 * and the 800ms reaping duration constant for the reaping-fade
 * animation introduced in issue #661 (follow-up to /now-pixel slice 6,
 * #648).
 *
 * The JSX rendering layer (ReapingFade.jsx, HabitatGrid.jsx, HabitatZone.jsx)
 * is exercised via the pure helpers in reaping-fade.ts so we can stay
 * inside node:test without pulling in a DOM/JSX runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REAPING_DURATION_MS,
  statusToIcon,
  normaliseReapStatus,
} from "../dashboard/src/pages/now-pixel/reaping-fade.ts";

// ---------------------------------------------------------------------------
// REAPING_DURATION_MS — pinned to the 800ms spec callout from slice 6 (#648)
// ---------------------------------------------------------------------------

test("REAPING_DURATION_MS is 800ms per the slice-6 spec", () => {
  assert.equal(REAPING_DURATION_MS, 800);
});

test("REAPING_DURATION_MS is a positive integer (no fractional ms)", () => {
  assert.equal(typeof REAPING_DURATION_MS, "number");
  assert.ok(REAPING_DURATION_MS > 0);
  assert.equal(Math.floor(REAPING_DURATION_MS), REAPING_DURATION_MS);
});

// ---------------------------------------------------------------------------
// statusToIcon — closed map: success → ✨ gold, failure → ✗ red, other → 💤
// ---------------------------------------------------------------------------

test("statusToIcon: success → ✨ in amber", () => {
  const icon = statusToIcon("success");
  assert.equal(icon.glyph, "✨");
  assert.equal(icon.color, "#fbbf24");
});

test("statusToIcon: failure → ✗ in red", () => {
  const icon = statusToIcon("failure");
  assert.equal(icon.glyph, "✗");
  assert.equal(icon.color, "#ef4444");
});

test("statusToIcon: no_op → 💤 neutral grey (catch-all)", () => {
  const icon = statusToIcon("no_op");
  assert.equal(icon.glyph, "💤");
  assert.equal(icon.color, "#9ca3af");
});

test("statusToIcon: budget_exceeded → 💤 neutral grey", () => {
  const icon = statusToIcon("budget_exceeded");
  assert.equal(icon.glyph, "💤");
});

test("statusToIcon: null/undefined → 💤 neutral grey (graceful default)", () => {
  assert.equal(statusToIcon(null).glyph, "💤");
  assert.equal(statusToIcon(undefined).glyph, "💤");
});

test("statusToIcon: unknown future status → 💤 (does not throw)", () => {
  // Future autopilot statuses must produce a fade, not a crash —
  // the dashboard ships behind the autopilot.
  const icon = statusToIcon("some-future-status-we-have-not-shipped");
  assert.equal(icon.glyph, "💤");
});

// ---------------------------------------------------------------------------
// normaliseReapStatus — coerce raw status string to closed enum
// ---------------------------------------------------------------------------

test("normaliseReapStatus: success / failure pass through", () => {
  assert.equal(normaliseReapStatus("success"), "success");
  assert.equal(normaliseReapStatus("failure"), "failure");
});

test("normaliseReapStatus: everything else collapses to 'other'", () => {
  assert.equal(normaliseReapStatus("no_op"), "other");
  assert.equal(normaliseReapStatus("budget_exceeded"), "other");
  assert.equal(normaliseReapStatus("unknown"), "other");
  assert.equal(normaliseReapStatus(null), "other");
  assert.equal(normaliseReapStatus(undefined), "other");
  assert.equal(normaliseReapStatus(""), "other");
});
