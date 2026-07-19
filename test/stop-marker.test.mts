/**
 * Unit tests for the deliberate-stop marker leaf (issue #3500).
 *
 * Before this extraction, the deliberate-stop marker contract (the 24h TTL, the
 * `{ reason, stoppedAt }` payload shape, and the serialize/parse of that
 * payload) was inlined across `HeartbeatController.stop()` and
 * `.loadSchedulerState()`. Asserting "a deliberate stop serializes THIS payload
 * shape" or "a malformed marker rehydrates to no-marker" required constructing a
 * full controller with its rolling-rate deps, timer stubs, and counter-rehydration
 * stubs — none relevant to the marker contract.
 *
 * These tests exercise the leaf's pure surface directly — no Redis, no timer, no
 * controller constructor:
 *   - the TTL constant is 24h,
 *   - serialize produces the canonical `{ reason, stoppedAt }` JSON,
 *   - serialize + parse round-trip,
 *   - parse is fail-safe: null / non-JSON / missing-field / mistyped-field all
 *     return null rather than throwing (matching the rehydrate contract).
 *
 * The Redis wrappers (readDeliberateStop / writeDeliberateStop /
 * clearDeliberateStop) are thin pass-throughs to the unmodified
 * redis/scheduler.ts accessors and are covered end-to-end by the
 * Redis-backed scheduler-deliberate-stop.test.mts suite; they are intentionally
 * not re-exercised here (this suite stays Redis-free).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  DELIBERATE_STOP_TTL_SECONDS,
  serializeDeliberateStopMarker,
  parseDeliberateStopMarker,
} = await import("../src/scheduler/stop-marker.ts");

describe("stop-marker leaf — TTL constant (issue #388 / #3500)", () => {
  test("DELIBERATE_STOP_TTL_SECONDS is 24h in seconds", () => {
    assert.equal(DELIBERATE_STOP_TTL_SECONDS, 24 * 60 * 60);
    assert.equal(DELIBERATE_STOP_TTL_SECONDS, 86_400);
  });
});

describe("stop-marker leaf — serialize (issue #3500)", () => {
  test("serializes the canonical { reason, stoppedAt } JSON shape", () => {
    const raw = serializeDeliberateStopMarker("deliberate", "2026-07-19T10:00:00.000Z");
    assert.equal(raw, '{"reason":"deliberate","stoppedAt":"2026-07-19T10:00:00.000Z"}');
  });

  test("serialize output parses back to the same fields (round-trip)", () => {
    const raw = serializeDeliberateStopMarker("deliberate", "2026-07-19T10:00:00.000Z");
    const parsed = parseDeliberateStopMarker(raw);
    assert.deepEqual(parsed, {
      reason: "deliberate",
      stoppedAt: "2026-07-19T10:00:00.000Z",
    });
  });
});

describe("stop-marker leaf — parse (issue #3500)", () => {
  test("parses a well-formed marker into { reason, stoppedAt }", () => {
    const parsed = parseDeliberateStopMarker(
      '{"reason":"deliberate","stoppedAt":"2026-05-14T10:00:00.000Z"}',
    );
    assert.deepEqual(parsed, {
      reason: "deliberate",
      stoppedAt: "2026-05-14T10:00:00.000Z",
    });
  });

  test("returns null for a null / absent marker", () => {
    assert.equal(parseDeliberateStopMarker(null), null);
  });

  test("returns null for an empty string", () => {
    assert.equal(parseDeliberateStopMarker(""), null);
  });

  test("returns null (does NOT throw) for non-JSON input", () => {
    assert.equal(parseDeliberateStopMarker("not-json{"), null);
  });

  test("returns null when reason is missing", () => {
    assert.equal(
      parseDeliberateStopMarker('{"stoppedAt":"2026-05-14T10:00:00.000Z"}'),
      null,
    );
  });

  test("returns null when stoppedAt is missing", () => {
    assert.equal(parseDeliberateStopMarker('{"reason":"deliberate"}'), null);
  });

  test("returns null when a field is present but mistyped", () => {
    assert.equal(
      parseDeliberateStopMarker('{"reason":123,"stoppedAt":"2026-05-14T10:00:00.000Z"}'),
      null,
    );
    assert.equal(
      parseDeliberateStopMarker('{"reason":"deliberate","stoppedAt":456}'),
      null,
    );
  });

  test("returns null when the JSON is a bare non-object (array / number)", () => {
    assert.equal(parseDeliberateStopMarker("[]"), null);
    assert.equal(parseDeliberateStopMarker("42"), null);
    assert.equal(parseDeliberateStopMarker("null"), null);
  });
});
