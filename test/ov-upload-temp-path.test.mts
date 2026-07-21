/**
 * Regression tests for indexText (src/learning/ov-upload.ts).
 *
 * Bug (issue #318): same envelope mismatch as #313 / PR #317. The
 * OpenViking /api/v1/resources/temp_upload endpoint returns a wrapped
 * envelope of the form
 *   {"status":"ok","result":{"temp_path":"..."}, "error":null, "telemetry":null}
 * but indexText read `uploadData.temp_path` (unwrapped) and silently
 * bailed on every call — OV memory uploads (reality reports, memory
 * patterns) were silently failing. The fix unwraps `result.temp_path`
 * and logs the full body if the field is still missing so future API
 * shifts are debuggable.
 *
 * These tests stub global fetch and assert:
 *   1) wrapped response → add-resource is fired with the temp_path
 *   2) legacy unwrapped response → still parses (back-compat)
 *   3) malformed response → logs include the body envelope (loud failure)
 *   4) non-2xx upload → logs status + body (loud failure)
 *   5) add-resource failure → logs status + body
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { indexText } from "../src/knowledge-base/indexer.ts";

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

/**
 * ADR-0027: indexText + the ov-request adapter now log through the pino
 * structured-logger seam (module singleton → process.stderr) instead of freeform
 * console.* strings. Capture the serialized JSON lines and bucket them by pino
 * level (error=50, warn=40, info=30). Each bucket keeps the RAW serialized JSON
 * line as its string — the migration carries the same tokens the old prose did
 * (`503`, `service overloaded`, `ov-non-2xx`, `Failed to add text`, the response
 * envelope), just as structured fields + the stable `msg`, so the existing
 * substring assertions keep holding against the JSON text. The arrays are
 * populated at restore() time (pino buffers to stderr synchronously).
 */
function captureConsole(): { errors: string[]; logs: string[]; restore: () => void } {
  const errors: string[] = [];
  const logs: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  return {
    errors,
    logs,
    restore: () => {
      (process.stderr as any).write = originalWrite;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let obj: Record<string, any>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        // Bucket error+warn (>= 40) as "errors", info (30) as "logs" — mirroring
        // the old console.error / console.log split the assertions rely on.
        if (typeof obj.level === "number" && obj.level >= 40) errors.push(line);
        else logs.push(line);
      }
    },
  };
}

describe("indexText temp_path parsing (issue #318)", () => {
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
      await indexText("reality-report-xyz", "# Reality report\n\nbody");
    } finally {
      stub.restore();
      cap.restore();
    }
    assert.equal(stub.calls.length, 2, "expected upload + add-resource");
    assert.ok(stub.calls[0].url.endsWith("/api/v1/resources/temp_upload"));
    assert.ok(stub.calls[1].url.endsWith("/api/v1/resources"));
    const addBody = JSON.parse(stub.calls[1].init.body);
    assert.equal(addBody.temp_path, "/app/workspace/temp/upload/upload_abc.md");
    assert.ok(
      typeof addBody.to === "string" && addBody.to.startsWith("viking://resources/hydra-memory/"),
      `expected hydra-memory destination, got ${addBody.to}`,
    );
    assert.ok(
      cap.logs.some((l) => l.includes("[Learning:Indexer] Indexed text")),
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
      await indexText("legacy-shape", "legacy body");
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
      await indexText("malformed-resp", "body");
    } finally {
      stub.restore();
      cap.restore();
    }
    // Only the upload call should have fired; add-resource is skipped.
    assert.equal(stub.calls.length, 1);
    assert.equal(
      cap.errors.length,
      1,
      `expected one error log; got ${JSON.stringify(cap.errors)}`,
    );
    const msg = cap.errors[0];
    assert.ok(
      msg.includes("no temp_path in upload response"),
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
      await indexText("upload-503", "body");
    } finally {
      stub.restore();
      cap.restore();
    }
    assert.equal(stub.calls.length, 1, "should not call add-resource on upload failure");
    // Issue #954: the OpenViking Request Adapter now owns the transport boundary
    // and logs the non-2xx (status + body) itself; the caller logs the
    // discriminated code + body. The failure is still loud and debuggable — the
    // status, the body, and the ov-non-2xx code all reach the logs — but it's
    // spread across the adapter log and the caller log rather than one line.
    const all = cap.errors.join(" | ");
    assert.ok(all.includes("503"), `expected status in adapter error: ${all}`);
    assert.ok(all.includes("service overloaded"), `expected body in error: ${all}`);
    assert.ok(all.includes("ov-non-2xx"), `expected ov code in error: ${all}`);
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
      await indexText("add-fails-409", "body");
    } finally {
      stub.restore();
      cap.restore();
    }
    assert.equal(stub.calls.length, 2);
    // Issue #954: as above — the adapter logs the non-2xx (status + body) and
    // the caller logs the "Failed to add text" prefix with the code + body. The
    // status, body, and caller prefix all still reach the logs.
    const all = cap.errors.join(" | ");
    assert.ok(all.includes("Failed to add text"), `expected add-failure prefix: ${all}`);
    assert.ok(all.includes("409"), `expected status in adapter error: ${all}`);
    assert.ok(all.includes("conflict"), `expected body in error: ${all}`);
  });
});
