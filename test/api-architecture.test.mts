/**
 * test/api-architecture.test.mts — pin the architecture route's response cache
 * (issue #1489).
 *
 * The pure scan moved to src/aggregators/architecture-graph.ts (issue #1411);
 * the route was left owning a module-global `let` cache that no test could reach
 * without resetting module state. #1489 moved that cache into the
 * createArchitectureRouter closure with injectable `scan` + `now` deps, so the
 * TTL behavior is testable hermetically:
 *   - hit: a second request inside the 60s TTL returns the cached graph and does
 *     NOT call the scanner again
 *   - miss: a request after the TTL re-scans
 *   - error: a scanner throw is not cached (the next call retries)
 *
 * No module-state reset — each test builds a fresh router with its own deps.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createArchitectureRouter } from "../src/api/architecture.ts";
import type { ArchitectureGraph } from "../src/aggregators/architecture-graph.ts";

function mockReq(): any {
  return { method: "GET", url: "/architecture", headers: {}, query: {}, params: {}, body: {} };
}
function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
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

// The status overlay is best-effort and swallows its own errors; a publisher
// whose ping rejects exercises the catch arm without affecting the graph body.
const eventBus: any = { publisher: { ping: async () => { throw new Error("no redis"); } } };

function graph(tag: string): ArchitectureGraph {
  return {
    nodes: [{ id: tag } as any],
    edges: [],
    groups: [],
    moduleCount: 1,
    edgeCount: 0,
    scannedAt: "2026-06-09T00:00:00.000Z",
  };
}

describe("GET /api/architecture — closure cache (issue #1489)", () => {
  test("cache hit — second request inside TTL returns cached graph, no re-scan", async () => {
    let scans = 0;
    let clock = 1_000;
    const router = createArchitectureRouter(eventBus, {
      scan: async () => { scans += 1; return graph(`scan-${scans}`); },
      now: () => clock,
    });
    const handler = findHandler(router, "GET", "/architecture")!;
    assert.ok(handler);

    const res1 = mockRes();
    await handler(mockReq(), res1);
    assert.equal(res1._status, 200);
    assert.equal(res1._body.nodes[0].id, "scan-1");

    // Advance the clock but stay inside the 60s TTL.
    clock += 59_000;
    const res2 = mockRes();
    await handler(mockReq(), res2);
    assert.equal(res2._body.nodes[0].id, "scan-1", "served cached graph");
    assert.equal(scans, 1, "scanner not invoked a second time inside TTL");
  });

  test("cache miss — request after TTL re-scans", async () => {
    let scans = 0;
    let clock = 1_000;
    const router = createArchitectureRouter(eventBus, {
      scan: async () => { scans += 1; return graph(`scan-${scans}`); },
      now: () => clock,
    });
    const handler = findHandler(router, "GET", "/architecture")!;

    const res1 = mockRes();
    await handler(mockReq(), res1);
    assert.equal(res1._body.nodes[0].id, "scan-1");

    // Advance past the 60s TTL.
    clock += 60_001;
    const res2 = mockRes();
    await handler(mockReq(), res2);
    assert.equal(res2._body.nodes[0].id, "scan-2", "re-scanned after TTL");
    assert.equal(scans, 2);
  });

  test("scanner error is not cached — a later call retries and succeeds", async () => {
    let scans = 0;
    let clock = 1_000;
    const router = createArchitectureRouter(eventBus, {
      scan: async () => {
        scans += 1;
        if (scans === 1) throw new Error("scan boom");
        return graph(`scan-${scans}`);
      },
      now: () => clock,
    });
    const handler = findHandler(router, "GET", "/architecture")!;

    const res1 = mockRes();
    await handler(mockReq(), res1);
    assert.equal(res1._status, 500, "scanner throw surfaces as 500");
    assert.equal(res1._body.error, "scan boom");

    // No clock advance — if the failure had been cached we'd serve stale; the
    // retry proves the error did not poison the cache.
    const res2 = mockRes();
    await handler(mockReq(), res2);
    assert.equal(res2._status, 200);
    assert.equal(res2._body.nodes[0].id, "scan-2");
    assert.equal(scans, 2);
  });

  test("status overlay is best-effort — graph still returned when redis ping fails", async () => {
    const router = createArchitectureRouter(eventBus, {
      scan: async () => graph("g"),
      now: () => 0,
    });
    const handler = findHandler(router, "GET", "/architecture")!;
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.nodes[0].id, "g");
    assert.equal(res._body.status.redis, false, "ping failure leaves redis=false");
  });
});
