/**
 * Regression tests for the /api/autopilot/turn surface (issue #498, slice 2
 * of epic #496).
 *
 * Slice 1 (PR #522, issue #497) built the run hash + index foundation with
 * additive counter fields (turns, dispatches, cumulative_tokens, idle_turns,
 * last_heartbeat_epoch). Slice 2 wires the per-turn writer that MUTATES
 * those counters via single-field writes (hashSetField / hashIncrBy) and
 * appends one immutable JSON member per decision turn to a per-run ZSET
 * scored by turn_n.
 *
 * Tests verify:
 *   AC1  — POST /turn writes a JSON member to the turns ZSET with score=turn_n
 *   AC2  — counters update: turns := MAX, dispatches += dispatch_count,
 *          cumulative_tokens := snapshot, idle_turns := snapshot,
 *          last_heartbeat_epoch := snapshot
 *   AC3  — idempotency on (run_id, turn_n): re-POST is a no-op (no double
 *          dispatch count, no clobbered ZSET member)
 *   AC4  — 404 if run hash doesn't exist
 *   AC5  — 400 on missing run_id or turn_n
 *   AC6  — GET /runs/current includes `turns` array with most-recent N first
 *   AC7  — GET /runs/current attaches `outcome` from cycle hash for dispatch
 *          actions (the join via cycleId or synthesized run_id:turn_n:idx)
 *   AC8  — non-dispatch actions get no outcome field stitched on
 *   AC9  — turns array trimmed to 50 most-recent rows
 *   AC10 — slice-1 future-compat: existing run fields (started, pid, trigger,
 *          limits) are not clobbered by the turn write
 *
 * Uses Redis DB 1 — never touches production. File-level after() closes
 * the Redis client so the test runner emits `# pass N` (PR #518 lesson).
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
  const cycleKeys = await redis.keys("hydra:cycle:*");
  if (cycleKeys.length > 0) await redis.del(...cycleKeys);
}

function mockReq(body: any = {}): any {
  return { method: "POST", url: "/", headers: {}, query: {}, params: {}, body };
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
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

describe("autopilot turn API (issue #498, slice 2)", () => {
  let createAutopilotRouter: any;
  let runStart: any;
  let turn: any;
  let runsCurrent: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createAutopilotRouter) {
      // #2034: the run/turn lifecycle WRITES (run-start, turn) live in
      // autopilot-lifecycle.ts; the runs/current READ projection lives in
      // autopilot-runs.ts. This suite exercises both, so it concatenates the
      // two sub-routers' route layers into one flat router (findHandler walks
      // the top-level stack only, not nested `.use()` mounts).
      const [lifecycle, runs] = await Promise.all([
        import("../src/api/autopilot-lifecycle.ts"),
        import("../src/api/autopilot-runs.ts"),
      ]);
      createAutopilotRouter = () => {
        const lifecycleRouter = lifecycle.createAutopilotLifecycleRouter();
        const runsRouter = runs.createAutopilotRunsRouter();
        lifecycleRouter.stack.push(...runsRouter.stack);
        return lifecycleRouter;
      };
    }
    const router = createAutopilotRouter();
    runStart = findHandler(router, "POST", "/autopilot/run-start");
    turn = findHandler(router, "POST", "/autopilot/turn");
    runsCurrent = findHandler(router, "GET", "/autopilot/runs/current");
    assert.ok(turn, "POST /autopilot/turn handler should exist");
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  async function seedRun(runId: string) {
    await runStart(
      mockReq({
        run_id: runId,
        started: "2026-05-19T10:00:00Z",
        started_epoch: Math.floor(Date.now() / 1000) - 60,
        pid: process.pid,
        trigger: "manual",
        limits: { token_budget: 1000000, wall_clock_max_sec: 7200, idle_drain_turns: 5 },
      }),
      mockRes(),
    );
  }

  // ---------------------------------------------------------------------------
  // AC1 — POST /turn writes JSON member to turns ZSET with score=turn_n
  // ---------------------------------------------------------------------------
  test("AC1: turn writes JSON member to ZSET keyed by turn_n", async () => {
    await seedRun("run-t1");
    const res = mockRes();
    await turn(
      mockReq({
        run_id: "run-t1",
        turn_n: 5,
        epoch: 1700000000,
        actions: [{ type: "dispatch", slot: "dev_orch", skill: "hydra-dev" }],
        reasons: ["scope=orch"],
        slots_snapshot: { dev_orch: { skill: "hydra-dev" } },
        signals_snapshot: { health: 1700000000 },
        tokens_after: 1234,
        idle_turns: 0,
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.deduped, false);
    assert.equal(res._body.turn_n, 5);

    const members = await redis.zrange("hydra:autopilot:run:run-t1:turns", 0, -1, "WITHSCORES");
    assert.equal(members.length, 2, "one member + one score");
    assert.equal(members[1], "5");
    const parsed = JSON.parse(members[0]);
    assert.equal(parsed.turn_n, 5);
    assert.equal(parsed.tokens_after, 1234);
    assert.equal(parsed.actions[0].type, "dispatch");
  });

  // ---------------------------------------------------------------------------
  // AC2 — counters update: turns = MAX, dispatches += N, tokens snapshot
  // ---------------------------------------------------------------------------
  test("AC2: counters update — turns=MAX, dispatches+=count, tokens=snapshot", async () => {
    await seedRun("run-t2");
    // Turn 3 with 2 dispatches
    await turn(
      mockReq({
        run_id: "run-t2",
        turn_n: 3,
        epoch: 1700000000,
        actions: [
          { type: "dispatch", slot: "dev_orch" },
          { type: "dispatch", slot: "qa_orch" },
          { type: "wait", seconds: 60 },
        ],
        tokens_after: 5000,
        idle_turns: 1,
      }),
      mockRes(),
    );
    let row = await redis.hgetall("hydra:autopilot:run:run-t2");
    assert.equal(row.turns, "3");
    assert.equal(row.dispatches, "2");
    assert.equal(row.cumulative_tokens, "5000");
    assert.equal(row.idle_turns, "1");
    assert.equal(row.last_heartbeat_epoch, "1700000000");

    // Turn 7 with 1 more dispatch
    await turn(
      mockReq({
        run_id: "run-t2",
        turn_n: 7,
        epoch: 1700000100,
        actions: [{ type: "dispatch", slot: "research_orch" }],
        tokens_after: 9000,
        idle_turns: 0,
      }),
      mockRes(),
    );
    row = await redis.hgetall("hydra:autopilot:run:run-t2");
    assert.equal(row.turns, "7", "turns MAX'd to 7");
    assert.equal(row.dispatches, "3", "dispatches accumulated to 3");
    assert.equal(row.cumulative_tokens, "9000");
    assert.equal(row.idle_turns, "0");
    assert.equal(row.last_heartbeat_epoch, "1700000100");

    // An out-of-order older turn must NOT regress `turns`
    await turn(
      mockReq({
        run_id: "run-t2",
        turn_n: 4,
        epoch: 1700000200,
        actions: [],
        tokens_after: 9500,
        idle_turns: 0,
      }),
      mockRes(),
    );
    row = await redis.hgetall("hydra:autopilot:run:run-t2");
    assert.equal(row.turns, "7", "out-of-order older turn must not lower turns counter");
  });

  // ---------------------------------------------------------------------------
  // AC3 — idempotency on (run_id, turn_n): re-POST is a no-op
  // ---------------------------------------------------------------------------
  test("AC3: re-POST same (run_id, turn_n) does not double-count or clobber", async () => {
    await seedRun("run-t3");
    const body = {
      run_id: "run-t3",
      turn_n: 10,
      epoch: 1700000000,
      actions: [{ type: "dispatch", slot: "dev_orch" }],
      tokens_after: 1000,
      idle_turns: 0,
    };
    await turn(mockReq(body), mockRes());

    const res = mockRes();
    await turn(mockReq(body), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.deduped, true);

    const row = await redis.hgetall("hydra:autopilot:run:run-t3");
    assert.equal(row.dispatches, "1", "dispatch counter must not double on dup POST");
    assert.equal(await redis.zcard("hydra:autopilot:run:run-t3:turns"), 1, "exactly one turn row");
  });

  // ---------------------------------------------------------------------------
  // AC4 — 404 on unknown run_id
  // ---------------------------------------------------------------------------
  test("AC4: turn on unknown run_id returns 404", async () => {
    const res = mockRes();
    await turn(
      mockReq({ run_id: "no-such-run", turn_n: 1, epoch: 1, actions: [], tokens_after: 0, idle_turns: 0 }),
      res,
    );
    assert.equal(res._status, 404);
  });

  // ---------------------------------------------------------------------------
  // AC5 — 400 on missing run_id or turn_n
  // ---------------------------------------------------------------------------
  test("AC5: turn returns 400 on missing run_id or turn_n", async () => {
    const r1 = mockRes();
    await turn(mockReq({ turn_n: 1, epoch: 1 }), r1);
    assert.equal(r1._status, 400);

    const r2 = mockRes();
    await turn(mockReq({ run_id: "x", epoch: 1 }), r2);
    assert.equal(r2._status, 400);

    const r3 = mockRes();
    await turn(mockReq({ run_id: "x", turn_n: -1, epoch: 1 }), r3);
    assert.equal(r3._status, 400);
  });

  // ---------------------------------------------------------------------------
  // AC6 — GET /runs/current includes `turns` array with most-recent first
  // ---------------------------------------------------------------------------
  test("AC6: runs/current includes turns array, most-recent first", async () => {
    await seedRun("run-t6");
    for (let n = 1; n <= 4; n++) {
      await turn(
        mockReq({
          run_id: "run-t6",
          turn_n: n,
          epoch: 1700000000 + n,
          actions: [],
          tokens_after: n * 100,
          idle_turns: 0,
        }),
        mockRes(),
      );
    }
    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._body.turns), "turns must be an array");
    assert.equal(res._body.turns.length, 4);
    // Descending order
    assert.equal(res._body.turns[0].turn_n, 4);
    assert.equal(res._body.turns[3].turn_n, 1);
  });

  // ---------------------------------------------------------------------------
  // AC7 — dispatch actions get cycle-record `outcome` join
  // ---------------------------------------------------------------------------
  test("AC7: dispatch actions are joined with cycle-record outcome", async () => {
    await seedRun("run-t7");
    // Seed a cycle hash that the dispatch action will join against. The
    // server's default cycleId synthesis is `<run_id>:<turn_n>:<idx>`.
    const cycleId = "run-t7:1:0";
    await redis.hset(
      `hydra:cycle:${cycleId}`,
      "status", "merged",
      "prNumber", "999",
      "startedAt", "2026-05-19T10:00:00Z",
      "completedAt", "2026-05-19T10:05:00Z",
    );
    await turn(
      mockReq({
        run_id: "run-t7",
        turn_n: 1,
        epoch: 1700000000,
        actions: [{ type: "dispatch", slot: "dev_orch", skill: "hydra-dev" }],
        tokens_after: 100,
        idle_turns: 0,
      }),
      mockRes(),
    );
    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    const t = res._body.turns[0];
    const a = t.actions[0];
    assert.ok(a.outcome, "dispatch action must carry an outcome");
    assert.equal(a.outcome.status, "merged");
    assert.equal(a.outcome.prNumber, "999");
  });

  // ---------------------------------------------------------------------------
  // AC8 — non-dispatch actions: no outcome field stitched on
  // ---------------------------------------------------------------------------
  test("AC8: non-dispatch actions have no outcome field", async () => {
    await seedRun("run-t8");
    await turn(
      mockReq({
        run_id: "run-t8",
        turn_n: 1,
        epoch: 1700000000,
        actions: [{ type: "wait", seconds: 60, reason: "no-anchor" }],
        tokens_after: 50,
        idle_turns: 0,
      }),
      mockRes(),
    );
    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    const a = res._body.turns[0].actions[0];
    assert.equal(a.type, "wait");
    assert.equal(a.outcome, undefined, "non-dispatch action should NOT carry outcome");
  });

  // ---------------------------------------------------------------------------
  // AC9 — turns array trimmed to most-recent 50
  // ---------------------------------------------------------------------------
  test("AC9: runs/current returns at most 50 most-recent turn rows", async () => {
    await seedRun("run-t9");
    for (let n = 1; n <= 60; n++) {
      await turn(
        mockReq({
          run_id: "run-t9",
          turn_n: n,
          epoch: 1700000000 + n,
          actions: [],
          tokens_after: n,
          idle_turns: 0,
        }),
        mockRes(),
      );
    }
    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._body.turns.length, 50);
    assert.equal(res._body.turns[0].turn_n, 60, "most recent first");
    assert.equal(res._body.turns[49].turn_n, 11, "oldest in window = 60-50+1");
  });

  // ---------------------------------------------------------------------------
  // AC10 — slice-1 fields not clobbered: future-compat promise
  // ---------------------------------------------------------------------------
  test("AC10: slice-1 fields (started, pid, trigger, limits) survive turn writes", async () => {
    await seedRun("run-t10");
    const before = await redis.hgetall("hydra:autopilot:run:run-t10");
    await turn(
      mockReq({
        run_id: "run-t10",
        turn_n: 1,
        epoch: 1700000000,
        actions: [{ type: "dispatch", slot: "dev_orch" }],
        tokens_after: 100,
        idle_turns: 0,
      }),
      mockRes(),
    );
    const after = await redis.hgetall("hydra:autopilot:run:run-t10");
    // The fields slice 1 wrote at run-start must be untouched.
    assert.equal(after.started, before.started);
    assert.equal(after.pid, before.pid);
    assert.equal(after.trigger, before.trigger);
    assert.equal(after.limits, before.limits);
    assert.equal(after.status, "running");
    // And no NEW top-level hash fields were introduced.
    const knownFields = new Set([
      "run_id", "started", "started_epoch", "status", "trigger", "pid", "limits",
      "turns", "dispatches", "cumulative_tokens", "idle_turns", "last_heartbeat_epoch",
    ]);
    for (const k of Object.keys(after)) {
      assert.ok(knownFields.has(k), `slice 2 must not add new top-level field "${k}" to the run hash`);
    }
  });
});
