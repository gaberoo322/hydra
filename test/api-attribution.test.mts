/**
 * test/api-attribution.test.mts — pin the read-only GET /api/attribution view
 * (issue #2631, epic #2628 — the outcome-attribution spine).
 *
 * The view runs the shipped ridge estimator (#2630) over the shipped append-only
 * ledger (#2629) and serializes each ClassEffect verbatim, ranked by |β|. It is
 * observe-only: no Redis write, no dispatch, no revert. These tests drive the
 * factory's handler directly with an INJECTED ledger-read fake (no Redis, no HTTP
 * server), asserting the design-concept invariants:
 *
 *   - every ranked row carries beta AND all identifiability flags AND the
 *     below-noise-floor marker (never a bare point estimate);
 *   - rows are ordered by descending |β|;
 *   - a metric with only dark/empty windows → effects:[] at HTTP 200;
 *   - an entirely-empty ledger → metrics:[] at HTTP 200;
 *   - the ONLY 500 is a getObservations() Redis-read failure (ok:false).
 *
 * New top-level describe with its own (trivial) lifecycle — it touches no shared
 * Redis seam, so it never piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createAttributionRouter } from "../src/api/attribution.ts";
import type {
  AttributionObservation,
  LoadObservationsResult,
} from "../src/redis/attribution-ledger.ts";

function mockReq(): any {
  return {
    method: "GET",
    url: "/attribution",
    headers: {},
    query: {},
    params: {},
    body: {},
  };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

/** Build a router whose ledger read returns a canned result, then invoke it. */
async function callRoute(loaded: LoadObservationsResult): Promise<any> {
  const router = createAttributionRouter(async () => loaded);
  const handler = findHandler(router, "GET", "/attribution");
  assert.ok(handler, "GET /attribution handler must be registered");
  const req = mockReq();
  const res = mockRes();
  await handler!(req, res);
  return res;
}

function obs(
  partial: Partial<AttributionObservation> &
    Pick<AttributionObservation, "metric" | "delta" | "classCounts">,
): AttributionObservation {
  return {
    scopeTouched: "orch",
    tier: 3,
    recordedAt: 1,
    ...partial,
  };
}

describe("GET /api/attribution — read-only marginal-effect view (#2631)", () => {
  test("every ranked row carries β + all identifiability/noise-floor flags", async () => {
    // A metric with a real class column (dev_orch) plus empty windows that anchor
    // σ0/β0 so the below-noise-floor marker can be computed.
    const observations: AttributionObservation[] = [
      obs({ metric: "brier", delta: 5, classCounts: { dev_orch: 1 } }),
      obs({ metric: "brier", delta: 10, classCounts: { dev_orch: 2 } }),
      obs({ metric: "brier", delta: 0.1, classCounts: {} }),
      obs({ metric: "brier", delta: -0.1, classCounts: {} }),
    ];
    const res = await callRoute({ ok: true, observations });

    assert.equal(res._status, 200);
    assert.equal(res._body.metrics.length, 1);
    const m = res._body.metrics[0];
    assert.equal(m.metric, "brier");
    assert.equal(typeof m.intercept, "number");
    assert.equal(m.observationCount, 4);
    assert.equal(m.emptyWindowCount, 2);
    assert.equal(typeof m.sigma0, "number");

    assert.ok(m.effects.length >= 1);
    for (const e of m.effects) {
      assert.equal(typeof e.producerClass, "string");
      assert.equal(typeof e.beta, "number");
      // Every ClassEffect flag must travel verbatim on the row — never a bare
      // point estimate.
      assert.equal(typeof e.lowVariance, "boolean");
      assert.equal(typeof e.collinear, "boolean");
      assert.ok(Array.isArray(e.collinearWith));
      assert.equal(typeof e.belowNoiseFloor, "boolean");
      assert.equal(typeof e.identifiabilitySuspect, "boolean");
    }
  });

  test("effects are ordered by descending |β|", async () => {
    // Two independent class columns with clearly different marginal effects; the
    // larger-|β| class must lead. Empty windows keep σ0 well-defined.
    const observations: AttributionObservation[] = [
      obs({ metric: "roi", delta: 100, classCounts: { big: 1, small: 0 } }),
      obs({ metric: "roi", delta: 200, classCounts: { big: 2, small: 0 } }),
      obs({ metric: "roi", delta: 1, classCounts: { big: 0, small: 1 } }),
      obs({ metric: "roi", delta: 2, classCounts: { big: 0, small: 2 } }),
      obs({ metric: "roi", delta: 0, classCounts: {} }),
      obs({ metric: "roi", delta: 0.5, classCounts: {} }),
    ];
    const res = await callRoute({ ok: true, observations });

    assert.equal(res._status, 200);
    const effects = res._body.metrics[0].effects;
    assert.ok(effects.length >= 2);
    for (let i = 1; i < effects.length; i++) {
      assert.ok(
        Math.abs(effects[i - 1].beta) >= Math.abs(effects[i].beta),
        `effects must be sorted by descending |β|: ${effects[i - 1].beta} vs ${effects[i].beta}`,
      );
    }
    // The high-effect class leads the ranking.
    assert.equal(effects[0].producerClass, "big");
  });

  test("a metric with only dark/empty windows returns effects:[] at 200", async () => {
    // Only empty (zero-merge) windows — no non-zero class column exists, so the
    // estimator yields no effects; the metric is still present with an explicit
    // empty ranked list. Never a 500/404.
    const observations: AttributionObservation[] = [
      obs({ metric: "dark", delta: 0.3, classCounts: {} }),
      obs({ metric: "dark", delta: -0.2, classCounts: { idle: 0 } }),
    ];
    const res = await callRoute({ ok: true, observations });

    assert.equal(res._status, 200);
    assert.equal(res._body.metrics.length, 1);
    assert.equal(res._body.metrics[0].metric, "dark");
    assert.deepEqual(res._body.metrics[0].effects, []);
  });

  test("an entirely-empty ledger returns metrics:[] at 200", async () => {
    const res = await callRoute({ ok: true, observations: [] });
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { metrics: [] });
  });

  test("a getObservations() Redis-read failure returns 500 {error}", async () => {
    const res = await callRoute({ ok: false, error: "redis down" });
    assert.equal(res._status, 500);
    assert.equal(res._body.error, "redis down");
    // No metrics payload on the error path.
    assert.equal(res._body.metrics, undefined);
  });

  test("identifiability flags surface (collinear cluster is not filtered out)", async () => {
    // Two perfectly-collinear class columns (dup_a === dup_b): the ridge splits
    // their shared effect, so each is flagged collinear + identifiabilitySuspect
    // and names the other — the row is SURFACED with flags, never dropped.
    const observations: AttributionObservation[] = [
      obs({ metric: "dup", delta: 4, classCounts: { dup_a: 1, dup_b: 1 } }),
      obs({ metric: "dup", delta: 8, classCounts: { dup_a: 2, dup_b: 2 } }),
      obs({ metric: "dup", delta: 12, classCounts: { dup_a: 3, dup_b: 3 } }),
      obs({ metric: "dup", delta: 0, classCounts: {} }),
      obs({ metric: "dup", delta: 0.1, classCounts: {} }),
    ];
    const res = await callRoute({ ok: true, observations });

    assert.equal(res._status, 200);
    const effects = res._body.metrics[0].effects;
    const byClass = new Map(effects.map((e: any) => [e.producerClass, e]));
    const a: any = byClass.get("dup_a");
    const b: any = byClass.get("dup_b");
    assert.ok(a && b, "both collinear classes must be present, not filtered");
    assert.equal(a.collinear, true);
    assert.equal(b.collinear, true);
    assert.equal(a.identifiabilitySuspect, true);
    assert.ok(a.collinearWith.includes("dup_b"));
    assert.ok(b.collinearWith.includes("dup_a"));
  });

  test("per-metric independence: two metrics each get their own fit", async () => {
    const observations: AttributionObservation[] = [
      obs({ metric: "m1", delta: 3, classCounts: { c: 1 } }),
      obs({ metric: "m2", delta: 7, classCounts: { c: 1 } }),
    ];
    const res = await callRoute({ ok: true, observations });
    assert.equal(res._status, 200);
    const names = res._body.metrics.map((m: any) => m.metric).sort();
    assert.deepEqual(names, ["m1", "m2"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/attribution/impact — the reverse-loop read surface (#3283)
// ---------------------------------------------------------------------------
// New top-level describe (its own trivial lifecycle — touches no shared Redis).
// Drives the impact handler with INJECTED ledger-read + metric-direction fakes.

/** Build a router with canned ledger + direction fakes, invoke the impact route. */
async function callImpact(
  loaded: LoadObservationsResult,
  directions: Record<string, "up" | "down"> = {},
  query: Record<string, string> = {},
): Promise<any> {
  const router = createAttributionRouter(
    async () => loaded,
    async () => directions,
  );
  const handler = findHandler(router, "GET", "/attribution/impact");
  assert.ok(handler, "GET /attribution/impact handler must be registered");
  const req = mockReq();
  req.url = "/attribution/impact";
  req.query = query;
  const res = mockRes();
  await handler!(req, res);
  return res;
}

describe("GET /api/attribution/impact — reverse-loop impact ranking (#3283)", () => {
  test("ranks producer classes by favorable impact per cost; every row carries posture", async () => {
    const observations: AttributionObservation[] = [];
    for (let i = 1; i <= 6; i++) {
      observations.push(
        obs({ metric: "test_count", delta: 10 * i, classCounts: { hi: i }, tier: 3 }),
      );
      observations.push(
        obs({ metric: "test_count", delta: 1 * i, classCounts: { lo: i }, tier: 3 }),
      );
    }
    observations.push(obs({ metric: "test_count", delta: 0, classCounts: {}, tier: null }));
    observations.push(obs({ metric: "test_count", delta: 0, classCounts: {}, tier: null }));

    const res = await callImpact({ ok: true, observations }, { test_count: "up" });
    assert.equal(res._status, 200);
    assert.equal(res._body.metricCount, 1);
    const classes = res._body.rows.map((r: any) => r.producerClass);
    assert.deepEqual(classes, ["hi", "lo"], "hi outranks lo");
    for (const r of res._body.rows) {
      assert.equal(typeof r.impactPerCost, "number");
      assert.equal(typeof r.favorableImpact, "number");
      assert.equal(typeof r.identifiabilitySuspect, "boolean");
      assert.equal(typeof r.belowNoiseFloor, "boolean");
      assert.ok(Array.isArray(r.contributions));
    }
  });

  test("?topN caps the ranking", async () => {
    const observations: AttributionObservation[] = [];
    for (let i = 1; i <= 6; i++) {
      observations.push(obs({ metric: "m", delta: 10 * i, classCounts: { hi: i }, tier: 3 }));
      observations.push(obs({ metric: "m", delta: 1 * i, classCounts: { lo: i }, tier: 3 }));
    }
    observations.push(obs({ metric: "m", delta: 0, classCounts: {}, tier: null }));
    const res = await callImpact({ ok: true, observations }, { m: "up" }, { topN: "1" });
    assert.equal(res._status, 200);
    assert.equal(res._body.rows.length, 1);
    assert.equal(res._body.rows[0].producerClass, "hi");
  });

  test("an empty ledger → rows:[] , metricCount:0 at 200 (no impact signal yet)", async () => {
    const res = await callImpact({ ok: true, observations: [] });
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { rows: [], metricCount: 0 });
  });

  test("a getObservations() Redis-read failure returns 500 {error}", async () => {
    const res = await callImpact({ ok: false, error: "redis down" });
    assert.equal(res._status, 500);
    assert.equal(res._body.error, "redis down");
    assert.equal(res._body.rows, undefined);
  });

  test("a malformed ?topN is a 400 schema-validation-failed (ADR-0022 query seam)", async () => {
    // The whole query routes through AttributionImpactQuerySchema.safeParse
    // before any named field is read; a non-numeric / negative / fractional
    // topN fails the parse and returns 400, not a silent return-all.
    for (const bad of ["abc", "-1", "1.5"]) {
      const res = await callImpact(
        { ok: true, observations: [] },
        {},
        { topN: bad },
      );
      assert.equal(res._status, 400, `topN=${bad} must 400`);
      assert.equal(res._body.code, "schema-validation-failed");
      assert.ok(Array.isArray(res._body.issues), "issues array present");
      // The ledger read never happened — a schema failure short-circuits.
      assert.equal(res._body.rows, undefined);
    }
  });

  test("an absent ?topN parses to undefined → returns all ranked rows (200)", async () => {
    const observations: AttributionObservation[] = [];
    for (let i = 1; i <= 6; i++) {
      observations.push(obs({ metric: "m", delta: 10 * i, classCounts: { hi: i }, tier: 3 }));
      observations.push(obs({ metric: "m", delta: 1 * i, classCounts: { lo: i }, tier: 3 }));
    }
    observations.push(obs({ metric: "m", delta: 0, classCounts: {}, tier: null }));
    const res = await callImpact({ ok: true, observations }, { m: "up" }, {});
    assert.equal(res._status, 200);
    assert.equal(res._body.rows.length, 2, "no cap → all ranked rows");
  });

  test("missing directions degrade to raw signed β (still 200, still ranked)", async () => {
    const observations: AttributionObservation[] = [];
    for (let i = 1; i <= 6; i++) {
      observations.push(obs({ metric: "m", delta: 10 * i, classCounts: { c: i }, tier: 2 }));
    }
    observations.push(obs({ metric: "m", delta: 0, classCounts: {}, tier: null }));
    // No direction map supplied → the lens uses raw signed β, endpoint still 200.
    const res = await callImpact({ ok: true, observations }, {});
    assert.equal(res._status, 200);
    const c = res._body.rows.find((r: any) => r.producerClass === "c");
    assert.ok(c, "class c ranked");
    assert.equal(c.contributions[0].directed, false, "undirected contribution");
  });
});
