/**
 * Regression tests for the /api/agents/stream correlation endpoint —
 * issue #531.
 *
 * Background. PR #528 (closes #527) stamped a deterministic correlation
 * token `worktree-agent-<runtoken>-t<turn>-<slot>` onto every dispatch
 * action emitted by `scripts/autopilot/decide.py`, so the dashboard's
 * "Watch stream →" cross-link could generate
 * `/agents/stream?agent=<token>` hrefs. The producer-side stamp was
 * covered by `test/autopilot-decide.test.mts`; the join-side round-trip
 * through `fetchTurnsWithJoins` was covered by
 * `test/autopilot-history.test.mts` (AC11). But end-to-end resolution from
 * the *backend* — given a stamped token, can the orchestrator find the
 * dispatch? — was never wired. The Codex-SDK-era publisher of the
 * `agent:stream` WebSocket frames had been deleted in PR #400, so the
 * cross-link rendered a structurally-correct href that resolved to an
 * empty page.
 *
 * This test exercises the new `GET /api/agents/stream?agent=<token>`
 * endpoint added in `src/api/agents.ts`, which scans recent autopilot run
 * turns for a matching dispatch action.
 *
 * Asserted behaviour (the issue's AC):
 *   AC1 — A stamped `worktreeBranch` on a freshly-dispatched slot resolves
 *         end-to-end via the endpoint (the "non-empty result" requirement).
 *   AC2 — The matched response carries the dispatch action AND the joined
 *         cycle outcome (so the AgentStream consumer can render it).
 *   AC3 — Unknown / never-stamped tokens return 404 with a structured body
 *         rather than a misleading 200.
 *   AC4 — Empty autopilot history returns 404, not 500.
 *   AC5 — Missing `?agent=` returns 400 — correlation-only endpoint.
 *   AC6 — A stamp that lives only on a NON-dispatch action (e.g. a
 *         hypothetical future action type that carries a worktreeBranch
 *         field) does NOT resolve. Only dispatch actions count, matching
 *         the dashboard's mental model.
 *   AC7 — When multiple runs contain a dispatch with the same stamp
 *         (collision case — unusual but possible if runtoken collides),
 *         the most-recent run wins. This mirrors the reverse-chronological
 *         scan order of the autopilot runs index.
 *   AC8 — When the cycle hash isn't recorded yet (Phase 5 of the autopilot
 *         lifecycle, before Phase 6 fires `POST /autopilot/cycle-record`),
 *         the endpoint still resolves the dispatch but reports
 *         `outcome: null`. This is the load-bearing "freshly dispatched
 *         slot" case the issue's AC4 calls out — the click must work
 *         BEFORE the subagent finishes.
 *
 * Uses Redis DB 1 — never touches production. File-level after() closes
 * the Redis client per PR #518 lesson.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:autopilot:*");
  if (keys.length > 0) await redis.del(...keys);
  const cycKeys = await redis.keys("hydra:cycle:*");
  if (cycKeys.length > 0) await redis.del(...cycKeys);
}

function mockReq(query: any = {}): any {
  return { method: "GET", url: "/", headers: {}, params: {}, query, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
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

async function seedRunRow(
  runId: string,
  fields: Record<string, string | number>,
): Promise<void> {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    flat.push(k, String(v));
  }
  await redis.hset(`hydra:autopilot:run:${runId}`, ...flat);
  const startedEpoch = Number(fields.started_epoch || Math.floor(Date.now() / 1000));
  await redis.zadd("hydra:autopilot:runs:index", startedEpoch, runId);
}

async function seedTurn(
  runId: string,
  turnN: number,
  actions: any[],
): Promise<void> {
  const member = JSON.stringify({
    turn_n: turnN,
    epoch: Math.floor(Date.now() / 1000),
    actions,
    reasons: [],
    slots_snapshot: {},
    signals_snapshot: {},
    tokens_after: 0,
    idle_turns: 0,
  });
  await redis.zadd(`hydra:autopilot:run:${runId}:turns`, turnN, member);
}

async function seedCycle(
  cycleId: string,
  fields: Record<string, string | number>,
): Promise<void> {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    flat.push(k, String(v));
  }
  await redis.hset(`hydra:cycle:${cycleId}`, ...flat);
}

describe("agent stream correlation API (issue #531)", () => {
  let createAgentsRouter: any;
  let streamHandler: Function | null;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createAgentsRouter) {
      const mod = await import("../src/api/agents.ts");
      createAgentsRouter = mod.createAgentsRouter;
    }
    const router = createAgentsRouter();
    streamHandler = findHandler(router, "GET", "/agents/stream");
    assert.ok(streamHandler, "GET /agents/stream handler should exist");
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // AC1 + AC2 — end-to-end resolution of a freshly-dispatched slot.
  // ---------------------------------------------------------------------------
  test("AC1+AC2: stamped worktreeBranch on a freshly-dispatched slot resolves to dispatch + cycle outcome", async () => {
    const stamped = "worktree-agent-abcdef12-t3-dev_orch";

    await seedRunRow("run-531-ac1", {
      run_id: "run-531-ac1",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "running",
      trigger: "manual",
      pid: 1, // init pid — process.kill(1,0) returns EPERM → counted "alive"
      turns: 3,
      dispatches: 1,
      cumulative_tokens: 0,
      last_heartbeat_epoch: 1747648900,
    });

    await seedCycle("cyc-531-ac1", {
      status: "merged",
      startedAt: "2026-05-19T10:01:00Z",
      completedAt: "2026-05-19T10:05:00Z",
      prNumber: "531",
      costUsd: "0.42",
    });

    await seedTurn("run-531-ac1", 3, [
      {
        type: "dispatch",
        skill: "hydra-dev",
        cycleId: "cyc-531-ac1",
        worktreeBranch: stamped,
        prompt_args: { anchor: "issue-531" },
      },
    ]);

    const res = mockRes();
    await streamHandler!(mockReq({ agent: stamped }), res);

    assert.equal(res._status, 200, "freshly-dispatched stamp must resolve (non-empty result)");
    assert.equal(res._body.agent, stamped);
    assert.equal(res._body.resolved, true);
    assert.equal(res._body.runId, "run-531-ac1");
    assert.equal(res._body.turnN, 3);

    assert.equal(res._body.dispatch.type, "dispatch");
    assert.equal(
      res._body.dispatch.worktreeBranch,
      stamped,
      "dispatch action carries the stamped branch verbatim",
    );

    // The cycle join surfaces the outcome — same shape the dashboard reads.
    assert.ok(res._body.outcome, "outcome populated when cycle hash exists");
    assert.equal(res._body.outcome.status, "merged");
    assert.equal(res._body.outcome.cycleId, "cyc-531-ac1");
    assert.equal(res._body.outcome.prNumber, "531");
    assert.equal(res._body.outcome.costUsd, 0.42);
  });

  // ---------------------------------------------------------------------------
  // AC3 — unknown token returns 404 with structured body, not 200 (which
  // would mislead the dashboard into rendering a phantom "matched" panel).
  // ---------------------------------------------------------------------------
  test("AC3: unknown stamped token returns 404 with structured body", async () => {
    await seedRunRow("run-531-ac3", {
      run_id: "run-531-ac3",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "ended",
      turns: 1,
      dispatches: 1,
    });
    await seedTurn("run-531-ac3", 1, [
      {
        type: "dispatch",
        worktreeBranch: "worktree-agent-aaaaaaaa-t1-dev_orch",
      },
    ]);

    const res = mockRes();
    await streamHandler!(
      mockReq({ agent: "worktree-agent-deadbeef-t1-dev_orch" }),
      res,
    );

    assert.equal(res._status, 404);
    assert.equal(res._body.resolved, false);
    assert.equal(res._body.agent, "worktree-agent-deadbeef-t1-dev_orch");
    assert.ok(
      typeof res._body.reason === "string" && res._body.reason.length > 0,
      "404 body carries a human-readable reason",
    );
  });

  // ---------------------------------------------------------------------------
  // AC4 — empty autopilot history returns 404 (not 500). Common on a
  // fresh-deploy environment before bootstrap.sh has fired.
  // ---------------------------------------------------------------------------
  test("AC4: empty autopilot history returns 404 (not 500)", async () => {
    const res = mockRes();
    await streamHandler!(
      mockReq({ agent: "worktree-agent-foo-t1-dev_orch" }),
      res,
    );
    assert.equal(res._status, 404);
    assert.equal(res._body.resolved, false);
  });

  // ---------------------------------------------------------------------------
  // AC5 — missing ?agent= returns 400. Correlation-only endpoint.
  // ---------------------------------------------------------------------------
  test("AC5: missing ?agent returns 400", async () => {
    const res = mockRes();
    await streamHandler!(mockReq({}), res);
    assert.equal(res._status, 400);
    assert.ok(typeof res._body.error === "string");
  });

  // ---------------------------------------------------------------------------
  // AC6 — only dispatch actions count. A worktreeBranch field on a
  // non-dispatch action is ignored (mirrors the dashboard's mental model
  // — the cross-link is rendered only on dispatch rows in Autopilot.jsx).
  // ---------------------------------------------------------------------------
  test("AC6: worktreeBranch on a non-dispatch action does NOT resolve", async () => {
    const stamped = "worktree-agent-cafebabe-t2-dev_orch";

    await seedRunRow("run-531-ac6", {
      run_id: "run-531-ac6",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "running",
      pid: 1,
      turns: 2,
      dispatches: 0,
      last_heartbeat_epoch: 1747648900,
    });
    await seedTurn("run-531-ac6", 2, [
      // hypothetical sweep action that happens to carry a worktreeBranch
      { type: "sweep", worktreeBranch: stamped },
    ]);

    const res = mockRes();
    await streamHandler!(mockReq({ agent: stamped }), res);
    assert.equal(res._status, 404, "non-dispatch worktreeBranch must not resolve");
    assert.equal(res._body.resolved, false);
  });

  // ---------------------------------------------------------------------------
  // AC7 — multiple runs carry the same stamp → newest wins.
  // ---------------------------------------------------------------------------
  test("AC7: when multiple runs contain the same stamp, the most recent run wins", async () => {
    const stamped = "worktree-agent-collide12-t1-dev_orch";

    // Older run.
    await seedRunRow("run-531-ac7-old", {
      run_id: "run-531-ac7-old",
      started: "2026-05-19T08:00:00Z",
      started_epoch: 1747641600,
      status: "ended",
      turns: 1,
      dispatches: 1,
      cumulative_tokens: 0,
    });
    await seedTurn("run-531-ac7-old", 1, [
      {
        type: "dispatch",
        cycleId: "cyc-531-ac7-old",
        worktreeBranch: stamped,
      },
    ]);
    await seedCycle("cyc-531-ac7-old", { status: "merged" });

    // Newer run with the same stamp.
    await seedRunRow("run-531-ac7-new", {
      run_id: "run-531-ac7-new",
      started: "2026-05-19T12:00:00Z",
      started_epoch: 1747656000,
      status: "running",
      pid: 1,
      turns: 1,
      dispatches: 1,
      last_heartbeat_epoch: 1747656100,
    });
    await seedTurn("run-531-ac7-new", 1, [
      {
        type: "dispatch",
        cycleId: "cyc-531-ac7-new",
        worktreeBranch: stamped,
      },
    ]);
    await seedCycle("cyc-531-ac7-new", { status: "running" });

    const res = mockRes();
    await streamHandler!(mockReq({ agent: stamped }), res);
    assert.equal(res._status, 200);
    assert.equal(
      res._body.runId,
      "run-531-ac7-new",
      "newest run by started_epoch wins on stamp collision",
    );
    assert.equal(res._body.outcome.status, "running");
  });

  // ---------------------------------------------------------------------------
  // AC8 — dispatch resolves BEFORE the cycle record is written (the
  // load-bearing "freshly dispatched slot" case the issue calls out).
  // ---------------------------------------------------------------------------
  test("AC8: freshly-dispatched slot resolves with outcome=null when cycle hash not yet written", async () => {
    const stamped = "worktree-agent-fresh001-t1-dev_orch";

    await seedRunRow("run-531-ac8", {
      run_id: "run-531-ac8",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "running",
      pid: 1,
      turns: 1,
      dispatches: 1,
      last_heartbeat_epoch: 1747648900,
    });
    // Dispatch action stamped, but NO seedCycle() call — the Phase 6
    // /autopilot/cycle-record write hasn't happened yet because the
    // subagent is still running.
    await seedTurn("run-531-ac8", 1, [
      {
        type: "dispatch",
        skill: "hydra-dev",
        cycleId: "cyc-531-ac8",
        worktreeBranch: stamped,
      },
    ]);

    const res = mockRes();
    await streamHandler!(mockReq({ agent: stamped }), res);

    assert.equal(res._status, 200, "freshly-dispatched stamp must resolve before Phase 6");
    assert.equal(res._body.resolved, true);
    assert.equal(res._body.dispatch.worktreeBranch, stamped);
    assert.equal(
      res._body.outcome,
      null,
      "outcome is null when cycle hash hasn't been written yet (Phase 5 → Phase 6 race)",
    );
  });
});
