import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTraceUrl, isOtelEnabled, createObservabilityRouter } from "../src/api/observability.ts";

function mockReq(query: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// GET /observability/trace-url?cycleId=<id> — 400 route-level coverage
// (issue #4563: schemaValidationError() adoption at the missing-cycleId site).
// ---------------------------------------------------------------------------

test("GET /observability/trace-url 400s with schema-validation-failed when cycleId is missing", async () => {
  const router = createObservabilityRouter();
  const handler = findHandler(router, "GET", "/observability/trace-url")!;
  const req = mockReq({});
  const res = mockRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "Missing query parameter 'cycleId'");
  assert.equal(res._body.code, "schema-validation-failed");
  assert.ok(Array.isArray(res._body.issues) && res._body.issues.length > 0);
});
