/**
 * Regression tests for the ADR-0034 trust-contract tracer bullet (issue #4006).
 *
 * This slice is the smallest change that exercises every layer of the trust
 * contract on one real endpoint, GET /api/today/decision-queue:
 *
 *   - SERVER: the route returns evidence the lookup actually ran (`scanned` +
 *     `sourcesOk`) alongside `generatedAt`, so a total sub-fetch failure is
 *     never silently identical to a genuine zero-item day (the #3997 failure
 *     mode ADR-0034 §5 rule 2 exists to close).
 *   - CLIENT: the `derivePageStatus` seam resolves the payload to a trust-aware
 *     status — an unasserted empty (`sourcesOk: false`) is `unknown`, never
 *     `empty`; an aged payload is `stale`; a payload with no timestamp is
 *     `unknown`.
 *
 * The dashboard ships no JSX test runner, so the load-bearing client logic
 * lives in the pure `lib/page-item-format.ts` seam (`derivePageStatus`) and is
 * pinned here directly — including the headline regression: an unasserted empty
 * array does not resolve as an asserted zero. The <Section> render that consumes
 * the status is the untested JSX presenter, consistent with the repo convention.
 *
 * Follows the patterns from test/api-today-summary.test.mts (mock-req/mock-res
 * over a stubbed router) and test/aggregator-decision-queue.test.mts (stubbed
 * GitHub seam readers).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DecisionQueueResponseSchema } from "../src/schemas/today-page.ts";
import { createTodayPageRouter } from "../src/api/today-page.ts";
import { getDecisionQueue } from "../src/aggregators/decision-queue.ts";
import { derivePageStatus } from "../dashboard/src/lib/page-item-format.ts";

// ---------------------------------------------------------------------------
// Schema — asserted-emptiness is a hard contract field, not optional
// ---------------------------------------------------------------------------

describe("DecisionQueueResponseSchema — asserted-emptiness contract", () => {
  test("accepts a fully-evidenced response (asserted zero)", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: true,
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    assert.equal(result.success, true);
  });

  test("accepts an unasserted response (sourcesOk false) — the client tells them apart", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: false,
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    assert.equal(result.success, true);
  });

  test("rejects a response missing scanned (evidence can't silently vanish)", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      sourcesOk: true,
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects a response missing sourcesOk (the assertion field is mandatory)", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects a non-boolean sourcesOk", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: "yes",
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects a negative scanned (a row count can't be negative)", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: -1,
      sourcesOk: true,
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects unknown fields (strict mode)", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: true,
      generatedAt: "2026-08-13T12:00:00.000Z",
      extra: "sneaky",
    });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// Route handler — forwards scanned + sourcesOk end to end
// ---------------------------------------------------------------------------

function mockReq(): any {
  return { method: "GET", url: "/today/decision-queue", headers: {}, query: {}, params: {}, body: {} };
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

describe("GET /today/decision-queue — asserted-emptiness forwarding", () => {
  test("forwards scanned + sourcesOk alongside generatedAt (asserted zero)", async () => {
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({ items: [], scanned: 0, sourcesOk: true }),
    });
    const handler = findHandler(router, "GET", "/today/decision-queue");
    assert.ok(handler);

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.scanned, 0);
    assert.equal(res._body.sourcesOk, true);
    assert.deepEqual(res._body.items, []);
    assert.equal(typeof res._body.generatedAt, "string");
    // The body honours the schema contract.
    assert.equal(DecisionQueueResponseSchema.safeParse(res._body).success, true);
  });

  test("forwards an unasserted response distinctly (sourcesOk false) — the #3997 regression", async () => {
    // A total sub-fetch failure must NOT look byte-identical to a genuine zero.
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({ items: [], scanned: 0, sourcesOk: false }),
    });
    const handler = findHandler(router, "GET", "/today/decision-queue");
    assert.ok(handler);

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, false);
    assert.equal(res._body.scanned, 0);
    // The two responses differ ONLY on sourcesOk — the field the client uses
    // to pick UNKNOWN vs the empty-state message.
    assert.notEqual(res._body.sourcesOk, true);
  });

  test("forwards non-zero scanned with items", async () => {
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({
        items: [
          {
            number: 42,
            title: "Decide thing",
            url: "https://x/42",
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
    assert.equal(res._body.items.length, 1);
    assert.equal(DecisionQueueResponseSchema.safeParse(res._body).success, true);
  });

  test("aggregator throwing surfaces as 500 (defensive — never-throw contract)", async () => {
    const router = createTodayPageRouter({
      getDecisionQueue: async () => {
        throw new Error("simulated failure");
      },
    });
    const handler = findHandler(router, "GET", "/today/decision-queue");
    assert.ok(handler);

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 500);
    assert.equal(typeof res._body.error, "string");
  });
});

// ---------------------------------------------------------------------------
// Aggregator — sourcesOk distinguishes a real zero from a failed lookup
// ---------------------------------------------------------------------------

describe("getDecisionQueue — asserted-emptiness evidence", () => {
  test("all sub-fetches succeed with no rows -> asserted zero (sourcesOk true, scanned 0)", async () => {
    const result = await getDecisionQueue({
      now: new Date("2026-08-13T12:00:00.000Z"),
      listIssuesBySearchOrEmpty: async () => [],
      listIssuesByLabelOrEmpty: async () => [],
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.scanned, 0);
    assert.equal(result.sourcesOk, true);
  });

  test("all sub-fetches fail -> unasserted (sourcesOk false) — NOT an asserted zero", async () => {
    const result = await getDecisionQueue({
      now: new Date("2026-08-13T12:00:00.000Z"),
      // Model the harder failure: the readers reject (the OrEmpty seam normally
      // degrades to []; this proves sourcesOk tracks it).
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("gh blew up");
      },
      listIssuesByLabelOrEmpty: async () => {
        throw new Error("gh blew up");
      },
    });
    assert.deepEqual(result.items, []);
    // The two empty cases are identical on items BUT differ on sourcesOk —
    // the whole point of the contract.
    assert.equal(result.sourcesOk, false);
    assert.notEqual(result.sourcesOk, true);
  });

  test("partial failure -> sourcesOk false, scanned counts only fulfilled rows", async () => {
    const result = await getDecisionQueue({
      now: new Date("2026-08-13T12:00:00.000Z"),
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("digest down");
      },
      listIssuesByLabelOrEmpty: async (label) =>
        label === "ready-for-human"
          ? [
              {
                number: 7,
                title: "still here",
                url: "u7",
                createdAt: "2026-08-13T01:00:00.000Z",
                labels: ["ready-for-human"],
                body: "",
                state: "OPEN",
              },
            ]
          : [],
    });
    assert.equal(result.sourcesOk, false);
    // Only the fulfilled ready-for-human source contributed rows.
    assert.equal(result.scanned, 1);
    assert.equal(result.items.length, 1);
  });
});

// ---------------------------------------------------------------------------
// derivePageStatus — the trust-aware status priority order
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-08-13T12:00:00.000Z");
const FRESH_AT = "2026-08-13T11:59:30.000Z"; // 30s before NOW
const AGED_AT = "2026-08-13T11:00:00.000Z"; // 1h before NOW
const FRESHNESS = 5 * 60 * 1000; // 5 minutes

describe("derivePageStatus — headline regression: unasserted vs asserted empty", () => {
  test("an unasserted empty array (sourcesOk false) is UNKNOWN, never empty", () => {
    // This is the regression the slice exists to pin: before the contract,
    // items:[] rendered as an asserted zero regardless of whether the lookup
    // actually ran. sourcesOk:false must demote to unknown BEFORE the emptiness
    // check (rule 3 before rule 7).
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [], scanned: 0, sourcesOk: false, generatedAt: FRESH_AT },
      items: [],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "unknown");
  });

  test("an asserted zero (sourcesOk true, scanned 0) is still empty", () => {
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [], scanned: 0, sourcesOk: true, generatedAt: FRESH_AT },
      items: [],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "empty");
  });

  test("an unproven lookup with non-empty items is still UNKNOWN (partial result untrusted)", () => {
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: {
        items: [{ number: 1 }],
        scanned: 1,
        sourcesOk: false,
        generatedAt: FRESH_AT,
      },
      items: [{ number: 1 }],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "unknown");
  });
});

describe("derivePageStatus — stale + unknown rules", () => {
  test("loading wins over everything", () => {
    const status = derivePageStatus({
      loading: true,
      error: "boom",
      data: null,
      items: [],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "loading");
  });

  test("first-load failure with no data is unknown", () => {
    const status = derivePageStatus({
      loading: false,
      error: "fetch failed",
      data: null,
      items: [],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "unknown");
  });

  test("failed refresh with retained data is stale (last-known as context)", () => {
    const status = derivePageStatus({
      loading: false,
      error: "fetch failed",
      data: { items: [{ number: 1 }], scanned: 1, sourcesOk: true, generatedAt: FRESH_AT },
      items: [{ number: 1 }],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "stale");
  });

  test("payload with no generatedAt is unknown (no trustworthy timestamp)", () => {
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [{ number: 1 }], scanned: 1, sourcesOk: true },
      items: [{ number: 1 }],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "unknown");
  });

  test("payload with an unparseable generatedAt is unknown", () => {
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [{ number: 1 }], scanned: 1, sourcesOk: true, generatedAt: "not-a-date" },
      items: [{ number: 1 }],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "unknown");
  });

  test("generatedAt older than freshnessMs is stale", () => {
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [{ number: 1 }], scanned: 1, sourcesOk: true, generatedAt: AGED_AT },
      items: [{ number: 1 }],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "stale");
  });

  test("fresh payload with items is ready", () => {
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [{ number: 1 }], scanned: 1, sourcesOk: true, generatedAt: FRESH_AT },
      items: [{ number: 1 }],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "ready");
  });
});

describe("derivePageStatus — backward compatibility (endpoints not yet migrated)", () => {
  test("no sourcesOk field + empty items is empty (RecentMerges path)", () => {
    // Endpoints that don't yet assert must keep their existing empty behaviour.
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [], generatedAt: FRESH_AT },
      items: [],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "empty");
  });

  test("no sourcesOk field + items is ready", () => {
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [{ number: 1 }], generatedAt: FRESH_AT },
      items: [{ number: 1 }],
      freshnessMs: FRESHNESS,
      now: NOW_MS,
    });
    assert.equal(status, "ready");
  });

  test("freshnessMs 0 (not declared) skips the age check even for an aged payload", () => {
    // A caller that hasn't declared a budget never goes stale by age alone.
    const status = derivePageStatus({
      loading: false,
      error: null,
      data: { items: [{ number: 1 }], generatedAt: AGED_AT },
      items: [{ number: 1 }],
      freshnessMs: 0,
      now: NOW_MS,
    });
    assert.equal(status, "ready");
  });
});
