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
  parseRetryAfterMs,
  isOAuthUsageFailure,
  isOAuthUsageOk,
  OAUTH_USAGE_URL,
  OAUTH_USAGE_BETA,
} = await import("../src/cost/oauth-usage.ts");
const { DEFAULT_OAUTH_USAGE_MAX_STALE_MS } = await import("../src/cost/config.ts");

/** A minimal Response-like stub. */
function fakeResponse(opts: {
  ok: boolean;
  status?: number;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
  headers?: Record<string, string>;
}): any {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: opts.json ?? (async () => ({})),
    text: opts.text ?? (async () => ""),
    headers: {
      get: (name: string) => opts.headers?.[name.toLowerCase()] ?? null,
    },
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

  test("oauth-usage-rate-limited — 429 is classified distinctly from non-2xx (issue #2666)", async () => {
    const fetchImpl = (async () => fakeResponse({ ok: false, status: 429 })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-rate-limited");
    assert.equal(r.ok === false && r.retryAfterMs, undefined, "no Retry-After header → no hint");
  });

  test("oauth-usage-rate-limited — delta-seconds Retry-After is parsed to ms (issue #2666)", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 429, headers: { "retry-after": "120" } })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-rate-limited");
    assert.equal(r.ok === false && r.retryAfterMs, 120_000);
  });

  test("oauth-usage-rate-limited — HTTP-date Retry-After is parsed relative to now (issue #2666)", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 429, headers: { "retry-after": future } })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-rate-limited");
    const hint = r.ok === false ? r.retryAfterMs : undefined;
    assert.ok(hint !== undefined, "HTTP-date must parse to a hint");
    // toUTCString truncates to whole seconds, so allow the sub-minute skew.
    assert.ok(hint! > 50_000 && hint! <= 60_000, `expected ~60s, got ${hint}ms`);
  });

  test("oauth-usage-rate-limited — garbage Retry-After degrades to no hint, never throws (issue #2666)", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 429, headers: { "retry-after": "soonish" } })) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-rate-limited");
    assert.equal(r.ok === false && r.retryAfterMs, undefined);
  });

  test("oauth-usage-rate-limited — an hours-long Retry-After is clamped to the maxStale ceiling (issue #2666)", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 429, headers: { "retry-after": "86400" } })) as any; // 24h
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-rate-limited");
    assert.equal(
      r.ok === false && r.retryAfterMs,
      DEFAULT_OAUTH_USAGE_MAX_STALE_MS,
      "a hostile/buggy header must not park the meter for hours",
    );
  });

  test("oauth-usage-rate-limited — a 429 from a Response-like with NO headers object still classifies (issue #2666)", async () => {
    // Defensive-access path: injected doubles may omit `headers` entirely.
    const bare: any = { ok: false, status: 429, text: async () => "" };
    const fetchImpl = (async () => bare) as any;
    const r = await readOAuthUsage({ fetchImpl, readToken: tokenOk });
    assert.equal(r.ok === false && r.code, "oauth-usage-rate-limited");
    assert.equal(r.ok === false && r.retryAfterMs, undefined);
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

describe("oauth-usage: parseRetryAfterMs — pure Retry-After parse (issue #2666)", () => {
  const NOW = Date.parse("2026-07-02T12:00:00Z");
  const CEILING = 1_800_000; // 30 min

  test("delta-seconds → ms", () => {
    assert.equal(parseRetryAfterMs("120", NOW, CEILING), 120_000);
    assert.equal(parseRetryAfterMs("0", NOW, CEILING), 0);
    assert.equal(parseRetryAfterMs(" 30 ", NOW, CEILING), 30_000, "whitespace tolerated");
  });

  test("HTTP-date → dateMs - nowMs", () => {
    assert.equal(
      parseRetryAfterMs("Thu, 02 Jul 2026 12:02:00 GMT", NOW, CEILING),
      120_000,
    );
  });

  test("a PAST HTTP-date clamps to 0 (retry now), not a negative delay", () => {
    assert.equal(parseRetryAfterMs("Thu, 02 Jul 2026 11:00:00 GMT", NOW, CEILING), 0);
  });

  test("absent / empty / garbage → undefined", () => {
    assert.equal(parseRetryAfterMs(null, NOW, CEILING), undefined);
    assert.equal(parseRetryAfterMs(undefined, NOW, CEILING), undefined);
    assert.equal(parseRetryAfterMs("", NOW, CEILING), undefined);
    assert.equal(parseRetryAfterMs("   ", NOW, CEILING), undefined);
    assert.equal(parseRetryAfterMs("soonish", NOW, CEILING), undefined);
    assert.equal(parseRetryAfterMs("-5", NOW, CEILING), undefined, "negative delta-seconds is not RFC 9110");
  });

  test("clamped to the injected ceiling", () => {
    assert.equal(parseRetryAfterMs("86400", NOW, CEILING), CEILING); // 24h → 30min
    assert.equal(
      parseRetryAfterMs("Fri, 03 Jul 2026 12:00:00 GMT", NOW, CEILING),
      CEILING,
      "HTTP-date a day out clamps too",
    );
  });
});
