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
  isOvServerTimeout,
  isOvPointLockConflict,
  ovBaseUrl,
} = await import("../src/knowledge-base/ov-request.ts");

/**
 * OV's own SERVER-SIDE timeout 500 body (issue #2250) — the structurally-`ov-non-2xx`
 * envelope `isOvServerTimeout` classifies on the failure arm's `body`.
 */
const OV_SERVER_TIMEOUT_BODY =
  '{"status":"error","result":null,"error":{"code":"INTERNAL","message":"Request timed out.","details":null}}';

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
  // ADR-0027: ov-request now logs through the pino structured-logger seam
  // (module singleton → process.stderr) instead of freeform console.* strings.
  // Capture the serialized JSON lines and assert on the structured `level`
  // field (pino: info=30, error=50) + the stable event message + fields —
  // rather than grepping prose. This preserves the #2365 invariant: an
  // UNexpected non-2xx stays fail-loud (level 50), an EXPECTED liveness-probe
  // non-2xx is demoted to info (level 30).
  function captureStderr(): { lines: () => Record<string, any>[]; restore: () => void } {
    const originalWrite = process.stderr.write.bind(process.stderr);
    let buf = "";
    (process.stderr as any).write = (chunk: any) => {
      buf += String(chunk);
      return true;
    };
    return {
      lines: () =>
        buf
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, any>),
      restore: () => {
        (process.stderr as any).write = originalWrite;
      },
    };
  }

  test("an UNexpected non-2xx logs the alarming ov-non-2xx line at error level", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ ok: false, status: 500, text: async () => "Skill data cannot be None" })) as any;
    const cap = captureStderr();
    let r: any;
    try {
      r = await ovPostJson("/api/v1/skills", { data: null });
    } finally {
      cap.restore();
    }

    // Result shape is unchanged — still the ov-non-2xx failure arm with body.
    assert.equal(r.ok === false && r.code, "ov-non-2xx");
    assert.equal(r.ok === false && r.body, "Skill data cannot be None");
    // The default (no flag) caller keeps fail-loud: an error-level line fires.
    const errLines = cap.lines().filter((o) => o.level === 50 && o.msg === "[ov-request] ov-non-2xx");
    assert.equal(errLines.length, 1, "an unexpected non-2xx must stay an error-level log (fail-loud preserved)");
    assert.equal(errLines[0].status, 500, "the error line carries the status as a structured field");
    // The info-level "expected non-2xx" line must NOT fire without the flag.
    assert.equal(
      cap.lines().filter((o) => o.msg === "[ov-request] expected non-2xx (liveness probe)").length,
      0,
      "the info-level line must NOT fire without the expectNon2xx flag",
    );
  });

  test("an EXPECTED non-2xx logs at info level, not error — same result returned", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ ok: false, status: 500, text: async () => "Skill data cannot be None" })) as any;
    const cap = captureStderr();
    let r: any;
    try {
      r = await ovRequest(
        "/api/v1/skills",
        { method: "POST", body: JSON.stringify({ data: null }) },
        { expectNon2xx: true },
      );
    } finally {
      cap.restore();
    }

    // Classification is IDENTICAL — the flag only changes the log level.
    assert.equal(r.ok === false && r.code, "ov-non-2xx");
    assert.equal(r.ok === false && r.body, "Skill data cannot be None");
    // The deliberate liveness reject is logged at info level, NOT as an error.
    assert.equal(
      cap.lines().filter((o) => o.level === 50 && o.msg === "[ov-request] ov-non-2xx").length,
      0,
      "an expected non-2xx must NOT fire the alarming error-level log",
    );
    const infoLines = cap
      .lines()
      .filter((o) => o.level === 30 && o.msg === "[ov-request] expected non-2xx (liveness probe)");
    assert.equal(infoLines.length, 1, "the expected non-2xx is logged once at info level");
    assert.equal(infoLines[0].status, 500, "the info line keeps the status context as a structured field");
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

describe("isOvServerTimeout: body classifier (#2250, moved here in #2373)", () => {
  test("classifies OV's INTERNAL/'Request timed out.' 500 body as a server timeout", () => {
    assert.equal(isOvServerTimeout(OV_SERVER_TIMEOUT_BODY), true);
  });

  test("accepts the 'timed out' message variant too", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INTERNAL","message":"The request timed out after 47s"}}'),
      true,
    );
  });

  test("does NOT classify a genuine 4xx payload rejection as a timeout", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INVALID_ARGUMENT","message":"missing field: content"}}'),
      false,
    );
  });

  test("does NOT classify an UNAUTHENTICATED rejection as a timeout", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"UNAUTHENTICATED","message":"missing X-Api-Key"}}'),
      false,
    );
  });

  test("does NOT classify an INTERNAL error that is not a timeout", () => {
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INTERNAL","message":"index corruption detected"}}'),
      false,
    );
  });

  test("a non-timeout body that merely contains the word 'timeout' in prose is not retried", () => {
    // Parses cleanly but error.code !== INTERNAL → must NOT fall through to a
    // substring scan and false-positive on the prose mention.
    assert.equal(
      isOvServerTimeout('{"error":{"code":"INVALID_ARGUMENT","message":"timeout field must be a number"}}'),
      false,
    );
  });

  test("empty / null / undefined body is not a timeout (pure, total, never throws)", () => {
    assert.equal(isOvServerTimeout(""), false);
    assert.equal(isOvServerTimeout(null), false);
    assert.equal(isOvServerTimeout(undefined), false);
  });

  test("a malformed / truncated body falls back to a substring scan requiring BOTH markers", () => {
    // Non-JSON garbage that still carries both the INTERNAL marker and a timeout
    // phrase → retryable; garbage with only one marker → not.
    assert.equal(isOvServerTimeout("502 Bad Gateway INTERNAL: request timed out"), true);
    assert.equal(isOvServerTimeout("502 Bad Gateway: upstream unavailable"), false);
    assert.equal(isOvServerTimeout("connection timed out"), false); // no INTERNAL marker
  });
});

describe("isOvPointLockConflict: body classifier (#2658)", () => {
  /** OV's own point-lock 500 body under concurrent-indexing contention. */
  const OV_POINT_LOCK_BODY =
    '{"status":"error","result":null,"error":{"code":"INTERNAL","message":"Failed to acquire point lock for [\'/local/hydra/resources/hydra-memory\']"}}';

  test("classifies OV's INTERNAL/'Failed to acquire point lock' 500 body as contention", () => {
    assert.equal(isOvPointLockConflict(OV_POINT_LOCK_BODY), true);
  });

  test("accepts a 'point lock' message variant (spacing tolerated)", () => {
    assert.equal(
      isOvPointLockConflict('{"error":{"code":"INTERNAL","message":"could not obtain pointlock on collection"}}'),
      true,
    );
  });

  test("does NOT classify a genuine 4xx payload rejection as a point-lock conflict", () => {
    assert.equal(
      isOvPointLockConflict('{"error":{"code":"INVALID_ARGUMENT","message":"missing field: temp_path"}}'),
      false,
    );
  });

  test("does NOT classify an UNAUTHENTICATED rejection as a point-lock conflict", () => {
    assert.equal(
      isOvPointLockConflict('{"error":{"code":"UNAUTHENTICATED","message":"missing X-Api-Key"}}'),
      false,
    );
  });

  test("does NOT classify a non-lock INTERNAL error as a point-lock conflict", () => {
    assert.equal(
      isOvPointLockConflict('{"error":{"code":"INTERNAL","message":"index corruption detected"}}'),
      false,
    );
  });

  test("does NOT confuse a server-timeout body with a point-lock body (disjoint classifiers)", () => {
    // The two sibling classifiers must not overlap: a timeout is not a lock.
    assert.equal(isOvPointLockConflict(OV_SERVER_TIMEOUT_BODY), false);
    assert.equal(isOvServerTimeout(OV_POINT_LOCK_BODY), false);
  });

  test("a non-lock body that merely mentions 'point lock' in prose is not retried", () => {
    // Parses cleanly but error.code !== INTERNAL → must NOT fall through to a
    // substring scan and false-positive on the prose mention.
    assert.equal(
      isOvPointLockConflict('{"error":{"code":"INVALID_ARGUMENT","message":"point lock field must be a bool"}}'),
      false,
    );
  });

  test("empty / null / undefined body is not a conflict (pure, total, never throws)", () => {
    assert.equal(isOvPointLockConflict(""), false);
    assert.equal(isOvPointLockConflict(null), false);
    assert.equal(isOvPointLockConflict(undefined), false);
  });

  test("a malformed / truncated body falls back to a substring scan requiring BOTH markers", () => {
    assert.equal(isOvPointLockConflict("500 INTERNAL Failed to acquire point lock"), true);
    assert.equal(isOvPointLockConflict("500 Bad Gateway: upstream unavailable"), false);
    assert.equal(isOvPointLockConflict("point lock unavailable"), false); // no INTERNAL marker
  });
});
