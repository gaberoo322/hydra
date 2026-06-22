/**
 * test/ov-request.test.mts — the OpenViking Request Adapter's four error modes
 * + the three request shapes, exercised against a stubbed global `fetch`
 * (issue #954).
 *
 * The adapter is the one focused test surface for the OV request discipline:
 * before the seam, the timeout/error-classification/JSON-unwrap was untestable
 * except by hitting a live OpenViking or stubbing `fetch` per call site. Here we
 * stub `globalThis.fetch` once and assert the discriminated never-throw
 * `OvResult` for each mode.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

const {
  ovRequest,
  ovPostJson,
  ovPostForm,
  ovHealthGet,
  isOvFailure,
  isOvOk,
  ovBaseUrl,
} = await import("../src/knowledge-base/ov-request.ts");

const realFetch = globalThis.fetch;
const realErr = console.error;
const realLog = console.log;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realErr;
  console.log = realLog;
});

/** A minimal Response-like stub. */
function fakeResponse(opts: {
  ok: boolean;
  status?: number;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
}): any {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: opts.json ?? (async () => ({})),
    text: opts.text ?? (async () => ""),
  };
}

describe("ov-request: success unwrap", () => {
  test("ovPostJson returns {ok:true; data} with the parsed JSON body", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ ok: true, json: async () => ({ result: { resources: [1, 2] } }) })) as any;
    const r = await ovPostJson<any>("/api/v1/search/find", { query: "x" });
    assert.equal(isOvOk(r), true);
    assert.equal(r.ok && r.data.result.resources.length, 2);
  });

  test("ovHealthGet returns {ok:true} on a 2xx liveness GET, body ignored", async () => {
    let seenMethod = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      seenMethod = init.method;
      return fakeResponse({ ok: true });
    }) as any;
    const r = await ovHealthGet("/health");
    assert.equal(isOvOk(r), true);
    assert.equal(seenMethod, "GET");
  });
});

describe("ov-request: the four error modes", () => {
  test("ov-non-2xx — OV answered with !res.ok, body captured on the failure arm", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ ok: false, status: 409, text: async () => "file exists" })) as any;
    const r = await ovPostJson("/api/v1/resources", {});
    assert.equal(isOvFailure(r), true);
    assert.equal(r.ok === false && r.code, "ov-non-2xx");
    assert.equal(r.ok === false && r.body, "file exists");
  });

  test("ov-malformed-json — a 2xx body that fails JSON.parse", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })) as any;
    const r = await ovPostJson("/api/v1/search/find", {});
    assert.equal(r.ok === false && r.code, "ov-malformed-json");
  });

  test("ov-timeout — the AbortSignal fired (TimeoutError)", async () => {
    globalThis.fetch = (async () => {
      const err: any = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as any;
    const r = await ovPostJson("/api/v1/search/find", {}, { timeout: 1 });
    assert.equal(r.ok === false && r.code, "ov-timeout");
  });

  test("ov-service-down — transport failure (ECONNREFUSED-class throw)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const r = await ovPostJson("/api/v1/search/find", {});
    assert.equal(r.ok === false && r.code, "ov-service-down");
  });
});

describe("ov-request: expectNon2xx log level (issue #2365)", () => {
  test("an UNexpected non-2xx logs the alarming ov-non-2xx line at error level", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ ok: false, status: 500, text: async () => "Skill data cannot be None" })) as any;
    const errLines: string[] = [];
    const logLines: string[] = [];
    console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(" ")); };

    const r = await ovPostJson("/api/v1/skills", { data: null });

    // Result shape is unchanged — still the ov-non-2xx failure arm with body.
    assert.equal(r.ok === false && r.code, "ov-non-2xx");
    assert.equal(r.ok === false && r.body, "Skill data cannot be None");
    // The default (no flag) caller keeps fail-loud: the error log fires.
    assert.equal(
      errLines.filter((l) => l.includes("ov-non-2xx: 500")).length,
      1,
      "an unexpected non-2xx must stay a console.error (fail-loud preserved)",
    );
    assert.equal(
      logLines.filter((l) => l.includes("expected non-2xx")).length,
      0,
      "the info-level line must NOT fire without the expectNon2xx flag",
    );
  });

  test("an EXPECTED non-2xx logs at info level, not error — same result returned", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ ok: false, status: 500, text: async () => "Skill data cannot be None" })) as any;
    const errLines: string[] = [];
    const logLines: string[] = [];
    console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(" ")); };

    const r = await ovRequest(
      "/api/v1/skills",
      { method: "POST", body: JSON.stringify({ data: null }) },
      { expectNon2xx: true },
    );

    // Classification is IDENTICAL — the flag only changes the log level.
    assert.equal(r.ok === false && r.code, "ov-non-2xx");
    assert.equal(r.ok === false && r.body, "Skill data cannot be None");
    // The deliberate liveness reject is logged at info level, NOT as an error.
    assert.equal(
      errLines.filter((l) => l.includes("ov-non-2xx")).length,
      0,
      "an expected non-2xx must NOT fire the alarming console.error",
    );
    const infoLines = logLines.filter((l) => l.includes("expected non-2xx (liveness probe)"));
    assert.equal(infoLines.length, 1, "the expected non-2xx is logged once at info level");
    assert.ok(infoLines[0].includes("500"), "the info line keeps the status + body context for debugging");
  });
});

describe("ov-request: request shapes + URL resolution", () => {
  test("ovPostJson serializes the body and sets the JSON Content-Type", async () => {
    let seenBody = "";
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: any) => {
      seenBody = init.body;
      seenHeaders = init.headers;
      return fakeResponse({ ok: true, json: async () => ({}) });
    }) as any;
    await ovPostJson("/api/v1/search/find", { query: "hi" });
    assert.equal(seenBody, JSON.stringify({ query: "hi" }));
    assert.equal(seenHeaders["Content-Type"], "application/json");
  });

  test("ovPostForm passes the FormData body and DROPS the JSON Content-Type", async () => {
    let seenHeaders: Record<string, string> = {};
    let seenBody: any = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      seenHeaders = init.headers;
      seenBody = init.body;
      return fakeResponse({ ok: true, json: async () => ({}) });
    }) as any;
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.md");
    await ovPostForm("/api/v1/resources/temp_upload", form);
    assert.ok(seenBody instanceof FormData, "body should be the FormData");
    assert.equal(
      seenHeaders["Content-Type"],
      undefined,
      "Content-Type must be dropped so fetch sets the multipart boundary",
    );
    assert.ok(seenHeaders["X-Api-Key"], "auth header must be preserved");
  });

  test("the request URL is joined from ovBaseUrl() + path (no hardcoded host)", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return fakeResponse({ ok: true, json: async () => ({}) });
    }) as any;
    await ovRequest("/api/v1/search/find", { method: "POST", body: "{}" });
    assert.equal(seenUrl, `${ovBaseUrl()}/api/v1/search/find`);
  });
});
