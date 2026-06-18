/**
 * Regression tests for the /api/autopilot/runs (history list) and
 * /api/autopilot/runs/:runId (full detail) endpoints — slice 4 of epic #496
 * (issue #500).
 *
 * Slice 4 closes the dashboard observability loop:
 *   - GET /autopilot/runs            — paginated history list, applies the
 *                                      inherited slice-1 read-time sweeper to
 *                                      in-flight rows.
 *   - GET /autopilot/runs/:runId     — full per-run detail (hash + all turns
 *                                      + cycle joins). No 50-turn cap.
 *   - GET /autopilot/runs/current    — additionally surfaces a `cost`
 *                                      breakdown computed from the joined
 *                                      dispatch outcomes (no run-hash writes).
 *
 * Tests verify:
 *   AC1 — GET /runs returns most-recent N runs (default 14, score desc)
 *   AC2 — GET /runs limit is clamped to [1, 50]
 *   AC3 — GET /runs returns empty array when index is empty (no 404)
 *   AC4 — GET /runs sweeps dead-pid `running` rows to `killed/crash`
 *   AC5 — GET /runs/:runId returns hash + ALL turns (no 50 cap) + joins
 *   AC6 — GET /runs/:runId returns 404 for unknown runId
 *   AC7 — GET /runs/:runId is read-only relative to Redis (sweep aside)
 *   AC8 — retired with the USD attribution plane (#1651): the cost
 *         breakdown projection no longer exists
 *   AC9 — slice-1/2/3 schema closure: slice 4 writes NO new run-hash fields
 *         (slice-2 AC10 + slice-3 AC12 invariant continues)
 *   AC10 — `/runs` history rows expose merged_count/failed_count from outcomes
 *
 * Uses Redis DB 1 — never touches production. File-level after() closes the
 * Redis client (PR #518 lesson).
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

function mockReq(params: any = {}, query: any = {}, body: any = {}): any {
  return { method: "GET", url: "/", headers: {}, params, query, body };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    _headers: {} as Record<string, string>,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader(k: string, v: string) { res._headers[k] = v; return res; },
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

// Seed a run hash directly (bypasses the run-start handler) so tests can
// stamp arbitrary status / timestamp values without re-deriving them from
// the writer's defaults.
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

// Seed a turn row (one JSON member at score=turn_n on the run's turns ZSET).
async function seedTurn(
  runId: string,
  turnN: number,
  actions: any[],
  extras: Record<string, unknown> = {},
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
    ...extras,
  });
  await redis.zadd(`hydra:autopilot:run:${runId}:turns`, turnN, member);
}

// Seed a cycle hash so the dispatch->cycle join hits.
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

describe("autopilot history API (issue #500)", () => {
  let createAutopilotRouter: any;
  let runsList: any;
  let runDetail: any;
  let runsCurrent: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createAutopilotRouter) {
      const mod = await import("../src/api/autopilot-runs.ts");
      createAutopilotRouter = mod.createAutopilotRunsRouter;
    }
    const router = createAutopilotRouter();
    runsList = findHandler(router, "GET", "/autopilot/runs");
    runDetail = findHandler(router, "GET", "/autopilot/runs/:runId");
    runsCurrent = findHandler(router, "GET", "/autopilot/runs/current");
    assert.ok(runsList, "GET /autopilot/runs handler should exist");
    assert.ok(runDetail, "GET /autopilot/runs/:runId handler should exist");
  });

  // PR #518 lesson — file-level after() so the runner emits `# pass N`.
  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // AC1 — GET /runs returns most-recent N runs (default 14, score desc)
  // ---------------------------------------------------------------------------
  test("AC1: GET /runs returns most-recent 14 runs by started_epoch desc", async () => {
    // Seed 16 runs at increasing started_epoch so the index orders deterministically.
    const baseEpoch = 1747648800;
    for (let i = 0; i < 16; i++) {
      await seedRunRow(`run-${String(i).padStart(2, "0")}`, {
        run_id: `run-${String(i).padStart(2, "0")}`,
        started: `2026-05-19T10:${String(i).padStart(2, "0")}:00Z`,
        started_epoch: baseEpoch + i,
        status: "ended",
        trigger: "manual",
        turns: 1,
        dispatches: 0,
        cumulative_tokens: 100,
        ended_epoch: baseEpoch + i + 30,
        exit_code: 0,
      });
    }

    const res = mockRes();
    await runsList(mockReq({}, {}), res);
    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._body.runs), "response.runs is an array");
    assert.equal(res._body.runs.length, 14, "default limit is 14");
    // First row = newest (run-15), last = run-02 (skipping the oldest two).
    assert.equal(res._body.runs[0].run_id, "run-15");
    assert.equal(res._body.runs[13].run_id, "run-02");
  });

  // ---------------------------------------------------------------------------
  // AC2 — GET /runs limit is clamped to [1, 50]
  // ---------------------------------------------------------------------------
  test("AC2: ?limit is clamped to [1, 50]", async () => {
    const baseEpoch = 1747648800;
    for (let i = 0; i < 5; i++) {
      await seedRunRow(`run-${i}`, {
        run_id: `run-${i}`,
        started: `2026-05-19T10:0${i}:00Z`,
        started_epoch: baseEpoch + i,
        status: "ended",
        trigger: "manual",
        turns: 0,
        dispatches: 0,
        cumulative_tokens: 0,
      });
    }

    // limit=2 → exactly 2 returned, newest first.
    let res = mockRes();
    await runsList(mockReq({}, { limit: "2" }), res);
    assert.equal(res._body.runs.length, 2);
    assert.equal(res._body.runs[0].run_id, "run-4");

    // limit=999 → clamped to 50, but we only have 5 → 5 returned.
    res = mockRes();
    await runsList(mockReq({}, { limit: "999" }), res);
    assert.equal(res._body.runs.length, 5);

    // limit=0 (valid integer below min) → clamped to min=1 → 1 returned
    // (newest first).
    res = mockRes();
    await runsList(mockReq({}, { limit: "0" }), res);
    assert.equal(res._body.runs.length, 1);
    assert.equal(res._body.runs[0].run_id, "run-4");

    // limit=garbage (non-integer) → falls back to default (14). Only 5 seeded.
    res = mockRes();
    await runsList(mockReq({}, { limit: "abc" }), res);
    assert.equal(res._body.runs.length, 5);
  });

  // ---------------------------------------------------------------------------
  // AC3 — GET /runs returns empty array when index is empty (NOT 404)
  // ---------------------------------------------------------------------------
  test("AC3: empty history → empty array, status 200 (not 404)", async () => {
    const res = mockRes();
    await runsList(mockReq({}, {}), res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.runs, []);
  });

  // ---------------------------------------------------------------------------
  // AC4 — GET /runs sweeps dead-pid `running` rows to `killed/crash`
  // ---------------------------------------------------------------------------
  test("AC4: dead-pid running row sweeps to killed/crash in history", async () => {
    // Seed a `running` row with a guaranteed-dead pid (pid 1 belongs to init
    // and process.kill(1, 0) raises EPERM, which sweepRunIfDead correctly
    // counts as "alive". We need an actually-dead pid.)
    //
    // Use a pid in the high reserved range that the kernel won't assign
    // (Linux pid_max is typically 4194304; > that is guaranteed-dead).
    await seedRunRow("run-dead", {
      run_id: "run-dead",
      started: "2026-05-19T10:00:00Z",
      started_epoch: Math.floor(Date.now() / 1000) - 600,
      status: "running",
      trigger: "manual",
      pid: 9999999, // > /proc/sys/kernel/pid_max → ESRCH
      turns: 1,
      dispatches: 0,
      cumulative_tokens: 0,
      last_heartbeat_epoch: Math.floor(Date.now() / 1000) - 600,
    });

    const res = mockRes();
    await runsList(mockReq({}, {}), res);
    assert.equal(res._body.runs.length, 1);
    const digest = res._body.runs[0];
    assert.equal(digest.status, "killed", "running with dead pid → killed in history");
    assert.equal(digest.term_reason, "crash");

    // Verify the sweep wrote back to Redis (the next /runs call should see
    // it as already-killed without re-sweeping).
    const row = await redis.hgetall("hydra:autopilot:run:run-dead");
    assert.equal(row.status, "killed");
    assert.equal(row.term_reason, "crash");
  });

  // ---------------------------------------------------------------------------
  // AC5 — GET /runs/:runId returns hash + ALL turns (no 50-turn cap)
  // ---------------------------------------------------------------------------
  test("AC5: detail endpoint returns ALL turns (no 50 cap) + joins", async () => {
    await seedRunRow("run-detail", {
      run_id: "run-detail",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "ended",
      trigger: "manual",
      turns: 60,
      dispatches: 60,
      cumulative_tokens: 5000,
      ended_epoch: 1747652400,
      exit_code: 0,
    });
    // Seed 60 turns each with one dispatch action pointing at a cycle.
    for (let i = 1; i <= 60; i++) {
      await seedCycle(`cyc-${i}`, {
        status: i % 2 === 0 ? "merged" : "failed",
      });
      await seedTurn("run-detail", i, [
        { type: "dispatch", slot: "dev_orch", cycleId: `cyc-${i}` },
      ]);
    }

    const res = mockRes();
    await runDetail(mockReq({ runId: "run-detail" }, {}), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.run.run_id, "run-detail");
    assert.equal(res._body.turns.length, 60, "detail returns ALL turns (no 50 cap)");
    // Newest first (turn_n=60 → 1)
    assert.equal((res._body.turns[0] as any).turn_n, 60);
    assert.equal((res._body.turns[59] as any).turn_n, 1);
    // Joins populated.
    const a0 = (res._body.turns[0] as any).actions[0];
    assert.equal(a0.outcome.status, "merged");
    assert.equal(a0.outcome.cycleId, "cyc-60");
    // The USD cost breakdown was retired with the attribution plane (#1651):
    // the run view must no longer carry a `cost` key.
    assert.equal(res._body.run.cost, undefined, "run.cost retired (#1651)");
  });

  // ---------------------------------------------------------------------------
  // AC6 — GET /runs/:runId returns 404 for unknown runId
  // ---------------------------------------------------------------------------
  test("AC6: detail endpoint 404 on unknown runId", async () => {
    const res = mockRes();
    await runDetail(mockReq({ runId: "does-not-exist" }, {}), res);
    assert.equal(res._status, 404);
  });

  // ---------------------------------------------------------------------------
  // AC7 — GET /runs/:runId is read-only relative to Redis (sweep aside)
  //
  // We seed an `ended` row (already terminal) so the inherited slice-1 sweep
  // is a no-op; then we verify the detail endpoint produces no Redis
  // mutations of any kind.
  // ---------------------------------------------------------------------------
  test("AC7: detail endpoint mutates nothing on terminal rows", async () => {
    await seedRunRow("run-readonly", {
      run_id: "run-readonly",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "ended",
      trigger: "manual",
      turns: 0,
      dispatches: 0,
      cumulative_tokens: 0,
      ended_epoch: 1747652400,
    });
    const before = await redis.hgetall("hydra:autopilot:run:run-readonly");
    const beforeKeys = (await redis.keys("hydra:autopilot:run:run-readonly*")).sort();

    await runDetail(mockReq({ runId: "run-readonly" }, {}), mockRes());

    const after = await redis.hgetall("hydra:autopilot:run:run-readonly");
    const afterKeys = (await redis.keys("hydra:autopilot:run:run-readonly*")).sort();
    assert.deepEqual(after, before, "run hash unchanged");
    assert.deepEqual(afterKeys, beforeKeys, "no sidecar keys created");
  });

  // ---------------------------------------------------------------------------
  // AC9 — schema closure: slice 4 writes NO new fields to the run hash
  //
  // Extends slice-2 AC10 + slice-3 AC12 to cover the new /runs and
  // /runs/:runId endpoints. Read-only relative to Redis on already-terminal
  // rows; on `running` rows the inherited slice-1 sweeper may set status /
  // term_reason / ended_epoch (slice-1 fields, NOT new top-level fields).
  // ---------------------------------------------------------------------------
  test("AC9: slice-4 endpoints introduce no new top-level run-hash fields", async () => {
    // KNOWN_FIELDS = slice-1 + slice-2 set. Slice 3 added none. Slice 4 adds
    // none. Any drift here means schema closure broke.
    const KNOWN_FIELDS = new Set([
      "run_id", "started", "started_epoch", "status", "trigger", "pid", "limits",
      "turns", "dispatches", "cumulative_tokens", "idle_turns", "last_heartbeat_epoch",
      "term_reason", "ended_epoch", "exit_code",
    ]);

    // Terminal row — neither the list nor the detail endpoint should mutate
    // anything.
    await seedRunRow("run-schema-4a", {
      run_id: "run-schema-4a",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "ended",
      trigger: "manual",
      pid: 1,
      limits: JSON.stringify({}),
      turns: 1,
      dispatches: 0,
      cumulative_tokens: 0,
      idle_turns: 0,
      last_heartbeat_epoch: 1747648800,
      term_reason: "budget",
      ended_epoch: 1747652400,
      exit_code: 0,
    });

    const before = await redis.hgetall("hydra:autopilot:run:run-schema-4a");
    await runsList(mockReq({}, {}), mockRes());
    await runDetail(mockReq({ runId: "run-schema-4a" }, {}), mockRes());
    const after = await redis.hgetall("hydra:autopilot:run:run-schema-4a");

    assert.deepEqual(after, before, "slice 4 must not mutate the run hash on terminal rows");
    for (const k of Object.keys(after)) {
      assert.ok(
        KNOWN_FIELDS.has(k),
        `slice 4 must not add new top-level field "${k}" to the run hash`,
      );
    }
    // And no `:cost` / `:digest` sidecar keys either — cost breakdown is
    // computed on read, never persisted.
    const sidecars = await redis.keys("hydra:autopilot:run:run-schema-4a:*");
    // Note: the slice-2 turns ZSET (`...:turns`) is a permitted sidecar; we
    // only forbid NEW sidecars introduced by slice 4.
    const slice4Sidecars = sidecars.filter((k: string) => !k.endsWith(":turns"));
    assert.deepEqual(
      slice4Sidecars,
      [],
      `slice 4 must not create new sidecar keys, got: ${slice4Sidecars.join(",")}`,
    );
  });

  // ---------------------------------------------------------------------------
  // AC10 — history digest exposes merged_count / failed_count from outcomes
  // ---------------------------------------------------------------------------
  test("AC10: history digest exposes merged_count / failed_count", async () => {
    await seedRunRow("run-counts", {
      run_id: "run-counts",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "ended",
      trigger: "morning-timer",
      turns: 4,
      dispatches: 4,
      cumulative_tokens: 12345,
      ended_epoch: 1747652400,
      exit_code: 0,
    });
    await seedCycle("c-m1", { status: "merged" });
    await seedCycle("c-m2", { status: "completed" });
    await seedCycle("c-f1", { status: "failed" });
    await seedCycle("c-f2", { status: "abandoned" });
    await seedTurn("run-counts", 1, [{ type: "dispatch", cycleId: "c-m1" }]);
    await seedTurn("run-counts", 2, [{ type: "dispatch", cycleId: "c-m2" }]);
    await seedTurn("run-counts", 3, [{ type: "dispatch", cycleId: "c-f1" }]);
    await seedTurn("run-counts", 4, [{ type: "dispatch", cycleId: "c-f2" }]);

    const res = mockRes();
    await runsList(mockReq({}, {}), res);
    assert.equal(res._body.runs.length, 1);
    const d = res._body.runs[0];
    assert.equal(d.run_id, "run-counts");
    assert.equal(d.trigger, "morning-timer");
    assert.equal(d.merged_count, 2, "merged + completed → 2");
    assert.equal(d.failed_count, 2, "failed + abandoned → 2");
    assert.equal(d.total_tokens, 12345);
    assert.equal(d.dispatches, 4);
    assert.equal(d.duration_s, 3600, "1h ended_epoch - started_epoch");
    assert.equal(d.exit_code, 0);
  });

  // ---------------------------------------------------------------------------
  // AC11 (issue #527) — stamped `worktreeBranch` on dispatch actions
  // round-trips through `fetchTurnsWithJoins` unchanged, so the dashboard's
  // slice-4 "Watch stream" cross-link can compute a valid AgentStream href.
  //
  // This is the consumer-side closure for issue #527. The producer-side
  // (decide.py stamping) is asserted in test/autopilot-decide.test.mts. Here
  // we seed a turn-row with `worktreeBranch` on the dispatch action and
  // verify the API surface preserves it on the joined action object — the
  // exact shape Autopilot.jsx's resolution chain reads.
  // ---------------------------------------------------------------------------
  test("AC11 (issue #527): worktreeBranch on dispatch action round-trips through detail endpoint", async () => {
    await seedRunRow("run-527", {
      run_id: "run-527",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      status: "ended",
      trigger: "manual",
      turns: 1,
      dispatches: 1,
      cumulative_tokens: 200,
      ended_epoch: 1747652400,
      exit_code: 0,
    });
    await seedCycle("cyc-527", { status: "merged" });
    await seedTurn("run-527", 1, [
      {
        type: "dispatch",
        slot: "dev_orch",
        skill: "hydra-dev",
        cycleId: "cyc-527",
        worktreeBranch: "worktree-agent-abcdef12-t1-dev_orch",
      },
    ]);

    const res = mockRes();
    await runDetail(mockReq({ runId: "run-527" }, {}), res);
    assert.equal(res._status, 200);
    const action = (res._body.turns[0] as any).actions[0];
    assert.equal(action.type, "dispatch");
    assert.equal(
      action.worktreeBranch,
      "worktree-agent-abcdef12-t1-dev_orch",
      "worktreeBranch must survive the join unchanged so AgentStream cross-link renders",
    );

    // Mirror the dashboard's resolution chain (Autopilot.jsx:236-237) and
    // confirm the resulting href is well-formed. This is the load-bearing
    // assertion for the slice-4 AC ("Watch stream button navigates to
    // AgentStream with correct branch filter").
    const branch =
      action.worktreeBranch ||
      action.worktree_branch ||
      action.branch ||
      action.outcome?.worktreeBranch ||
      action.outcome?.worktree_branch ||
      null;
    assert.ok(branch, "dashboard's resolution chain must surface a branch");
    const href = `/agents/stream?agent=${encodeURIComponent(branch)}`;
    assert.equal(
      href,
      "/agents/stream?agent=worktree-agent-abcdef12-t1-dev_orch",
      "AgentStream href must encode the stamped worktree branch",
    );
  });

});
