/**
 * Regression tests for indexWorkItem (src/redis/work-queue.ts).
 *
 * Bug (issue #313): the OpenViking /api/v1/resources/temp_upload endpoint
 * returns a wrapped envelope of the form
 *   {"status":"ok","result":{"temp_path":"..."}, "error":null, "telemetry":null}
 * but indexWorkItem read `uploadData.temp_path` (unwrapped) and silently
 * bailed on every call — 354 occurrences over 2 days in production. The
 * fix unwraps `result.temp_path` and logs the full body if the field is
 * still missing so future API shifts are debuggable.
 *
 * These tests stub global fetch and assert:
 *   1) wrapped response → add-resource is fired with the temp_path
 *   2) legacy unwrapped response → still parses (back-compat)
 *   3) malformed response → logs include the body envelope (loud failure)
 *   4) non-2xx upload → logs status + body (loud failure)
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { indexWorkItem } from "../src/redis/work-queue.ts";

type FetchCall = { url: string; init: any };

function installFetchStub(
  handler: (url: string, init: any) => { ok: boolean; status?: number; body: any },
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = handler(u, init);
    const body = r.body;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as any;
  }) as any;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function captureConsole(): { errors: string[]; logs: string[]; restore: () => void } {
  const errors: string[] = [];
  const logs: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    errors,
    logs,
    restore: () => {
      console.error = origErr;
      console.log = origLog;
    },
  };
}

describe("indexWorkItem temp_path parsing (issue #313)", () => {
  test("wrapped {status,result:{temp_path}} response → add-resource fires with temp_path", async () => {
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/v1/resources/temp_upload")) {
        return {
          ok: true,
          body: {
            status: "ok",
            result: { temp_path: "/app/workspace/temp/upload/upload_abc.md" },
            error: null,
            telemetry: null,
          },
        };
      }
      // add-resource
      return { ok: true, body: { status: "ok", result: { status: "success" } } };
    });
    const cap = captureConsole();
    try {
      await indexWorkItem("Add stream freshness scoring", "queue");
    } finally {
      stub.restore();
      cap.restore();
    }
    assert.equal(stub.calls.length, 2, "expected upload + add-resource");
    assert.ok(stub.calls[0].url.endsWith("/api/v1/resources/temp_upload"));
    assert.ok(stub.calls[1].url.endsWith("/api/v1/resources"));
    const addBody = JSON.parse(stub.calls[1].init.body);
    assert.equal(addBody.temp_path, "/app/workspace/temp/upload/upload_abc.md");
    assert.deepEqual(addBody.tags, ["hydra-work-item"]);
    assert.ok(
      cap.logs.some((l) => l.includes("[WorkQueue] Indexed work item into OV")),
      `expected success log; got logs=${JSON.stringify(cap.logs)}`,
    );
    assert.equal(
      cap.errors.length,
      0,
      `expected no errors on success path; got: ${cap.errors.join(" | ")}`,
    );
  });

  test("legacy unwrapped {temp_path} response → still parses (back-compat)", async () => {
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/v1/resources/temp_upload")) {
        return { ok: true, body: { temp_path: "/tmp/legacy-path.md" } };
      }
      return { ok: true, body: {} };
    });
    const cap = captureConsole();
    try {
      await indexWorkItem("Legacy shape compatibility", "queue");
    } finally {
      stub.restore();
      cap.restore();
    }
    assert.equal(stub.calls.length, 2);
    const addBody = JSON.parse(stub.calls[1].init.body);
    assert.equal(addBody.temp_path, "/tmp/legacy-path.md");
  });

  test("malformed response (no temp_path anywhere) → logs body envelope loudly", async () => {
    const stub = installFetchStub(() => ({
      ok: true,
      body: { status: "ok", result: { unexpected_field: "value" } },
    }));
    const cap = captureConsole();
    try {
      await indexWorkItem("Malformed response", "queue");
    } finally {
      stub.restore();
      cap.restore();
    }
    // Only the upload call should have fired; add-resource is skipped.
    assert.equal(stub.calls.length, 1);
    assert.equal(cap.errors.length, 1, `expected one error log; got ${JSON.stringify(cap.errors)}`);
    const msg = cap.errors[0];
    assert.ok(
      msg.includes("[WorkQueue] indexWorkItem: no temp_path in upload response"),
      `expected loud-failure prefix in: ${msg}`,
    );
    assert.ok(
      msg.includes("unexpected_field"),
      `expected response body included in error log for debuggability: ${msg}`,
    );
  });

  test("non-2xx upload → logs status + body", async () => {
    const stub = installFetchStub(() => ({
      ok: false,
      status: 503,
      body: "service overloaded",
    }));
    const cap = captureConsole();
    try {
      await indexWorkItem("Upload 503", "queue");
    } finally {
      stub.restore();
      cap.restore();
    }
    assert.equal(stub.calls.length, 1, "should not call add-resource on upload failure");
    assert.equal(cap.errors.length, 1);
    const msg = cap.errors[0];
    assert.ok(msg.includes("503"), `expected status in error: ${msg}`);
    assert.ok(msg.includes("service overloaded"), `expected body in error: ${msg}`);
  });

  test("add-resource failure → logs status + body", async () => {
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/v1/resources/temp_upload")) {
        return {
          ok: true,
          body: { status: "ok", result: { temp_path: "/tmp/x.md" }, error: null },
        };
      }
      return { ok: false, status: 409, body: "conflict: resource exists" };
    });
    const cap = captureConsole();
    try {
      await indexWorkItem("Add fails 409", "queue");
    } finally {
      stub.restore();
      cap.restore();
    }
    assert.equal(stub.calls.length, 2);
    assert.equal(cap.errors.length, 1);
    const msg = cap.errors[0];
    assert.ok(msg.includes("add-resource failed"));
    assert.ok(msg.includes("409"));
    assert.ok(msg.includes("conflict"));
  });
});
