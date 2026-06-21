/**
 * Unit tests for the ServiceProbe Adapter Seam (issue #1324, extracted to its
 * own module in issue #1980).
 *
 * The plain-HTTP service probe and the OpenViking liveness probe used to be
 * duplicated as inline closures inside both GET /health/services and the GET
 * /health/deep fan-out — exercisable only by standing up the full Express route
 * + a real network. #1324 hoisted them to module-level probeService()/probeOv()
 * with an injectable fetch/adapter impl; #1980 moved them out of the route file
 * into the focused src/health/probe.ts seam. They are testable directly: stub
 * the dependency, assert the {status, latencyMs} fold.
 *
 * These assert the failed/running/timeout classification and the acceptAny
 * branch WITHOUT Express, without a real fetch, and without a network — the
 * "testable seam" the issue exists to create.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  probeService,
  probeOv,
  probeEmbedBackend,
  probeSkillsEndpoint,
  probeOllamaVlm,
  classifyOvSearchProbe,
  OV_SEARCH_PROBE_TIMEOUT_MS,
  type ServiceProbeResult,
  type OllamaVlmProbeResult,
} from "../src/health/probe.ts";
import type { OvResult } from "../src/knowledge-base/ov-request.ts";

// ---------------------------------------------------------------------------
// probeService — plain-HTTP probe, classification via injected fetchImpl
// ---------------------------------------------------------------------------

describe("probeService", () => {
  test("2xx response → running with a numeric latency", async () => {
    const fetchImpl = (async () => ({ ok: true }) as Response) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { fetchImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
    assert.ok(r.latencyMs! >= 0);
  });

  test("non-2xx response → failed (acceptAny default false)", async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { fetchImpl });
    assert.equal(r.status, "failed");
    // A reached-but-non-2xx port still measured latency (it answered).
    assert.equal(typeof r.latencyMs, "number");
  });

  test("non-2xx response → running when acceptAny is true", async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { acceptAny: true, fetchImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("thrown transport error → {failed, latencyMs:null}, never re-throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    let r: ServiceProbeResult;
    await assert.doesNotReject(async () => {
      r = await probeService("http://localhost:5000/health", { fetchImpl });
    });
    assert.equal(r!.status, "failed");
    assert.equal(r!.latencyMs, null);
  });

  test("AbortSignal timeout (TimeoutError) → {failed, latencyMs:null}", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { fetchImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });
});

// ---------------------------------------------------------------------------
// probeOv — OpenViking liveness, classification via injected ovHealthGet impl
// ---------------------------------------------------------------------------

describe("probeOv", () => {
  test("adapter ok → running with a numeric latency", async () => {
    const ovHealthGetImpl = (async () => ({ ok: true, data: undefined }) as OvResult<void>);
    const r = await probeOv({ ovHealthGetImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("adapter failure (ov-service-down) → {failed, latencyMs:null}", async () => {
    const ovHealthGetImpl = (async () => ({ ok: false, code: "ov-service-down" }) as OvResult<void>);
    const r = await probeOv({ ovHealthGetImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("adapter timeout (ov-timeout) → {failed, latencyMs:null}", async () => {
    const ovHealthGetImpl = (async () => ({ ok: false, code: "ov-timeout" }) as OvResult<void>);
    const r = await probeOv({ ovHealthGetImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("never re-throws even if the adapter impl rejects is not its contract — adapter never throws", async () => {
    // The OV Request Adapter is contractually never-throwing; probeOv relies on
    // that. This guards the happy/failure mapping covers both arms exhaustively.
    const okR = await probeOv({ ovHealthGetImpl: async () => ({ ok: true, data: undefined }) as OvResult<void> });
    const failR = await probeOv({ ovHealthGetImpl: async () => ({ ok: false, code: "ov-non-2xx" }) as OvResult<void> });
    assert.equal(okR.status, "running");
    assert.equal(failR.status, "failed");
    assert.equal(failR.latencyMs, null);
  });
});

// ---------------------------------------------------------------------------
// probeEmbedBackend — OV dense-embedding backend, via the embedding-exercising
// search/find transport through the OV Request Adapter (issue #2013)
// ---------------------------------------------------------------------------

describe("probeEmbedBackend", () => {
  test("adapter ok (OV + embed backend answered) → running with numeric latency", async () => {
    const ovPostJsonImpl = (async () => ({ ok: true, data: { results: [] } }) as OvResult<any>);
    const r = await probeEmbedBackend({ ovPostJsonImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
    assert.ok(r.latencyMs! >= 0);
  });

  test("ov-service-down (embed transport never reached the backend) → {failed, latencyMs:null}", async () => {
    // This is the #1921 stale-embed condition: OV's app /health may be 200 while
    // the dense-embedding backend (ollama-embed) is unreachable, so the
    // embedding-exercising search transport fails to reach it.
    const ovPostJsonImpl = (async () => ({ ok: false, code: "ov-service-down" }) as OvResult<any>);
    const r = await probeEmbedBackend({ ovPostJsonImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("ov-timeout (embed backend too slow to answer) → {failed, latencyMs:null}", async () => {
    const ovPostJsonImpl = (async () => ({ ok: false, code: "ov-timeout" }) as OvResult<any>);
    const r = await probeEmbedBackend({ ovPostJsonImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("ov-non-2xx (OV answered with an app error — backend WAS reachable) → running", async () => {
    // A non-2xx means OV (and the backend behind it) responded; that is an
    // app-level error, not an embed-backend liveness failure. The distinct
    // embed-backend probe only flips to failed when the transport never reached
    // the backend (service-down/timeout).
    const ovPostJsonImpl = (async () => ({ ok: false, code: "ov-non-2xx", body: "bad request" }) as OvResult<any>);
    const r = await probeEmbedBackend({ ovPostJsonImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("never re-throws — both arms map exhaustively", async () => {
    let r: ServiceProbeResult;
    await assert.doesNotReject(async () => {
      r = await probeEmbedBackend({
        ovPostJsonImpl: async () => ({ ok: false, code: "ov-malformed-json" }) as OvResult<any>,
      });
    });
    // malformed-json means OV answered (2xx) but the body did not parse — the
    // backend was reachable, so this is NOT an embed-backend liveness failure.
    assert.equal(r!.status, "running");
  });
});

// ---------------------------------------------------------------------------
// probeSkillsEndpoint — OV skills-registration resource liveness (issue #2163).
// Gates the skill-catalog-reregister chore on the resource it actually writes
// to (POST /api/v1/skills) instead of OV-the-app's shallow GET /health.
// ---------------------------------------------------------------------------

describe("probeSkillsEndpoint", () => {
  test("POSTs a read-only invalid payload to /api/v1/skills (no catalog mutation — INV2)", async () => {
    // The probe must hit the SKILLS resource, via POST (the only verb OV
    // exposes there — GET/HEAD 405 at the router), with a deliberately-invalid
    // body so the handler validation-rejects it WITHOUT writing the catalog.
    let calledPath: string | undefined;
    let calledMethod: string | undefined;
    let calledBody: string | undefined;
    const ovRequestImpl = (async (path: string, init: any) => {
      calledPath = path;
      calledMethod = init?.method;
      calledBody = init?.body;
      // OV's validator rejecting the invalid payload — an app-level non-2xx,
      // which means the handler DID answer → running.
      return { ok: false, code: "ov-non-2xx", body: "Skill data cannot be None" } as OvResult<any>;
    }) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(calledPath, "/api/v1/skills", "must probe the skills resource the chore writes to");
    assert.equal(calledMethod, "POST", "OV exposes only POST on /api/v1/skills (GET/HEAD 405)");
    // The body must be a deliberately-invalid payload (no real skill `data`), so
    // the handler rejects it before any catalog write — read-only in effect.
    const parsed = JSON.parse(calledBody!);
    assert.equal(parsed.data, null, "the probe payload must be invalid so OV writes nothing");
    assert.equal(r.status, "running", "an app-level reject means the handler answered → running");
  });

  test("2xx (handler answered) → running with a numeric latency", async () => {
    const ovRequestImpl = (async () => ({ ok: true, data: {} }) as OvResult<any>) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
    assert.ok(r.latencyMs! >= 0);
  });

  test("ov-non-2xx (validation reject — handler responsive) → running", async () => {
    // The EXPECTED happy-path signal: the handler rejected our invalid payload,
    // proving the load-gated POST handler is answering → the resource is live.
    const ovRequestImpl = (async () => ({ ok: false, code: "ov-non-2xx", body: "'name'" }) as OvResult<any>) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("ov-malformed-json (2xx body parse fail — handler still answered) → running", async () => {
    const ovRequestImpl = (async () => ({ ok: false, code: "ov-malformed-json" }) as OvResult<any>) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(r.status, "running", "a 2xx that failed to parse still proves the handler answered");
  });

  test("ov-non-2xx carrying OV's server-side-timeout 500 body → {failed, latencyMs:null} (issue #2269)", async () => {
    // THE #2269 resilience gap: under sustained indexing load OV surfaces its own
    // request timeout as a 500 whose body is the INTERNAL/"Request timed out."
    // envelope — structurally an ov-non-2xx. Before this fix the probe read that
    // as "the handler answered → running" and green-lit a doomed hourly recovery
    // pass that 500'd on every skill. It must fold to failed so the chore does NOT
    // launch a pass against a handler that is timing out server-side.
    const ovRequestImpl = (async () =>
      ({
        ok: false,
        code: "ov-non-2xx",
        body: '{"status":"error","error":{"code":"INTERNAL","message":"Request timed out."}}',
      }) as OvResult<any>) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(r.status, "failed", "OV's server-side-timeout 500 is the load-gated doomed-pass signal, not a live handler");
    assert.equal(r.latencyMs, null);
  });

  test("ov-non-2xx with a genuine non-timeout error body → running (validation reject still proves liveness)", async () => {
    // Guard the #2163 happy path: only OV's INTERNAL/timeout body folds to failed.
    // Any OTHER ov-non-2xx body (a real validation reject, a 4xx, a 5xx that is
    // not a server-side timeout) still proves the handler answered fast → running.
    const ovRequestImpl = (async () =>
      ({
        ok: false,
        code: "ov-non-2xx",
        body: '{"status":"error","error":{"code":"VALIDATION","message":"Skill data cannot be None"}}',
      }) as OvResult<any>) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(r.status, "running", "a non-timeout ov-non-2xx body means the handler answered → running");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("ov-timeout (handler did not answer in the short window — load-gated) → {failed, latencyMs:null}", async () => {
    // THE bug this issue fixes: under indexing load (#1831) the POST handler
    // does not answer inside the short probe window, so the gate must fold to
    // failed and the chore must NOT launch a doomed pass.
    const ovRequestImpl = (async () => ({ ok: false, code: "ov-timeout" }) as OvResult<any>) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("ov-service-down (transport never reached the handler) → {failed, latencyMs:null}", async () => {
    const ovRequestImpl = (async () => ({ ok: false, code: "ov-service-down" }) as OvResult<any>) as any;
    const r = await probeSkillsEndpoint({ ovRequestImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("never re-throws — both arms map exhaustively", async () => {
    let r: ServiceProbeResult;
    await assert.doesNotReject(async () => {
      r = await probeSkillsEndpoint({
        ovRequestImpl: (async () => ({ ok: false, code: "ov-timeout" }) as OvResult<any>) as any,
      });
    });
    assert.equal(r!.status, "failed");
  });
});

// ---------------------------------------------------------------------------
// probeOllamaVlm — Tailnet VLM-host liveness (issue #2278). A DIRECT
// reachability check of gabes-desktop-1:11434 (the host OpenViking uses for its
// vision/indexing model), distinct from the OV-internal embed-backend probe.
// Folds to {status:'ok'|'down', latencyMs, error?} — `ok` on ANY HTTP answer
// (liveness, not a contract endpoint), `down` only on a transport failure /
// timeout (the recurring silent skill-catalog failure #2277/#2269/…).
// ---------------------------------------------------------------------------

describe("probeOllamaVlm", () => {
  test("2xx response → ok with a numeric latency", async () => {
    const fetchImpl = (async () => ({ ok: true }) as Response) as typeof globalThis.fetch;
    const r = await probeOllamaVlm({ fetchImpl });
    assert.equal(r.status, "ok");
    assert.equal(typeof r.latencyMs, "number");
    assert.ok(r.latencyMs >= 0);
    assert.equal(r.error, undefined);
  });

  test("targets ${url}/api/health (the issue's documented liveness path)", async () => {
    let calledUrl: string | undefined;
    const fetchImpl = (async (u: string) => {
      calledUrl = u;
      return { ok: true } as Response;
    }) as typeof globalThis.fetch;
    await probeOllamaVlm({ url: "http://gabes-desktop-1:11434", fetchImpl });
    assert.equal(calledUrl, "http://gabes-desktop-1:11434/api/health");
  });

  test("non-2xx response → STILL ok (liveness: any HTTP answer proves reachability)", async () => {
    // Ollama 404s on an unmapped path, but a 404 still proves the HTTP server
    // answered — the host is reachable, so this is `ok`, not `down`. The probe is
    // a liveness check, not a contract endpoint, so it does NOT gate on r.ok.
    const fetchImpl = (async () => ({ ok: false, status: 404 }) as Response) as typeof globalThis.fetch;
    const r = await probeOllamaVlm({ fetchImpl });
    assert.equal(r.status, "ok");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("AbortSignal timeout (TimeoutError) → {down, error}, never re-throws", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as typeof globalThis.fetch;
    let r: OllamaVlmProbeResult;
    await assert.doesNotReject(async () => {
      r = await probeOllamaVlm({ fetchImpl });
    });
    assert.equal(r!.status, "down");
    assert.equal(typeof r!.latencyMs, "number", "latency is the elapsed wall-clock, always numeric");
    assert.match(r!.error!, /aborted due to timeout/);
  });

  test("transport failure (ECONNREFUSED — host off) → {down, error}", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const r = await probeOllamaVlm({ fetchImpl });
    assert.equal(r.status, "down");
    assert.match(r.error!, /ECONNREFUSED/);
  });
});

// ---------------------------------------------------------------------------
// classifyOvSearchProbe — pure timeout-vs-failure mapping (issue #1032).
// Relocated here from test/health-diagnostics.test.mts in #2023, tracking the
// classifier's move into this ServiceProbe Adapter Seam.
// ---------------------------------------------------------------------------

describe("classifyOvSearchProbe", () => {
  test("a slow-but-successful probe within the window reports running with latency", () => {
    // Simulate the Ollama-backed path returning 200 after a long-but-bounded
    // latency (> the old 3000ms cap, < the new ceiling).
    const lat = OV_SEARCH_PROBE_TIMEOUT_MS - 800;
    const out = classifyOvSearchProbe(
      { ok: true, data: { result: { memories: [1, 2], resources: [3], skills: [] } } },
      lat,
    );
    assert.equal(out.status, "running");
    assert.equal(out.latencyMs, lat);
    assert.equal(out.resultCount, 3);
  });

  test("a probe timeout reports 'timeout' (NOT 'failed') and KEEPS its latency", () => {
    // ov-timeout is the regression #1032 fixes: previously this collapsed to
    // { status:"failed", latencyMs:null }.
    const out = classifyOvSearchProbe({ ok: false, code: "ov-timeout" }, 15000);
    assert.equal(out.status, "timeout");
    assert.equal(out.latencyMs, 15000, "timeout must carry the measured latency, not null");
    assert.equal(out.resultCount, 0);
  });

  test("a real 5xx (ov-non-2xx) still reports failed, with latency", () => {
    const out = classifyOvSearchProbe({ ok: false, code: "ov-non-2xx" }, 1471);
    assert.equal(out.status, "failed");
    assert.equal(out.latencyMs, 1471);
    assert.equal(out.resultCount, 0);
  });

  // Issue #1781: a transport failure on the embedding-exercising search path is
  // the distinct "embedding backend unreachable" signal — NOT a generic OV 5xx.
  // It now reports `backend-unreachable` (was `failed` under #1032) so the
  // diagnostic can point the operator at the backend host, not OpenViking.
  test("a transport failure (ov-service-down) reports backend-unreachable with null latency", () => {
    const out = classifyOvSearchProbe({ ok: false, code: "ov-service-down" }, 25);
    assert.equal(out.status, "backend-unreachable");
    assert.equal(out.latencyMs, null, "no round-trip → meaningless latency → null");
    assert.equal(out.resultCount, 0);
  });

  // Issue #1781: a malformed-JSON body DID round-trip OV (2xx) but the body was
  // garbage — that is an OV-internal fault, not a backend-reachability problem,
  // so it must stay `failed` and NOT leak into the new backend-unreachable state.
  test("a malformed-JSON 2xx body (ov-malformed-json) still reports failed, not backend-unreachable", () => {
    const out = classifyOvSearchProbe({ ok: false, code: "ov-malformed-json" }, 30);
    assert.equal(out.status, "failed");
    assert.equal(out.latencyMs, null, "malformed body → meaningless latency → null");
    assert.equal(out.resultCount, 0);
  });

  test("a 200 with a missing result body counts zero hits but stays running", () => {
    const out = classifyOvSearchProbe({ ok: true, data: {} }, 4200);
    assert.equal(out.status, "running");
    assert.equal(out.resultCount, 0);
    assert.equal(out.latencyMs, 4200);
  });

  test("the probe ceiling is generous enough for the Ollama embedding path", () => {
    // Guard the constant against an accidental tightening back toward the old
    // 3000ms that caused #1032. The real agent search path uses 5000ms.
    assert.ok(
      OV_SEARCH_PROBE_TIMEOUT_MS >= 10_000,
      "OV search probe timeout must accommodate the Tailnet+Ollama embedding latency",
    );
  });
});
