/**
 * Regression tests for the CORS exact-match allowlist (issue #4047, split
 * from #4000).
 *
 * `src/api.ts` used to reflect ANY request `Origin` back as
 * `Access-Control-Allow-Origin` — equivalent to a wildcard, and reachable
 * because the orchestrator API on :4000 is public + unauthenticated. This
 * suite pins the replacement: an exact-match allowlist sourced from
 * `HYDRA_CORS_ALLOWED_ORIGINS` (comma-separated), defaulting to empty, with
 * NO header at all (never `null`, never `*`) on any non-match — including a
 * suffix/subdomain near-miss of an allowlisted origin, which is the classic
 * allowlist-bypass shape this regression test exists to close off.
 *
 * This process sets `HYDRA_CORS_ALLOWED_ORIGINS` BEFORE importing
 * `src/api.ts` (env is read once at `createApi()` call time), mirroring the
 * load-time-env pattern `test/api.test.mts` and `test/api-health.test.mts`
 * already use. `test/api.test.mts` covers the OTHER half of this contract —
 * default-empty-allowlist behavior when the env var is unset — in its own
 * process, so the two suites never fight over the env var.
 *
 * New TOP-LEVEL `describe` with its own `before`/`after` lifecycle, per the
 * CLAUDE.md authoring rule: never nest inside a sibling suite's shared-Redis
 * teardown. This suite touches no Redis at all (a structural eventBus stub
 * is enough to mount the app), so it is fully hermetic.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

const ALLOWED_ORIGIN = "https://admin.clawstreetbets.xyz";
process.env.HYDRA_CORS_ALLOWED_ORIGINS = ` ${ALLOWED_ORIGIN} , http://localhost:3000 `;

const { createApi, parseAllowedOrigins } = await import("../src/api.ts");

function stubEventBus(): any {
  return {
    publisher: { ping: async () => "PONG" },
    publish: async () => "1-0",
    readRecent: async () => [],
  };
}

async function startApp(): Promise<{ server: any; baseUrl: string }> {
  const app = createApi(stubEventBus());
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("parseAllowedOrigins — env parsing (issue #4047)", () => {
  test("splits on comma and trims whitespace", () => {
    assert.deepEqual(
      parseAllowedOrigins(" https://a.example , https://b.example "),
      ["https://a.example", "https://b.example"],
    );
  });

  test("drops blank entries from trailing/doubled commas", () => {
    assert.deepEqual(parseAllowedOrigins("https://a.example,,"), ["https://a.example"]);
  });

  test("undefined and empty string both parse to an empty allowlist", () => {
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins(""), []);
  });
});

describe("CORS exact-match allowlist — mounted app (issue #4047)", () => {
  let server: any;
  let baseUrl: string;

  before(async () => {
    const started = await startApp();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(() => {
    if (server) server.close();
  });

  test("an allowlisted origin gets the exact Access-Control-Allow-Origin header back", async () => {
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`, {
      headers: { origin: ALLOWED_ORIGIN },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      ALLOWED_ORIGIN,
      "an exact allowlist match should be echoed back verbatim",
    );
  });

  test("a disallowed origin gets no Access-Control-Allow-Origin header at all", async () => {
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`, {
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      "a non-allowlisted origin must receive no ACAO header (absence, not emptiness)",
    );
  });

  test("a suffix-appended near-miss of an allowlisted origin is rejected (allowlist-bypass regression)", async () => {
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`, {
      headers: { origin: `${ALLOWED_ORIGIN}.evil.com` },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      "a suffix-appended near-miss must not match the allowlist entry",
    );
  });

  test("a scheme-swapped near-miss of an allowlisted origin is rejected (http vs https)", async () => {
    const swapped = ALLOWED_ORIGIN.replace("https://", "http://");
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`, {
      headers: { origin: swapped },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      "a scheme-swapped origin must not match — the allowlist is exact-string, not host-only",
    );
  });

  test("OPTIONS preflight from an allowlisted origin returns 204 WITH the ACAO header", async () => {
    const res = await fetch(`${baseUrl}/api/anything`, {
      method: "OPTIONS",
      headers: { origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 204, "preflight should still short-circuit to 204");
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      ALLOWED_ORIGIN,
      "an allowlisted preflight origin should carry the ACAO header",
    );
  });

  test("OPTIONS preflight from a non-allowlisted origin returns 204 WITHOUT the ACAO header", async () => {
    const res = await fetch(`${baseUrl}/api/anything`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(res.status, 204, "preflight should still short-circuit to 204 even when rejected");
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      "a non-allowlisted preflight origin must carry no ACAO header",
    );
  });

  test("same-origin requests (no Origin header) are unaffected and still succeed", async () => {
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`);
    assert.equal(res.status, 200, "a same-origin request (no Origin header) should succeed regardless of the allowlist");
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      "no Origin header in the request means no ACAO header in the response",
    );
  });
});
