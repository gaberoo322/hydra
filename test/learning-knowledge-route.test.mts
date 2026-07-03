/**
 * Regression tests for `GET /api/learning/knowledge?agent=` (issue #2647).
 *
 * This is the dispatch-served, plan-time knowledge fetch — the CONTENT-serving
 * counterpart to the counts-only `/api/learning/context-trace`. The playbooks
 * (hydra-dev, hydra-target-build) fetch it at planning time; it wraps
 * `loadKnowledgeBaseForPrompt` and is the SINGLE place the #1440 per-cycle
 * `cyclesWithContext` availability metric is recorded (moved OUT of getContext,
 * so a diagnostic context-trace hit no longer pollutes the real-cycle metric).
 *
 * The route accepts an injectable deps bag (`LearningRouterDeps`), so these
 * cases drive the record-on-success invariant deterministically with NO live
 * OpenViking / Redis connection — every dependency is a stub. This is a NEW
 * top-level describe with its own server lifecycle (no shared-Redis teardown),
 * per the CLAUDE.md authoring rule.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

const { createLearningRouter } = await import("../src/api/learning.ts");

/** Spin up an express app mounting the learning router with the given deps. */
async function startApi(deps: any): Promise<{ server: any; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use("/api", createLearningRouter(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("GET /api/learning/knowledge (#2647 dispatch-served plan-time fetch)", () => {
  // Capture what the availability record was called with across cases.
  const recordCalls: boolean[] = [];
  // Issue #2717: capture every ledger row appended across cases.
  const ledgerRows: any[] = [];
  let server: any;
  let baseUrl: string;

  before(async () => {
    const started = await startApi({
      loadKnowledgeBaseForPrompt: async (agent: string) => {
        // A non-empty result for a specific agent, an empty (miss) result for
        // another, and a throw for a third — driven by the agent name so each
        // case selects its scenario. Issue #2717: the load now also returns
        // `itemIds` (derived from source DATA at the ov-search seam), so the
        // stubs return them here — the route no longer re-derives ids.
        if (agent === "hydra-dev") {
          return {
            content: `# ${agent} — Learned Patterns\n- always symlink node_modules`,
            itemCount: 2,
            itemIds: ["id-a1b2c3", "id-d4e5f6"],
          };
        }
        if (agent === "empty-agent") {
          return { content: "", itemCount: 0, itemIds: [] };
        }
        if (agent === "boom-agent") {
          throw new Error("OV unreachable");
        }
        if (agent === "record-fails-agent") {
          return { content: "# something", itemCount: 1, itemIds: ["id-only"] };
        }
        return { content: "", itemCount: 0, itemIds: [] };
      },
      recordKnowledgeContextAvailability: async (hadContext: boolean) => {
        // The record-fails path is exercised by having the record throw ONLY
        // for the record-fails scenario; we detect that scenario by a sentinel
        // pushed just before the fetch in that test.
        recordCalls.push(hadContext);
        if ((globalThis as any).__forceRecordThrow) {
          throw new Error("Redis down");
        }
      },
      appendKnowledgeFetch: async (row: any) => {
        ledgerRows.push(row);
        if ((globalThis as any).__forceLedgerThrow) {
          throw new Error("Redis down (ledger)");
        }
      },
    });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a non-empty result serves content AND records availability=true", async () => {
    recordCalls.length = 0;
    ledgerRows.length = 0;
    const res = await fetch(`${baseUrl}/api/learning/knowledge?agent=hydra-dev`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.agent, "hydra-dev");
    assert.equal(body.itemCount, 2);
    assert.ok(body.content.includes("always symlink node_modules"), "serves real content, not counts-only");
    // The metric was recorded exactly once, with hadContext=true.
    assert.deepEqual(recordCalls, [true], "a non-empty fetch records cyclesWithContext (hadContext=true)");
    // Issue #2717: exactly one ledger row appended, carrying the join key + item ids.
    assert.equal(ledgerRows.length, 1, "a served fetch appends exactly one ledger row");
    assert.equal(ledgerRows[0].agent, "hydra-dev");
    assert.equal(ledgerRows[0].itemCount, 2);
    assert.equal(ledgerRows[0].anchor, null, "no anchor param ⇒ null anchor recorded");
    assert.ok(typeof ledgerRows[0].ts === "number" && ledgerRows[0].ts > 0, "row carries an epoch timestamp");
    // The item ids come straight from the load result (derived at the ov-search
    // seam from source DATA — the #804 count-from-data contract), NOT re-derived
    // at the route.
    assert.deepEqual(ledgerRows[0].itemIds, ["id-a1b2c3", "id-d4e5f6"], "records the per-item ids from the load result");
  });

  test("#2717: an anchor query param is recorded as the ledger join key", async () => {
    recordCalls.length = 0;
    ledgerRows.length = 0;
    const res = await fetch(`${baseUrl}/api/learning/knowledge?agent=hydra-dev&anchor=issue-2717`);
    assert.equal(res.status, 200);
    assert.equal(ledgerRows.length, 1);
    assert.equal(ledgerRows[0].anchor, "issue-2717", "the anchor param is recorded as the join key");
  });

  test("an empty (miss) result still records availability=false — a served fetch counts toward cyclesTotal", async () => {
    recordCalls.length = 0;
    ledgerRows.length = 0;
    const res = await fetch(`${baseUrl}/api/learning/knowledge?agent=empty-agent`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.itemCount, 0);
    assert.equal(body.content, "", "a miss serves an empty content the dispatch no-ops over");
    assert.deepEqual(recordCalls, [false], "a served-but-empty fetch records hadContext=false (cyclesTotal only)");
    // Issue #2717: a miss STILL appends one row (itemCount 0, no ids) so the ledger
    // denominator stays honest.
    assert.equal(ledgerRows.length, 1, "a served-but-empty fetch still appends one ledger row");
    assert.equal(ledgerRows[0].itemCount, 0);
    assert.deepEqual(ledgerRows[0].itemIds, [], "an empty result carries no item ids");
  });

  test("a blank/absent agent param is a 400 and records NOTHING", async () => {
    recordCalls.length = 0;
    ledgerRows.length = 0;
    const blank = await fetch(`${baseUrl}/api/learning/knowledge?agent=${encodeURIComponent("   ")}`);
    assert.equal(blank.status, 400);
    const absent = await fetch(`${baseUrl}/api/learning/knowledge`);
    assert.equal(absent.status, 400);
    // The record fires ONLY on a served fetch — a validation rejection must not
    // move the metric (invariant: record only on dispatch-served fetch).
    assert.deepEqual(recordCalls, [], "a 400 never records availability");
    // Issue #2717: a 400 never appends a ledger row either.
    assert.deepEqual(ledgerRows, [], "a 400 never appends a ledger row");
  });

  test("a knowledge-load failure 500s and records NOTHING (record is on the success path)", async () => {
    recordCalls.length = 0;
    ledgerRows.length = 0;
    const res = await fetch(`${baseUrl}/api/learning/knowledge?agent=boom-agent`);
    assert.equal(res.status, 500);
    assert.deepEqual(recordCalls, [], "a failed fetch never records — the record is co-located with a served fetch");
    // Issue #2717: a 500 appends nothing (the append is on the success path).
    assert.deepEqual(ledgerRows, [], "a 500 never appends a ledger row");
  });

  test("a Redis error in the availability record is swallowed — the fetch still serves 200 (never-throw)", async () => {
    recordCalls.length = 0;
    ledgerRows.length = 0;
    (globalThis as any).__forceRecordThrow = true;
    try {
      const res = await fetch(`${baseUrl}/api/learning/knowledge?agent=record-fails-agent`);
      // The record threw, but the plan-time fetch must not fail over it.
      assert.equal(res.status, 200, "a Redis record error must never break the dispatch fetch");
      const body = await res.json();
      assert.equal(body.itemCount, 1);
      assert.deepEqual(recordCalls, [true], "the record was attempted (with hadContext=true) before it threw");
    } finally {
      delete (globalThis as any).__forceRecordThrow;
    }
  });

  test("#2717: a Redis error in the ledger append is swallowed — the fetch still serves 200 (never-throw)", async () => {
    recordCalls.length = 0;
    ledgerRows.length = 0;
    (globalThis as any).__forceLedgerThrow = true;
    try {
      const res = await fetch(`${baseUrl}/api/learning/knowledge?agent=hydra-dev`);
      assert.equal(res.status, 200, "a ledger Redis error must never break the dispatch fetch");
      const body = await res.json();
      assert.equal(body.itemCount, 2, "content is still served despite the ledger failure");
      assert.equal(ledgerRows.length, 1, "the ledger append was attempted before it threw");
    } finally {
      delete (globalThis as any).__forceLedgerThrow;
    }
  });
});
