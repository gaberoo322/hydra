/**
 * Direct-from-leaf unit tests for the zero-IO ProbeClassify leaf (issue #3115).
 *
 * #3115 split the PURE half of the ServiceProbe Adapter Seam — the display-status
 * classifiers + the constants/types they reason about — out of src/health/probe.ts
 * into src/health/probe-classify.ts, a LEAF with NO IO in its import closure (no
 * value import of the OpenViking Request Adapter, no globalThis.fetch, no
 * AbortSignal.timeout, no process.env, no Date.now()). probe.ts re-exports every
 * symbol 1:1 so existing importers are undisturbed, and test/health-probe.test.mts
 * already exercises the classifiers THROUGH that relay.
 *
 * The design concept's qaTrace item 6 mandates THIS separate suite: it imports the
 * classifiers DIRECTLY from ../src/health/probe-classify.ts (NOT via probe.ts) as
 * the mechanical proof of the leaf's zero-IO closure — that the module loads and
 * its classifiers run with no fetch, no OV adapter, no AbortSignal, no Redis pulled
 * into the module-load path. The whole file merely importing and running the
 * classifiers synchronously (no network, no I/O side effects, no async setup) IS
 * that proof: if the leaf's import closure dragged in any IO adapter, loading this
 * module would either fail or perform I/O — it does neither.
 *
 * Authored as a NEW top-level suite with its own (trivial, IO-free) lifecycle per
 * the repo's shared-Redis / top-level-suite authoring rules — it shares no
 * connection or mutable state with any sibling suite.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyServiceProbe,
  classifyServiceBoolean,
  classifyOvSearchProbe,
  DEGRADED_LATENCY_THRESHOLD_MS,
  OV_SEARCH_PROBE_TIMEOUT_MS,
  type ProbeOutcome,
  type ProbeStatus,
  type OvSearchProbeStatus,
} from "../src/health/probe-classify.ts";

// ---------------------------------------------------------------------------
// PromiseSettledResult helpers (pure — no async, no I/O).
// ---------------------------------------------------------------------------

function fulfilled<T>(value: T): PromiseSettledResult<T> {
  return { status: "fulfilled", value };
}
function rejectedSettle<T>(reason: unknown): PromiseSettledResult<T> {
  return { status: "rejected", reason };
}

// ---------------------------------------------------------------------------
// classifyServiceProbe — three-way ok|degraded|down display classification.
// Imported DIRECTLY from the leaf (probe-classify.ts), NOT through probe.ts —
// proving the classifier runs with zero IO in its module-load closure (#3115).
// ---------------------------------------------------------------------------

describe("classifyServiceProbe (direct-from-leaf, zero-IO)", () => {
  test("ok probe under the degraded threshold → ok, latency kept, no error", () => {
    const c = classifyServiceProbe(fulfilled<ProbeOutcome>({ ok: true, latencyMs: 150 }));
    assert.equal(c.status, "ok");
    assert.equal(c.latencyMs, 150);
    assert.equal(c.lastError, undefined);
  });

  test("ok probe at the degraded threshold → degraded with a slow-probe note, latency kept", () => {
    const c = classifyServiceProbe(
      fulfilled<ProbeOutcome>({ ok: true, latencyMs: DEGRADED_LATENCY_THRESHOLD_MS }),
    );
    assert.equal(c.status, "degraded");
    assert.equal(c.latencyMs, DEGRADED_LATENCY_THRESHOLD_MS);
    assert.match(c.lastError ?? "", /slow probe/i);
  });

  test("ok probe above the degraded threshold → degraded, latency kept", () => {
    const c = classifyServiceProbe(
      fulfilled<ProbeOutcome>({ ok: true, latencyMs: DEGRADED_LATENCY_THRESHOLD_MS + 500 }),
    );
    assert.equal(c.status, "degraded");
    assert.equal(c.latencyMs, DEGRADED_LATENCY_THRESHOLD_MS + 500);
  });

  test("failed probe (ok:false) → down with the captured error + latency", () => {
    const c = classifyServiceProbe(
      fulfilled<ProbeOutcome>({ ok: false, latencyMs: 99, error: "HTTP 503" }),
    );
    assert.equal(c.status, "down");
    assert.equal(c.lastError, "HTTP 503");
    assert.equal(c.latencyMs, 99);
  });

  test("failed probe with no error message → down with a default 'probe failed' note", () => {
    const c = classifyServiceProbe(fulfilled<ProbeOutcome>({ ok: false, latencyMs: 12 }));
    assert.equal(c.status, "down");
    assert.equal(c.lastError, "probe failed");
    assert.equal(c.latencyMs, 12);
  });

  test("rejected settle → down with the rejection reason, NEVER throws", () => {
    const c = classifyServiceProbe(rejectedSettle<ProbeOutcome>(new Error("DNS lookup failed")));
    assert.equal(c.status, "down");
    assert.equal(c.lastError, "DNS lookup failed");
    assert.equal(c.latencyMs, undefined);
  });

  test("rejected settle with a non-Error reason → down, stringifies the reason", () => {
    const c = classifyServiceProbe(rejectedSettle<ProbeOutcome>("boom"));
    assert.equal(c.status, "down");
    assert.equal(c.lastError, "boom");
  });
});

// ---------------------------------------------------------------------------
// classifyServiceBoolean — boolean health check → ok|down (no degraded middle).
// ---------------------------------------------------------------------------

describe("classifyServiceBoolean (direct-from-leaf, zero-IO)", () => {
  test("true → ok with no error", () => {
    const c = classifyServiceBoolean(fulfilled(true), { service: "orchestrator" });
    assert.equal(c.status, "ok");
    assert.equal(c.lastError, undefined);
  });

  test("false → down with a service-named default message", () => {
    const c = classifyServiceBoolean(fulfilled(false), { service: "redis" });
    assert.equal(c.status, "down");
    assert.match(c.lastError ?? "", /redis is not responding/i);
  });

  test("false → down with the supplied degradedMessage knob overriding the default", () => {
    const c = classifyServiceBoolean(fulfilled(false), {
      service: "orchestrator",
      degradedMessage: "kill-switch active",
    });
    assert.equal(c.status, "down");
    assert.equal(c.lastError, "kill-switch active");
  });

  test("rejected settle → down with the rejection reason, NEVER throws", () => {
    const c = classifyServiceBoolean(rejectedSettle(new Error("connection refused")), {
      service: "redis",
    });
    assert.equal(c.status, "down");
    assert.equal(c.lastError, "connection refused");
  });
});

// ---------------------------------------------------------------------------
// classifyOvSearchProbe — OV-search deep-health timeout-vs-failure mapping
// (issue #1032 / #1781), relocated into the leaf by #3115.
// ---------------------------------------------------------------------------

describe("classifyOvSearchProbe (direct-from-leaf, zero-IO)", () => {
  test("a 200 body counts hits across memories/resources/skills and reports running", () => {
    const lat = OV_SEARCH_PROBE_TIMEOUT_MS - 800;
    const out = classifyOvSearchProbe(
      { ok: true, data: { result: { memories: [1, 2], resources: [3], skills: [] } } },
      lat,
    );
    assert.equal(out.status, "running");
    assert.equal(out.latencyMs, lat);
    assert.equal(out.resultCount, 3);
  });

  test("a 200 with a missing result body counts zero hits but stays running", () => {
    const out = classifyOvSearchProbe({ ok: true, data: {} }, 4200);
    assert.equal(out.status, "running");
    assert.equal(out.resultCount, 0);
    assert.equal(out.latencyMs, 4200);
  });

  test("ov-timeout → 'timeout' (NOT failed) and KEEPS its measured latency", () => {
    const out = classifyOvSearchProbe({ ok: false, code: "ov-timeout" }, 15000);
    assert.equal(out.status, "timeout");
    assert.equal(out.latencyMs, 15000);
    assert.equal(out.resultCount, 0);
  });

  test("ov-service-down → backend-unreachable with null latency (no round-trip)", () => {
    const out = classifyOvSearchProbe({ ok: false, code: "ov-service-down" }, 25);
    assert.equal(out.status, "backend-unreachable");
    assert.equal(out.latencyMs, null);
    assert.equal(out.resultCount, 0);
  });

  test("ov-non-2xx → failed, WITH its measured latency (OV answered a 5xx)", () => {
    const out = classifyOvSearchProbe({ ok: false, code: "ov-non-2xx" }, 1471);
    assert.equal(out.status, "failed");
    assert.equal(out.latencyMs, 1471);
    assert.equal(out.resultCount, 0);
  });

  test("ov-malformed-json → failed with null latency (2xx but body was garbage)", () => {
    const out = classifyOvSearchProbe({ ok: false, code: "ov-malformed-json" }, 30);
    assert.equal(out.status, "failed");
    assert.equal(out.latencyMs, null);
    assert.equal(out.resultCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Constants + type-level surface — the leaf's exported vocabulary loads and is
// pinned, all without touching any IO adapter.
// ---------------------------------------------------------------------------

describe("ProbeClassify constants + type surface (direct-from-leaf)", () => {
  test("the degraded latency threshold is 1000ms (preserved 1:1 from service-strip)", () => {
    assert.equal(DEGRADED_LATENCY_THRESHOLD_MS, 1000);
  });

  test("the OV-search probe ceiling is generous enough for the Ollama embedding path", () => {
    assert.ok(
      OV_SEARCH_PROBE_TIMEOUT_MS >= 10_000,
      "OV search probe timeout must accommodate the Tailnet+Ollama embedding latency",
    );
    assert.equal(OV_SEARCH_PROBE_TIMEOUT_MS, 15_000);
  });

  test("the display + OV-search status unions are exported and usable (compile-time proof)", () => {
    // Exercising the type exports at a value site: if these narrowed unions were
    // not exported from the leaf, this file would not typecheck (npm run typecheck
    // is the FULL, test-file-including pass this suite is verified under).
    const display: ProbeStatus = "degraded";
    const ov: OvSearchProbeStatus = "backend-unreachable";
    assert.equal(display, "degraded");
    assert.equal(ov, "backend-unreachable");
  });
});
