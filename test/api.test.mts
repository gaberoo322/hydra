/**
 * Regression tests for the HTTP API mount layer (`src/api.ts`, issue #3097).
 *
 * `src/api.ts` is a lean, thin orchestration module: it constructs the Express
 * app, attaches CORS + JSON middleware, mounts ~50 domain sub-routers under the
 * `/api` prefix, wires the Sentry error handler, then serves the dashboard
 * static bundle with an SPA fallback. Despite being the single point of failure
 * for ALL HTTP routing (the highest-reachability module in the codebase), it
 * had zero dedicated coverage — any change to router mounting, the `/api`
 * prefix, middleware ordering, or the SPA-vs-API 404 discrimination would fail
 * silently at *runtime* on the first request, not in CI.
 *
 * These tests exercise the ASSEMBLED app over real HTTP (`app.listen(0)` +
 * `fetch`), which is the only layer that verifies the *mounting* itself — the
 * per-router handler tests (e.g. `test/api-health.test.mts`) cannot catch a
 * dropped `app.use("/api", ...)`, a broken CORS preflight, or an SPA fallback
 * that swallows API 404s.
 *
 * # Why a stub eventBus (no live Redis)
 *
 * `createApi(eventBus)` forwards the bus to a handful of routers (health,
 * scheduler, maintenance, architecture, events, autopilot-control, holdback),
 * but each only *touches* the bus at request time, never at mount time — so a
 * structural stub satisfying `PingableBus` / `PublishableBus` / `EventReaderBus`
 * (`src/event-bus-seams.ts`) is enough to mount the whole app with NO Redis
 * connection. The routes exercised below (`/api/tier`, CORS, SPA fallback,
 * unknown-route 404) are deterministic and never reach Redis, keeping this a
 * hermetic, top-level suite with its own server lifecycle (no shared-Redis
 * teardown, per the CLAUDE.md authoring rule).
 *
 * # Why HYDRA_ROOT is pinned to a temp dir
 *
 * `src/api.ts` reads `HYDRA_ROOT` at module-load time to locate
 * `dashboard/dist/index.html` for the SPA fallback. To make the fallback test
 * hermetic (independent of whether a dashboard build exists), we point
 * HYDRA_ROOT at a temp dir carrying a controlled index.html BEFORE importing
 * the module — the same load-time-env pattern `test/api-health.test.mts` uses
 * for REDIS_URL.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Pin HYDRA_ROOT (read at module-load time) to a temp dir with a known
// dashboard bundle BEFORE importing src/api.ts, so the SPA-fallback route is
// hermetic. `SPA_MARKER` is the exact body the fallback should serve.
// ---------------------------------------------------------------------------

const SPA_MARKER = "<!doctype html><title>hydra-spa-fallback-marker</title>";
const FAKE_ROOT = mkdtempSync(join(tmpdir(), "hydra-api-test-"));
mkdirSync(join(FAKE_ROOT, "dashboard", "dist"), { recursive: true });
writeFileSync(join(FAKE_ROOT, "dashboard", "dist", "index.html"), SPA_MARKER);
process.env.HYDRA_ROOT = FAKE_ROOT;

const { createApi } = await import("../src/api.ts");

// ---------------------------------------------------------------------------
// A structural eventBus stub: it satisfies PingableBus + PublishableBus +
// EventReaderBus (src/event-bus-seams.ts) so createApi mounts every router
// without a live Redis connection. Handlers only touch it at request time,
// and the routes exercised here never do.
// ---------------------------------------------------------------------------

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

describe("createApi — HTTP mount layer (issue #3097)", () => {
  let server: any;
  let baseUrl: string;

  before(async () => {
    const started = await startApp();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(() => {
    if (server) server.close();
    rmSync(FAKE_ROOT, { recursive: true, force: true });
  });

  // --- Mount verification -------------------------------------------------

  test("mounts sub-routers under the /api prefix — GET /api/tier reaches its handler", async () => {
    // /api/tier is deterministic (no Redis) — a clean probe that the api Router
    // is both constructed AND mounted at "/api". A dropped app.use("/api", api)
    // or a router-mount regression would surface here as a 404.
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`);
    assert.equal(res.status, 200, "GET /api/tier should mount and respond 200");
    const body = await res.json();
    assert.ok("tier" in body, "tier route should return a { tier } payload through the mount");
    assert.equal(typeof body.tier, "number", "tier should be classified to a number");
  });

  test("the /api prefix is required — the same route without /api is not mounted", async () => {
    // Guards against a router accidentally being mounted prefix-less on `app`,
    // which would shadow the /api namespace contract.
    const res = await fetch(`${baseUrl}/tier?files=README.md`, {
      headers: { accept: "application/json" },
    });
    assert.notEqual(res.status, 200, "/tier without the /api prefix must not resolve to the tier handler");
  });

  // --- Middleware: CORS ---------------------------------------------------

  test("CORS middleware echoes the request Origin on API responses", async () => {
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`, {
      headers: { origin: "https://dashboard.example.dev" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://dashboard.example.dev",
      "Access-Control-Allow-Origin should echo the incoming Origin",
    );
    assert.ok(
      (res.headers.get("access-control-allow-methods") || "").includes("POST"),
      "Access-Control-Allow-Methods should be advertised",
    );
  });

  test("OPTIONS preflight short-circuits to 204 with CORS headers (before routing)", async () => {
    // The CORS middleware answers OPTIONS with 204 and never reaches a route
    // handler. Ordering matters: this middleware is attached before app.use("/api").
    const res = await fetch(`${baseUrl}/api/anything`, {
      method: "OPTIONS",
      headers: { origin: "https://dashboard.example.dev" },
    });
    assert.equal(res.status, 204, "OPTIONS preflight should return 204 No Content");
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://dashboard.example.dev",
      "preflight response should carry the CORS origin header",
    );
    // A 204 must not carry a body.
    assert.equal(await res.text(), "", "204 preflight should have an empty body");
  });

  test("no Access-Control-Allow-Origin header when the request omits Origin", async () => {
    // Same-origin requests (no Origin header) should not get an echoed ACAO.
    const res = await fetch(`${baseUrl}/api/tier?files=README.md`);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      null,
      "ACAO should be absent when no Origin header is present",
    );
  });

  // --- SPA fallback vs API 404 discrimination -----------------------------

  test("SPA fallback serves index.html for browser navigation (Accept: text/html)", async () => {
    const res = await fetch(`${baseUrl}/some/client/route`, {
      headers: { accept: "text/html" },
    });
    assert.equal(res.status, 200, "browser navigation to a client route should serve the SPA shell");
    const body = await res.text();
    assert.ok(
      body.includes("hydra-spa-fallback-marker"),
      "the SPA fallback should serve dashboard/dist/index.html",
    );
  });

  test("unknown /api route does NOT fall through to the SPA shell — returns 404", async () => {
    // Critical discrimination: the SPA fallback must not swallow unmatched API
    // requests. A non-html Accept on an unknown /api path yields a 404, never
    // index.html — otherwise API clients would receive HTML for missing routes.
    const res = await fetch(`${baseUrl}/api/definitely-not-a-real-route`, {
      headers: { accept: "application/json" },
    });
    assert.equal(res.status, 404, "unknown /api route should 404, not serve the SPA shell");
    const body = await res.text();
    assert.ok(
      !body.includes("hydra-spa-fallback-marker"),
      "an unmatched API route must never return the SPA index.html",
    );
  });

  test("non-html unknown route (no text/html Accept) is not handled by the SPA fallback", async () => {
    // The fallback only fires for GET + Accept: text/html. A JSON client hitting
    // an unknown non-API path should not receive the SPA shell.
    const res = await fetch(`${baseUrl}/not/an/api/path`, {
      headers: { accept: "application/json" },
    });
    const body = await res.text();
    assert.ok(
      !body.includes("hydra-spa-fallback-marker"),
      "non-html requests must not be served the SPA shell",
    );
  });
});
