import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTraceUrl, isOtelEnabled } from "../src/api/observability.ts";

test("isOtelEnabled honors HYDRA_OTEL_ENABLED env var", () => {
  const original = process.env.HYDRA_OTEL_ENABLED;
  try {
    delete process.env.HYDRA_OTEL_ENABLED;
    assert.equal(isOtelEnabled(), false);

    process.env.HYDRA_OTEL_ENABLED = "false";
    assert.equal(isOtelEnabled(), false);

    process.env.HYDRA_OTEL_ENABLED = "true";
    assert.equal(isOtelEnabled(), true);

    process.env.HYDRA_OTEL_ENABLED = "1";
    assert.equal(isOtelEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.HYDRA_OTEL_ENABLED;
    else process.env.HYDRA_OTEL_ENABLED = original;
  }
});

test("buildTraceUrl returns null when template is unset", () => {
  const original = process.env.HYDRA_TRACE_UI_URL;
  try {
    delete process.env.HYDRA_TRACE_UI_URL;
    assert.equal(buildTraceUrl("cycle-abc"), null);
    assert.equal(buildTraceUrl("cycle-abc", ""), null);
    assert.equal(buildTraceUrl("cycle-abc", "   "), null);
  } finally {
    if (original === undefined) delete process.env.HYDRA_TRACE_UI_URL;
    else process.env.HYDRA_TRACE_UI_URL = original;
  }
});

test("buildTraceUrl returns null when cycleId is missing", () => {
  assert.equal(buildTraceUrl(null, "http://example/{cycleId}"), null);
  assert.equal(buildTraceUrl(undefined, "http://example/{cycleId}"), null);
  assert.equal(buildTraceUrl("", "http://example/{cycleId}"), null);
  assert.equal(buildTraceUrl("   ", "http://example/{cycleId}"), null);
});

test("buildTraceUrl substitutes {cycleId} placeholder with URL-encoded value", () => {
  assert.equal(
    buildTraceUrl("cycle-abc-123", "http://example/d/dash?var-cycle_id={cycleId}"),
    "http://example/d/dash?var-cycle_id=cycle-abc-123",
  );
  assert.equal(
    buildTraceUrl("weird id/with slash", "http://example/{cycleId}"),
    "http://example/weird%20id%2Fwith%20slash",
  );
});

test("buildTraceUrl substitutes every occurrence of the placeholder", () => {
  assert.equal(
    buildTraceUrl("c1", "http://example/{cycleId}/related/{cycleId}"),
    "http://example/c1/related/c1",
  );
});

test("buildTraceUrl appends hydra_cycle_id when no placeholder is present", () => {
  assert.equal(
    buildTraceUrl("cycle-x", "http://example/dashboards/hydra"),
    "http://example/dashboards/hydra?hydra_cycle_id=cycle-x",
  );
  assert.equal(
    buildTraceUrl("cycle-x", "http://example/dash?foo=bar"),
    "http://example/dash?foo=bar&hydra_cycle_id=cycle-x",
  );
});

test("buildTraceUrl reads HYDRA_TRACE_UI_URL when no explicit template", () => {
  const original = process.env.HYDRA_TRACE_UI_URL;
  try {
    process.env.HYDRA_TRACE_UI_URL = "http://example/d/x?var-cycle_id={cycleId}";
    assert.equal(
      buildTraceUrl("cycle-q"),
      "http://example/d/x?var-cycle_id=cycle-q",
    );
  } finally {
    if (original === undefined) delete process.env.HYDRA_TRACE_UI_URL;
    else process.env.HYDRA_TRACE_UI_URL = original;
  }
});
