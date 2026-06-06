/**
 * test/oauth-usage.test.mts — the OAuth Usage Adapter's six failure modes, the
 * defensive parse, and the never-coerce-to-0 gate-safety invariant, exercised
 * against an injected `fetchImpl` + `readToken` (issue #1083).
 *
 * Mirrors test/ov-request.test.mts (the sibling fetch-based boundary Seam): the
 * adapter never throws, returns a discriminated `OAuthUsageResult`, and a
 * 200-with-garbage body is classified `oauth-usage-parse` (=> fall back to
 * estimate), NEVER read as 0% utilization.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  readOAuthUsage,
  parseOAuthUsageBody,
  isOAuthUsageFailure,
  isOAuthUsageOk,
  OAUTH_USAGE_URL,
  OAUTH_USAGE_BETA,
} = await import("../src/cost/oauth-usage.ts");

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

const tokenOk = async () => "test-access-token";

/** The real OAuth response shape captured 2026-06-06 (observed-not-documented). */
function liveBody() {
  return {
    five_hour: { utilization: 50.0, resets_at: "2026-06-07T02:50:00+00:00" },
    seven_day: { utilization: 34.0, resets_at: "2026-06-10T17:00:00+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 0.0, resets_at: null },
    extra_usage: { is_enabled: false },
  };
}

describe("oauth-usage: success", () => {
  test("returns {ok:true} with parsed five_hour/seven_day utilization + resetsAt", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string, init: any) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return fakeResponse({ ok: true, json: async () => liveBody() });
    }) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(isOAuthUsageOk(r), true);
    assert.equal(r.ok && r.data.fiveHour.utilization, 50);
    assert.equal(r.ok && r.data.sevenDay.utilization, 34);
    assert.equal(r.ok && r.data.fiveHour.resetsAt, "2026-06-07T02:50:00.000Z");
    assert.equal(seenUrl, OAUTH_USAGE_URL);
    assert.equal(seenHeaders["Authorization"], "Bearer test-access-token");
    assert.equal(seenHeaders["anthropic-beta"], OAUTH_USAGE_BETA);
  });
});

describe("oauth-usage: the failure modes (never throw)", () => {
  test("oauth-usage-no-credentials — no token resolved", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called when there is no token");
    }) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: async () => null });
    assert.equal(isOAuthUsageFailure(r), true);
    assert.equal(r.ok === false && r.code, "oauth-usage-no-credentials");
  });

  test("oauth-usage-token-expired — endpoint returns 401", async () => {
    const fetchImpl = (async () => fakeResponse({ ok: false, status: 401 })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-token-expired");
  });

  test("oauth-usage-token-expired — endpoint returns 403", async () => {
    const fetchImpl = (async () => fakeResponse({ ok: false, status: 403 })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-token-expired");
  });

  test("oauth-usage-non-2xx — any other non-2xx status", async () => {
    const fetchImpl = (async () => fakeResponse({ ok: false, status: 500 })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-non-2xx");
  });

  test("oauth-usage-parse — a 2xx body that fails JSON.parse", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-parse");
  });

  test("oauth-usage-parse — 200-with-garbage body missing a usable window", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: true, json: async () => ({ totally: "different" }) })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-parse");
  });

  test("oauth-usage-timeout — the AbortSignal fired (TimeoutError)", async () => {
    const fetchImpl = (async () => {
      const err: any = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk, timeout: 1 });
    assert.equal(r.ok === false && r.code, "oauth-usage-timeout");
  });

  test("oauth-usage-network — transport failure (ECONNREFUSED-class throw)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-network");
  });
});

describe("oauth-usage: parseOAuthUsageBody — defensive parse (gate-safety)", () => {
  test("parses the live shape", () => {
    const d = parseOAuthUsageBody(liveBody());
    assert.ok(d !== null);
    assert.equal(d!.fiveHour.utilization, 50);
    assert.equal(d!.sevenDay.utilization, 34);
  });

  test("a real 0% utilization is preserved (NOT confused with unavailable)", () => {
    const d = parseOAuthUsageBody({
      five_hour: { utilization: 0, resets_at: "2026-06-07T02:50:00Z" },
      seven_day: { utilization: 0, resets_at: "2026-06-10T17:00:00Z" },
    });
    assert.ok(d !== null);
    assert.equal(d!.fiveHour.utilization, 0);
    assert.equal(d!.sevenDay.utilization, 0);
  });

  test("a MISSING utilization is null (=> caller falls back), NOT coerced to 0", () => {
    // The whole gate-safety point: absent/garbage utilization must not read 0.
    assert.equal(parseOAuthUsageBody({ five_hour: {}, seven_day: { utilization: 12 } }), null);
    assert.equal(
      parseOAuthUsageBody({ five_hour: { utilization: "nan" }, seven_day: { utilization: 12 } }),
      null,
    );
    assert.equal(
      parseOAuthUsageBody({ five_hour: { utilization: NaN }, seven_day: { utilization: 12 } }),
      null,
    );
    assert.equal(parseOAuthUsageBody({ seven_day: { utilization: 12 } }), null);
    assert.equal(parseOAuthUsageBody(null), null);
    assert.equal(parseOAuthUsageBody("nope"), null);
  });

  test("an out-of-range utilization is clamped to [0,100]", () => {
    const d = parseOAuthUsageBody({
      five_hour: { utilization: 150, resets_at: null },
      seven_day: { utilization: -5, resets_at: null },
    });
    assert.equal(d!.fiveHour.utilization, 100);
    assert.equal(d!.sevenDay.utilization, 0);
  });

  test("an unparseable resets_at degrades to null without rejecting the window", () => {
    const d = parseOAuthUsageBody({
      five_hour: { utilization: 10, resets_at: "not-a-date" },
      seven_day: { utilization: 10, resets_at: 12345 },
    });
    assert.ok(d !== null);
    assert.equal(d!.fiveHour.resetsAt, null);
    assert.equal(d!.sevenDay.resetsAt, null);
  });
});
