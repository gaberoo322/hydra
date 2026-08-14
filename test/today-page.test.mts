/**
 * Regression tests for the ADR-0034 §5 trust-contract tracer bullet on the
 * decision-queue seam (issue #4006).
 *
 * Three layers, each pinning one rung of the contract end to end:
 *
 *   1. Schema — `DecisionQueueResponseSchema` now REQUIRES the asserted-
 *      emptiness evidence (`scanned`, `sourcesOk`), so a response can no longer
 *      be bit-for-bit identical to a genuine zero-item response when every
 *      sub-fetch failed (the `/cycle/history` #3997 class).
 *   2. Route  — `GET /today/decision-queue` forwards the aggregator's evidence
 *      unchanged; it never synthesises a confident `sourcesOk: true`.
 *   3. Client — the pure `deriveItemStatus` priority ladder, including the
 *      load-bearing regression: an UNASSERTED empty array (sourcesOk:false)
 *      resolves to `unknown`, never `empty`, while an ASSERTED zero
 *      (sourcesOk:true) still resolves to `empty`. This is the acceptance
 *      criterion that pins the two apart.
 *
 * The client ladder is asserted at the pure `page-item-format.ts` seam because
 * the dashboard ships no JSX test runner — load-bearing logic lives in `.ts`
 * and is pinned from this orchestrator node:test suite.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DecisionQueueResponseSchema } from "../src/schemas/today-page.ts";
import { createTodayPageRouter } from "../src/api/today-page.ts";
import {
  deriveItemStatus,
  DEFAULT_FRESHNESS_MS,
} from "../dashboard/src/lib/page-item-format.ts";

// ---------------------------------------------------------------------------
// Helpers — mock req/res + router handler lookup (api-today-summary pattern)
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/today/decision-queue", headers: {}, query, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
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

// A fixed "now" so the freshness-budget cases are deterministic.
const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString(); // 1 min ago — within any budget
const FIVE_MIN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. Schema — asserted-emptiness evidence is required
// ---------------------------------------------------------------------------

describe("DecisionQueueResponseSchema — asserted-emptiness evidence", () => {
  test("accepts a valid response carrying scanned + sourcesOk", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [
        {
          number: 42,
          title: "Decide something",
          url: "https://x/42",
          createdAt: "2026-08-13T01:00:00.000Z",
          labels: ["ready-for-human"],
          source: "ready-for-human",
          sources: ["ready-for-human"],
        },
      ],
      scanned: 1,
      sourcesOk: true,
      generatedAt: FRESH,
    });
    assert.equal(result.success, true);
  });

  test("accepts an ASSERTED zero (sourcesOk:true, scanned:0, items:[])", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: true,
      generatedAt: FRESH,
    });
    assert.equal(result.success, true);
  });

  test("REJECTS the legacy shape (no scanned) — evidence cannot be silently dropped", () => {
    // This is the regression: before #4006 the response was `{ items,
    // generatedAt }`. A total sub-fetch failure and a genuine zero were
    // bit-for-bit identical in that shape. Strict parse must now reject it.
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      generatedAt: FRESH,
    });
    assert.equal(result.success, false);
  });

  test("REJECTS a response missing sourcesOk", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      generatedAt: FRESH,
    });
    assert.equal(result.success, false);
  });

  test("rejects a negative scanned count", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: -1,
      sourcesOk: true,
      generatedAt: FRESH,
    });
    assert.equal(result.success, false);
  });

  test("rejects a non-boolean sourcesOk", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: "yes",
      generatedAt: FRESH,
    });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Route handler — evidence is forwarded, never synthesised
// ---------------------------------------------------------------------------

describe("GET /today/decision-queue — route forwards lookup evidence", () => {
  test("happy path: items + scanned + sourcesOk plumb through with generatedAt", async () => {
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({
        items: [
          {
            number: 7,
            title: "Act on this",
            url: "https://x/7",
            createdAt: "2026-08-13T01:00:00.000Z",
            labels: ["ready-for-human"],
            source: "ready-for-human",
            sources: ["ready-for-human"],
          },
        ],
        scanned: 1,
        sourcesOk: true,
      }),
    });
    const handler = findHandler(router, "GET", "/today/decision-queue");
    assert.ok(handler);

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.scanned, 1);
    assert.equal(res._body.sourcesOk, true);
    assert.equal(res._body.items.length, 1);
    assert.equal(typeof res._body.generatedAt, "string");
  });

  test("an ASSERTED zero forwards sourcesOk:true + scanned:0", async () => {
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({ items: [], scanned: 0, sourcesOk: true }),
    });
    const handler = findHandler(router, "GET", "/today/decision-queue");
    assert.ok(handler);

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, true);
    assert.equal(res._body.scanned, 0);
    assert.deepEqual(res._body.items, []);
  });

  test("a total sub-fetch failure forwards sourcesOk:false — never synthesised true", async () => {
    // INV-3: the route must not paper a failed lookup over as a confident
    // zero. sourcesOk:false arrives from the aggregator and is forwarded
    // verbatim so the client can demote to UNKNOWN.
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({ items: [], scanned: 0, sourcesOk: false }),
    });
    const handler = findHandler(router, "GET", "/today/decision-queue");
    assert.ok(handler);

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, false);
    // And the two failure shapes are NOT bit-for-bit identical: a genuine
    // zero carries sourcesOk:true (above), a failure carries sourcesOk:false.
  });
});

// ---------------------------------------------------------------------------
// 3. deriveItemStatus — the client trust-contract priority ladder
// ---------------------------------------------------------------------------

describe("deriveItemStatus — the unasserted-empty vs asserted-zero regression", () => {
  // THE acceptance criterion #7: an unasserted empty array does not render as
  // an asserted zero. Both cases below have items:[], but they MUST resolve to
  // different statuses — the sole difference is the sourcesOk assertion.
  test("an UNASSERTED empty array (sourcesOk:false) is 'unknown', NOT 'empty'", () => {
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [],
      generatedAt: FRESH,
      sourcesOk: false,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "unknown");
  });

  test("an ASSERTED zero (sourcesOk:true) is still 'empty'", () => {
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [],
      generatedAt: FRESH,
      sourcesOk: true,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "empty");
  });

  test("a sourcesOk:false lookup is 'unknown' even when items is non-empty (partial result)", () => {
    // A partially-failed lookup can return SOME items but is not trustworthy
    // as a complete list — demote to unknown rather than rendering a confident
    // (possibly-incomplete) list.
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [{ number: 1 }],
      generatedAt: FRESH,
      sourcesOk: false,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "unknown");
  });
});

describe("deriveItemStatus — freshness budget (stale)", () => {
  test("payload older than freshnessMs is 'stale'", () => {
    const staleGeneratedAt = new Date(NOW - FIVE_MIN_MS - 60_000).toISOString(); // 6 min ago
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [{ number: 1 }],
      generatedAt: staleGeneratedAt,
      sourcesOk: true,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "stale");
  });

  test("stale wins over empty: an aged empty payload is 'stale', not 'empty'", () => {
    // The emptiness itself may be a stale artifact, so the age verdict takes
    // priority — do not render a confident "inbox zero" on aged data.
    const staleGeneratedAt = new Date(NOW - FIVE_MIN_MS - 60_000).toISOString();
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [],
      generatedAt: staleGeneratedAt,
      sourcesOk: true,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "stale");
  });

  test("a fresh payload within budget is 'ready' (when items present)", () => {
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [{ number: 1 }],
      generatedAt: FRESH,
      sourcesOk: true,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "ready");
  });
});

describe("deriveItemStatus — unknown: missing timestamp / fetch failure", () => {
  test("missing generatedAt is 'unknown'", () => {
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [],
      generatedAt: undefined,
      sourcesOk: true,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "unknown");
  });

  test("unparseable generatedAt is 'unknown'", () => {
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [],
      generatedAt: "not-a-timestamp",
      sourcesOk: true,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "unknown");
  });

  test("a first-load fetch failure with no prior data is 'unknown'", () => {
    const status = deriveItemStatus({
      loading: false,
      error: "500: boom",
      items: [],
      generatedAt: undefined,
      sourcesOk: undefined,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "unknown");
  });

  test("a refresh failure WITH retained prior data is 'stale' (context, not unknown)", () => {
    // useApi retains the last good payload on a failed refresh; that retained
    // value is shown as stale context, never in the position a current value
    // would occupy (ADR-0034 §5.1).
    const status = deriveItemStatus({
      loading: false,
      error: "500: boom",
      items: [{ number: 1 }],
      generatedAt: FRESH,
      sourcesOk: true,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "stale");
  });
});

describe("deriveItemStatus — legacy endpoints + loading", () => {
  test("a legacy endpoint (sourcesOk undefined) with zero items is 'empty' — no regression", () => {
    // Endpoints not yet migrated to the asserted-emptiness contract (only the
    // decision-queue seam asserts in this slice) keep their legacy emptiness
    // semantics rather than being forced to unknown.
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [],
      generatedAt: FRESH,
      sourcesOk: undefined,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "empty");
  });

  test("a legacy endpoint with items + fresh payload is 'ready'", () => {
    const status = deriveItemStatus({
      loading: false,
      error: null,
      items: [{ number: 1 }],
      generatedAt: FRESH,
      sourcesOk: undefined,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "ready");
  });

  test("loading is 'loading' regardless of other fields", () => {
    const status = deriveItemStatus({
      loading: true,
      error: null,
      items: [],
      generatedAt: FRESH,
      sourcesOk: false,
      freshnessMs: FIVE_MIN_MS,
      now: NOW,
    });
    assert.equal(status, "loading");
  });
});

test("DEFAULT_FRESHNESS_MS is the ADR-0034 activity tier (~1h), not infinite", () => {
  // A forgotten budget must never mean "always fresh" — the default is finite
  // so legitimately-stale data cannot pass as current.
  assert.equal(DEFAULT_FRESHNESS_MS, 60 * 60 * 1000);
  assert.ok(Number.isFinite(DEFAULT_FRESHNESS_MS));
});
