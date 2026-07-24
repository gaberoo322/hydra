/**
 * test/page-item-format.test.mts — pins the shared dashboard page-item seam's
 * pure half (issue #822). Before this seam, the four list-page components each
 * carried their own divergent time formatter and palette dict; the only way to
 * assert their behaviour was a full component render, which the dashboard has
 * no runner for. Lifting the logic into dashboard/src/lib/page-item-format.ts
 * makes shape extraction, time formatting, and palette mapping unit-testable
 * in isolation — these tests are the realization of the issue's "Tests"
 * benefit and the guard for its behaviour-preservation invariants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZINC_DEFAULT,
  TIER_PALETTE,
  SOURCE_PALETTE,
  SEVERITY_PALETTE,
  DECISION_SOURCE_PALETTE,
  DECISION_SOURCE_LABEL,
  paletteClass,
  formatAge,
  relativeAge,
  formatClock,
  formatTimeOfDay,
  EMPTY_TIMESTAMP,
  toEpochMs,
  formatDateTime,
  formatDateTimeFull,
  localTimestampParts,
} from "../dashboard/src/lib/page-item-format.ts";

// A fixed "now" so the age formatters are deterministic.
const NOW = Date.parse("2026-06-01T12:00:00.000Z");

test("formatAge: seconds floor under a minute", () => {
  assert.equal(formatAge(new Date(NOW - 5_000).toISOString(), NOW), "5s");
  assert.equal(formatAge(new Date(NOW - 59_000).toISOString(), NOW), "59s");
});

test("formatAge: minutes (rounded) under an hour", () => {
  assert.equal(formatAge(new Date(NOW - 60_000).toISOString(), NOW), "1m");
  // 90s -> 1.5m rounds to 2m (matches Math.round in the original component).
  assert.equal(formatAge(new Date(NOW - 90_000).toISOString(), NOW), "2m");
});

test("formatAge: hours + minutes at and above an hour", () => {
  // 1h05m
  assert.equal(formatAge(new Date(NOW - (3600 + 300) * 1000).toISOString(), NOW), "1h 5m");
  // exactly 2h
  assert.equal(formatAge(new Date(NOW - 7200 * 1000).toISOString(), NOW), "2h 0m");
});

test("formatAge: missing / unparseable -> empty string, never throws", () => {
  assert.equal(formatAge(null, NOW), "");
  assert.equal(formatAge(undefined, NOW), "");
  assert.equal(formatAge("not-a-date", NOW), "");
});

test("formatAge: future timestamp clamps to 0s (Math.max guard)", () => {
  assert.equal(formatAge(new Date(NOW + 10_000).toISOString(), NOW), "0s");
});

test("relativeAge: minutes / hours / days buckets", () => {
  assert.equal(relativeAge(new Date(NOW - 30 * 60_000).toISOString(), NOW), "30m");
  assert.equal(relativeAge(new Date(NOW - 3 * 3600_000).toISOString(), NOW), "3h");
  // >= 48h crosses into days
  assert.equal(relativeAge(new Date(NOW - 72 * 3600_000).toISOString(), NOW), "3d");
});

test("relativeAge: 47h stays in hours, 48h flips to days (boundary)", () => {
  assert.equal(relativeAge(new Date(NOW - 47 * 3600_000).toISOString(), NOW), "47h");
  assert.equal(relativeAge(new Date(NOW - 48 * 3600_000).toISOString(), NOW), "2d");
});

test("relativeAge: missing / future -> empty string", () => {
  assert.equal(relativeAge(null, NOW), "");
  assert.equal(relativeAge(new Date(NOW + 60_000).toISOString(), NOW), "");
});

test("formatClock: guards epoch-zero and NaN dates", () => {
  assert.equal(formatClock(null), "");
  assert.equal(formatClock(""), "");
  assert.equal(formatClock("garbage"), "");
  assert.equal(formatClock(new Date(0).toISOString()), "");
});

test("formatClock: renders a HH:MM-shaped string for a real date", () => {
  const out = formatClock("2026-06-01T09:07:00.000Z");
  // Locale-dependent, but must be non-empty and contain the minute separator.
  assert.ok(out.length > 0);
  assert.ok(out.includes(":"));
});

test("formatTimeOfDay: missing / malformed -> empty, never throws", () => {
  assert.equal(formatTimeOfDay(null), "");
  assert.equal(formatTimeOfDay(undefined), "");
  // new Date(NaN-source) still yields an Invalid Date string from toLocaleTimeString
  // in some engines; the contract is only "never throws". Assert no throw:
  assert.doesNotThrow(() => formatTimeOfDay("not-a-real-timestamp"));
});

test("formatTimeOfDay: renders a non-empty string for a valid timestamp", () => {
  assert.ok(formatTimeOfDay("2026-06-01T09:07:00.000Z").length > 0);
});

test("paletteClass: known keys resolve to their palette class", () => {
  assert.equal(paletteClass(TIER_PALETTE, 1), TIER_PALETTE[1]);
  assert.equal(paletteClass(SOURCE_PALETTE, "operator"), SOURCE_PALETTE.operator);
  assert.equal(paletteClass(SEVERITY_PALETTE, "critical"), SEVERITY_PALETTE.critical);
});

test("paletteClass: unknown / null / undefined keys fall through to fallback", () => {
  assert.equal(paletteClass(TIER_PALETTE, 99), ZINC_DEFAULT);
  assert.equal(paletteClass(TIER_PALETTE, null), ZINC_DEFAULT);
  assert.equal(paletteClass(TIER_PALETTE, undefined), ZINC_DEFAULT);
  assert.equal(paletteClass(SOURCE_PALETTE, "nope"), ZINC_DEFAULT);
});

test("paletteClass: custom fallback honoured (decision-queue used '' not zinc)", () => {
  assert.equal(paletteClass(DECISION_SOURCE_PALETTE, "unknown-source", ""), "");
  assert.equal(
    paletteClass(DECISION_SOURCE_PALETTE, "ready-for-human", ""),
    DECISION_SOURCE_PALETTE["ready-for-human"],
  );
});

test("TIER_PALETTE: legacy tier 0 maps to the deepest-tier red (invariant)", () => {
  // Pre-renumber merges carry tier 0 and must render the same red chip as T4.
  assert.equal(TIER_PALETTE[0], TIER_PALETTE[4]);
  assert.ok(TIER_PALETTE[0].includes("red"));
});

test("DECISION_SOURCE_LABEL: short labels preserved for the three known sources", () => {
  assert.equal(DECISION_SOURCE_LABEL["operator-decision-queue"], "queue");
  assert.equal(DECISION_SOURCE_LABEL["ready-for-human"], "human");
  assert.equal(DECISION_SOURCE_LABEL["needs-info"], "info");
});

// ---------------------------------------------------------------------------
// Browser-local date/time seam (issue #3562). These pin that the helpers
// convert a UTC instant into the *host's* timezone (not pass UTC through) and
// accept both shapes the API sends: ISO-8601-UTC strings and epoch-seconds.
// ---------------------------------------------------------------------------

// A UTC instant far from any DST boundary so the expected local wall-clocks
// are stable across the two zones we assert.
const NOON_UTC_ISO = "2026-06-01T12:00:00.000Z";
const NOON_UTC_EPOCH_S = Math.floor(Date.parse(NOON_UTC_ISO) / 1000); // seconds

/**
 * Run `fn` with process.env.TZ pinned to `tz`, restoring the prior value
 * afterward. Node re-reads process.env.TZ per Intl call, so reassigning it
 * mid-process re-anchors toLocaleString's zone (verified: NY 08:00 vs Tokyo
 * 21:00 for the same 12:00Z instant).
 */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

test("toEpochMs: number is epoch-SECONDS, string is ISO — both land on the same ms", () => {
  const expectedMs = Date.parse(NOON_UTC_ISO);
  assert.equal(toEpochMs(NOON_UTC_EPOCH_S), expectedMs);
  assert.equal(toEpochMs(NOON_UTC_ISO), expectedMs);
});

test("toEpochMs: null / undefined / empty / unparseable / epoch-zero -> null", () => {
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs(undefined), null);
  assert.equal(toEpochMs(""), null);
  assert.equal(toEpochMs("not-a-date"), null);
  assert.equal(toEpochMs(new Date(0).toISOString()), null); // epoch-zero guard
  assert.equal(toEpochMs(0), null); // 0 seconds === epoch-zero, also guarded
});

test("formatDateTime: converts one instant to DIFFERENT local strings under two TZ values", () => {
  // The core acceptance criterion: same instant, two zones, two wall clocks —
  // proving the helper converts to local, never passes UTC through.
  const ny = withTZ("America/New_York", () => formatDateTime(NOON_UTC_ISO));
  const tokyo = withTZ("Asia/Tokyo", () => formatDateTime(NOON_UTC_ISO));
  assert.notEqual(ny, tokyo);
  // 12:00Z is 08:00 in New York (EDT, -4) and 21:00 in Tokyo (+9).
  assert.ok(ny.includes("08:00"), `expected NY 08:00, got "${ny}"`);
  assert.ok(tokyo.includes("09:00"), `expected Tokyo 09:00 PM, got "${tokyo}"`);
});

test("formatDateTime: epoch-seconds and ISO-string inputs render identically", () => {
  const fromIso = withTZ("America/New_York", () => formatDateTime(NOON_UTC_ISO));
  const fromEpoch = withTZ("America/New_York", () => formatDateTime(NOON_UTC_EPOCH_S));
  assert.equal(fromIso, fromEpoch);
});

test("formatDateTime: missing / invalid -> em-dash placeholder, never throws", () => {
  assert.equal(formatDateTime(null), EMPTY_TIMESTAMP);
  assert.equal(formatDateTime(undefined), EMPTY_TIMESTAMP);
  assert.equal(formatDateTime(""), EMPTY_TIMESTAMP);
  assert.equal(formatDateTime("garbage"), EMPTY_TIMESTAMP);
  assert.equal(formatDateTime(new Date(0).toISOString()), EMPTY_TIMESTAMP);
  assert.doesNotThrow(() => formatDateTime("not-a-real-timestamp"));
});

test("formatDateTimeFull: full tooltip form also converts to local (two TZ, two strings)", () => {
  const ny = withTZ("America/New_York", () => formatDateTimeFull(NOON_UTC_ISO));
  const tokyo = withTZ("Asia/Tokyo", () => formatDateTimeFull(NOON_UTC_ISO));
  assert.notEqual(ny, tokyo);
  assert.ok(ny.includes("2026"), "full form carries the year");
  assert.ok(ny.includes("08:00"), `expected NY 08:00 in tooltip, got "${ny}"`);
  assert.ok(tokyo.includes("09:00"), `expected Tokyo 09:00 PM in tooltip, got "${tokyo}"`);
});

test("formatDateTimeFull: absent input -> empty string (no tooltip), never throws", () => {
  // Empty (not em-dash) so an empty title attribute reads as "no tooltip".
  assert.equal(formatDateTimeFull(null), "");
  assert.equal(formatDateTimeFull(undefined), "");
  assert.equal(formatDateTimeFull("garbage"), "");
  assert.doesNotThrow(() => formatDateTimeFull("nope"));
});

test("localTimestampParts: bundles compact + title from the same instant", () => {
  const parts = withTZ("America/New_York", () => localTimestampParts(NOON_UTC_ISO));
  assert.equal(parts.compact, withTZ("America/New_York", () => formatDateTime(NOON_UTC_ISO)));
  assert.equal(parts.title, withTZ("America/New_York", () => formatDateTimeFull(NOON_UTC_ISO)));
  // The compact cell is a shorter form than its own disambiguating tooltip.
  assert.ok(parts.title.length > parts.compact.length);
});

test("localTimestampParts: absent input -> em-dash compact + empty title", () => {
  const parts = localTimestampParts(null);
  assert.equal(parts.compact, EMPTY_TIMESTAMP);
  assert.equal(parts.title, "");
});

test("formatClock / formatTimeOfDay pin the browser-local timezone (existing helpers)", () => {
  // Audit criterion: the pre-existing clock helpers already localise via
  // toLocaleTimeString — assert it rather than assume. Same instant, two
  // zones, two wall-clock strings.
  const clockNy = withTZ("America/New_York", () => formatClock(NOON_UTC_ISO));
  const clockTokyo = withTZ("Asia/Tokyo", () => formatClock(NOON_UTC_ISO));
  assert.notEqual(clockNy, clockTokyo);
  assert.ok(clockNy.includes("08:00"), `expected NY 08:00, got "${clockNy}"`);

  const todNy = withTZ("America/New_York", () => formatTimeOfDay(NOON_UTC_ISO));
  const todTokyo = withTZ("Asia/Tokyo", () => formatTimeOfDay(NOON_UTC_ISO));
  assert.notEqual(todNy, todTokyo);
});
