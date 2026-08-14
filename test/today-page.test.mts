/**
 * Regression tests for the ADR-0034 §5.2 trust contract on
 * GET /api/v2/today/decision-queue (issue #4006 — the trust-seam tracer bullet).
 *
 * The trust contract: a list response must carry evidence the lookup actually
 * ran, so a genuine zero-item day is never bit-for-bit identical to a silent
 * total sub-fetch failure. This pins the contract at every layer the bullet
 * touches — the schema, the aggregator, and the route — and specifically
 * regression-locks the INV-8 invariant: an unasserted empty array
 * (sourcesOk:false) does NOT render as an asserted zero (sourcesOk:true,
 * scanned:0).
 *
 * Why server-side only: `usePageItems.js` is a React hook the orchestrator
 * node:test suite cannot import (the dashboard ships no JSX runner and the
 * worktree resolves no `react`). The client's status derivation
 * (sourcesOk:false → unknown; sourcesOk:true && empty → empty) keys
 * mechanically off the fields these tests pin at the HTTP boundary, so the
 * boundary assertion IS the regression lock for the client half.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DecisionQueueResponseSchema } from "../src/schemas/today-page.ts";
import { createTodayPageRouter } from "../src/api/today-page.ts";
import { getDecisionQueue } from "../src/aggregators/decision-queue.ts";
import type { IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function issueRow(over: Partial<IssueRow> & { number: number }): IssueRow {
  return {
    number: over.number,
    title: over.title ?? `Issue #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/issues/${over.number}`,
    createdAt: over.createdAt ?? "",
    labels: over.labels ?? [],
    body: over.body ?? "",
    state: over.state ?? "OPEN",
  };
}

// ---------------------------------------------------------------------------
// Schema — the asserted-emptiness fields are part of the HTTP contract
// ---------------------------------------------------------------------------

describe("DecisionQueueResponseSchema — trust fields", () => {
  test("accepts a valid response with scanned + sourcesOk", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: true,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, true);
  });

  test("accepts an asserted zero: sourcesOk true, scanned 0, items []", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: true,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, true);
  });

  test("accepts an unasserted empty: sourcesOk false, items []", () => {
    // The two empty cases are both valid HTTP — they differ only in the trust
    // evidence. The schema must carry both so the client can tell them apart.
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: false,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, true);
  });

  test("rejects a response missing sourcesOk (unasserted)", () => {
    // A response with no assertion at all is not a valid trust-contract body.
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects a response missing scanned", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      sourcesOk: true,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects a negative scanned count", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: -1,
      sourcesOk: true,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects a non-boolean sourcesOk", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: "yes",
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects an unknown extra field (strict mode)", () => {
    const result = DecisionQueueResponseSchema.safeParse({
      items: [],
      scanned: 0,
      sourcesOk: true,
      generatedAt: "2026-05-26T12:00:00.000Z",
      surprise: true,
    });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// Aggregator — asserted zero vs unasserted empty (INV-8 regression lock)
// ---------------------------------------------------------------------------

describe("getDecisionQueue — asserted-emptiness evidence", () => {
  test("ASSERTED ZERO: all sub-fetches succeed and find nothing → sourcesOk true, scanned 0", async () => {
    const result = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      listIssuesByLabelOrEmpty: async () => [],
    });
    // A genuine zero-item day: the lookup ran cleanly, there is genuinely
    // nothing waiting. The client may render the empty-state message.
    assert.deepEqual(result.items, []);
    assert.equal(result.scanned, 0);
    assert.equal(result.sourcesOk, true);
  });

  test("UNASSERTED EMPTY: all sub-fetches fail → items [] BUT sourcesOk false (INV-8)", async () => {
    // This is the #3997 failure mode: every source rejected, so items is []
    // for a totally different reason than "nothing to show". sourcesOk:false
    // must distinguish it from the asserted zero above — the client renders
    // UNKNOWN, never the empty-state message.
    const result = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("gh blew up");
      },
      listIssuesByLabelOrEmpty: async () => {
        throw new Error("gh blew up");
      },
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.sourcesOk, false);
    // The two empty cases are NOT bit-for-bit identical:
    assert.notEqual(result.sourcesOk, true);
  });

  test("regression: an unasserted empty array is distinguishable from an asserted zero", async () => {
    // The core INV-8 lock — drive both cases and assert they differ on the
    // exact field the client status machine reads.
    const asserted = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [],
      listIssuesByLabelOrEmpty: async () => [],
    });
    const unasserted = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("down");
      },
      listIssuesByLabelOrEmpty: async () => {
        throw new Error("down");
      },
    });
    // Both are empty lists...
    assert.deepEqual(asserted.items, []);
    assert.deepEqual(unasserted.items, []);
    // ...but they MUST disagree on the assertion, so the client renders
    // empty (asserted) vs unknown (unasserted), never conflating them.
    assert.notEqual(asserted.sourcesOk, unasserted.sourcesOk);
    assert.equal(asserted.sourcesOk, true);
    assert.equal(unasserted.sourcesOk, false);
  });

  test("PARTIAL FAILURE: one sub-fetch rejects → sourcesOk false even with items present", async () => {
    // A partially-failed lookup can silently omit real items; only a fully
    // clean lookup may assert completeness. items may still ship (resilience)
    // but sourcesOk must be false so the client demotes to UNKNOWN.
    const result = await getDecisionQueue({
      now: NOW,
      // Search (digest) rejects...
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("digest down");
      },
      // ...but the labeled lists succeed and surface a real item.
      listIssuesByLabelOrEmpty: async (label) =>
        label === "ready-for-human"
          ? [
              issueRow({
                number: 7,
                title: "still here",
                url: "u7",
                createdAt: "2026-05-26T01:00:00.000Z",
                labels: ["ready-for-human"],
              }),
            ]
          : [],
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].number, 7);
    // Resilience shipped the item, but the lookup is NOT trustworthy as a
    // complete picture — sourcesOk stays false.
    assert.equal(result.sourcesOk, false);
  });

  test("scanned counts pre-dedup raw rows, not deduped items", async () => {
    // The same issue surfaced by two sources contributes TWO raw rows to
    // scanned but only ONE item after dedup. scanned proves the lookup
    // touched both sources; items.length is the operator-facing count.
    const shared = issueRow({
      number: 42,
      title: "dup across sources",
      url: "u42",
      createdAt: "2026-05-26T01:00:00.000Z",
      labels: ["ready-for-human"],
    });
    const result = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async () => [], // no digest rows
      listIssuesByLabelOrEmpty: async (label) =>
        label === "ready-for-human" || label === "needs-info" ? [shared] : [],
    });
    assert.equal(result.items.length, 1); // deduped
    assert.equal(result.scanned, 2); // two raw rows (one per label source)
    assert.equal(result.sourcesOk, true);
  });

  test("happy path: items present, sourcesOk true, scanned > 0", async () => {
    const result = await getDecisionQueue({
      now: NOW,
      listIssuesBySearchOrEmpty: async (search) => {
        if (search.includes("Operator decision queue 2026-05-26")) {
          return [
            issueRow({
              number: 999,
              title: "Operator decision queue 2026-05-26",
              body: "Action items: #100",
              createdAt: "2026-05-26T06:00:00.000Z",
            }),
          ];
        }
        return [];
      },
      listIssuesByLabelOrEmpty: async () => [],
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].number, 100);
    assert.equal(result.sourcesOk, true);
    assert.ok(result.scanned >= 1);
  });
});

// ---------------------------------------------------------------------------
// Route — forwards every trust field into the HTTP body
// ---------------------------------------------------------------------------

function mockReq(): any {
  return {
    method: "GET",
    url: "/today/decision-queue",
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
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
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

describe("GET /today/decision-queue — route forwards trust evidence", () => {
  test("forwards items + scanned + sourcesOk + generatedAt from the aggregator", async () => {
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({
        items: [
          {
            number: 5,
            title: "Decide X",
            url: "https://x/5",
            createdAt: "2026-05-26T01:00:00.000Z",
            labels: ["ready-for-human"],
            source: "ready-for-human" as const,
            sources: ["ready-for-human"] as const,
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
    assert.equal(res._body.items.length, 1);
    assert.equal(res._body.scanned, 1);
    assert.equal(res._body.sourcesOk, true);
    // generatedAt is stamped at the route — must be a present ISO string.
    assert.equal(typeof res._body.generatedAt, "string");
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
    // The body round-trips through the schema (the strict contract holds).
    const parsed = DecisionQueueResponseSchema.safeParse(res._body);
    assert.equal(parsed.success, true);
  });

  test("forwards an unasserted empty (sourcesOk false) unchanged — never upgrades it to asserted", async () => {
    // The route must forward the aggregator's verdict verbatim. It must NOT
    // paper over a failed lookup into a confident-looking asserted zero —
    // that is exactly the trust violation ADR-0034 §5.2 forbids.
    const router = createTodayPageRouter({
      getDecisionQueue: async () => ({ items: [], scanned: 0, sourcesOk: false }),
    });
    const handler = findHandler(router, "GET", "/today/decision-queue");
    assert.ok(handler);

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, false);
    assert.equal(res._body.items.length, 0);
  });
});
