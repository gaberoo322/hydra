import { test } from "node:test";
import assert from "node:assert/strict";
/**
 * Observability surface (issue #207). `GET /observability/trace-url` and its
 * `buildTraceUrl` helper were retired under ADR-0024 §3 (issue #4638): zero
 * callers. What remains is `isOtelEnabled` and `GET /observability/config`.
 */
import { isOtelEnabled, createObservabilityRouter } from "../src/api/observability.ts";

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

test("GET /observability/config echoes the template and the {cycleId} placeholder", () => {
  const original = process.env.HYDRA_TRACE_UI_URL;
  try {
    process.env.HYDRA_TRACE_UI_URL = "http://example/d/x?var-cycle_id={cycleId}";
    const handler = findHandler(createObservabilityRouter(), "GET", "/observability/config")!;
    assert.ok(handler);
    const res = mockRes();
    handler(mockReq(), res);
    assert.equal(res._body.traceUrlTemplate, "http://example/d/x?var-cycle_id={cycleId}");
    assert.equal(res._body.placeholder, "{cycleId}");
  } finally {
    if (original === undefined) delete process.env.HYDRA_TRACE_UI_URL;
    else process.env.HYDRA_TRACE_UI_URL = original;
  }
});

test("GET /observability/trace-url is no longer registered (retired, #4638)", () => {
  assert.equal(findHandler(createObservabilityRouter(), "GET", "/observability/trace-url"), null);
});
