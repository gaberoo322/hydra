/**
 * Regression tests for the /api/autopilot/run-* surface (issue #497, parent #496).
 *
 * Bug surface: pre-#497 there was no /autopilot dashboard page and no way to
 * answer "is the autopilot run alive right now?" from outside the
 * /tmp/hydra-autopilot-state.json + journalctl pair. Slice 1 wires the
 * write path (run-start + run-end + cycle-record) and the read path with a
 * read-time sweeper that promotes dead-pid `running` rows to `killed/crash`.
 *
 * Tests verify:
 *   AC1 — run-start writes the hash + index entry
 *   AC2 — run-start is idempotent on run_id (re-POST is no-op)
 *   AC3 — run-end transitions running → ended with the term_reason from cause
 *   AC4 — run-end is idempotent (re-POST on already-ended row is a no-op)
 *   AC5 — run-end on a non-existent run_id returns 404
 *   AC6 — GET runs/current returns the latest by started_epoch with computed
 *         fields (elapsed_s, age_s, pid_alive, wedge_likely)
 *   AC7 — GET runs/current sweeper promotes running → killed/crash when the
 *         pid is dead, writes back to Redis, idempotent on re-GET
 *   AC8 — GET runs/current returns 404 when no runs exist
 *   AC9 — GET runs/current does NOT mutate a live-pid running row
 *
 * Uses Redis DB 1 — never touches production (DB 0). PR #518 lesson: file-
 * level `after()` hook closes the Redis client so the runner emits `# pass N`
 * lines and CI's PASS_COUNT check doesn't blow up.
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

describe("autopilot runs API (issue #497)", () => {
  let createAutopilotRouter: any;
  let runStart: any;
  let runEnd: any;
  let runsCurrent: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createAutopilotRouter) {
      const mod = await import("../src/api/autopilot.ts");
      createAutopilotRouter = mod.createAutopilotRouter;
    }
    const router = createAutopilotRouter();
    runStart = findHandler(router, "POST", "/autopilot/run-start");
    runEnd = findHandler(router, "POST", "/autopilot/run-end");
    runsCurrent = findHandler(router, "GET", "/autopilot/runs/current");
    assert.ok(runStart, "POST /autopilot/run-start handler should exist");
    assert.ok(runEnd, "POST /autopilot/run-end handler should exist");
    assert.ok(runsCurrent, "GET /autopilot/runs/current handler should exist");
  });

  // File-level after() — PR #518 lesson: close Redis client so runner emits
  // `# pass N` and CI PASS_COUNT check doesn't think the suite died early.
  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // AC1 — run-start writes the hash + index entry
  // ---------------------------------------------------------------------------
  test("AC1: run-start writes hash + index with running status", async () => {
    const req = mockReq({
      run_id: "run-aaa",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      pid: process.pid, // live pid so sweeper won't mutate
      trigger: "morning-timer",
      limits: { token_budget: 2000000, wall_clock_max_sec: 28800, idle_drain_turns: 5 },
    });
    const res = mockRes();
    await runStart(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.deduped, false);

    const row = await redis.hgetall("hydra:autopilot:run:run-aaa");
    assert.equal(row.status, "running");
    assert.equal(row.trigger, "morning-timer");
    assert.equal(row.pid, String(process.pid));
    assert.equal(row.started_epoch, "1747648800");
    assert.equal(row.cumulative_tokens, "0");
    assert.equal(row.turns, "0");

    const limits = JSON.parse(row.limits);
    assert.equal(limits.token_budget, 2000000);

    const indexed = await redis.zrange("hydra:autopilot:runs:index", 0, -1);
    assert.deepEqual(indexed, ["run-aaa"]);
  });

  // ---------------------------------------------------------------------------
  // AC2 — run-start is idempotent on run_id
  // ---------------------------------------------------------------------------
  test("AC2: run-start re-post on same run_id is a no-op", async () => {
    const body = {
      run_id: "run-bbb",
      started: "2026-05-19T10:00:00Z",
      started_epoch: 1747648800,
      pid: process.pid,
      trigger: "manual",
      limits: { token_budget: 1000 },
    };
    const res1 = mockRes();
    await runStart(mockReq(body), res1);
    assert.equal(res1._body.deduped, false);

    // Mutate something on the row so we can detect if the second POST overwrites.
    await redis.hset("hydra:autopilot:run:run-bbb", "cumulative_tokens", "12345");

    const res2 = mockRes();
    await runStart(mockReq(body), res2);
    assert.equal(res2._status, 200);
    assert.equal(res2._body.deduped, true);

    const row = await redis.hgetall("hydra:autopilot:run:run-bbb");
    // The mutation must survive — re-POST did not clobber counters.
    assert.equal(row.cumulative_tokens, "12345");

    // Index has exactly one entry.
    assert.equal(await redis.zcard("hydra:autopilot:runs:index"), 1);
  });

  // ---------------------------------------------------------------------------
  // AC3 — run-end transitions running → ended with term_reason from cause
  // ---------------------------------------------------------------------------
  test("AC3: run-end transitions running → ended with term_reason", async () => {
    await runStart(
      mockReq({
        run_id: "run-ccc",
        started: "2026-05-19T10:00:00Z",
        started_epoch: 1747648800,
        pid: process.pid,
        trigger: "overnight-timer",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runEnd(
      mockReq({ run_id: "run-ccc", cause: "budget", ended_epoch: 1747677600 }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.status, "ended");
    assert.equal(res._body.term_reason, "budget");

    const row = await redis.hgetall("hydra:autopilot:run:run-ccc");
    assert.equal(row.status, "ended");
    assert.equal(row.term_reason, "budget");
    assert.equal(row.ended_epoch, "1747677600");
  });

  // ---------------------------------------------------------------------------
  // AC4 — run-end on an already-ended row is a no-op (idempotent)
  // ---------------------------------------------------------------------------
  test("AC4: run-end on already-ended row preserves first term_reason", async () => {
    await runStart(
      mockReq({
        run_id: "run-ddd",
        started: "2026-05-19T10:00:00Z",
        started_epoch: 1747648800,
        pid: process.pid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );

    await runEnd(
      mockReq({ run_id: "run-ddd", cause: "wall_clock", ended_epoch: 1747677600 }),
      mockRes(),
    );

    // Second end with a different cause — must NOT overwrite.
    const res = mockRes();
    await runEnd(
      mockReq({ run_id: "run-ddd", cause: "idle", ended_epoch: 1747680000 }),
      res,
    );
    assert.equal(res._body.deduped, true);

    const row = await redis.hgetall("hydra:autopilot:run:run-ddd");
    assert.equal(row.term_reason, "wall_clock");
    assert.equal(row.ended_epoch, "1747677600");
  });

  // ---------------------------------------------------------------------------
  // AC5 — run-end on a non-existent run_id returns 404
  // ---------------------------------------------------------------------------
  test("AC5: run-end on unknown run_id returns 404", async () => {
    const res = mockRes();
    await runEnd(mockReq({ run_id: "no-such-run", cause: "budget" }), res);
    assert.equal(res._status, 404);
  });

  // ---------------------------------------------------------------------------
  // AC6 — GET runs/current returns the latest run with computed fields
  // ---------------------------------------------------------------------------
  test("AC6: runs/current returns latest with elapsed_s + age_s + pid_alive + wedge_likely", async () => {
    const startedEpoch = Math.floor(Date.now() / 1000) - 100;
    await runStart(
      mockReq({
        run_id: "run-eee",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: process.pid,
        trigger: "morning-timer",
        limits: { token_budget: 2000000, wall_clock_max_sec: 28800, idle_drain_turns: 5 },
      }),
      mockRes(),
    );

    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._status, 200);
    const v: any = res._body;
    assert.equal(v.run_id, "run-eee");
    assert.equal(v.status, "running");
    assert.equal(v.trigger, "morning-timer");
    assert.ok(v.elapsed_s >= 100, `elapsed_s expected >=100, got ${v.elapsed_s}`);
    assert.ok(v.elapsed_s < 200, `elapsed_s expected <200, got ${v.elapsed_s}`);
    assert.equal(v.pid_alive, true, "current process pid should be alive");
    assert.equal(v.wedge_likely, false, "age_s ~100 is well under 600 threshold");
    assert.equal(v.limits.token_budget, 2000000);
  });

  // ---------------------------------------------------------------------------
  // AC7 — sweeper promotes running → killed/crash on dead pid, writes back,
  //       idempotent on re-GET
  // ---------------------------------------------------------------------------
  test("AC7: runs/current sweeper promotes dead-pid running → killed/crash", async () => {
    // Use pid=2147483646 — outside the linux pid range so it's guaranteed not
    // to be a live process. (PID_MAX_LIMIT defaults to 4194304 but the chance
    // of collision at the very top of the int range is effectively zero.)
    const deadPid = 2147483646;
    const startedEpoch = Math.floor(Date.now() / 1000) - 200;
    await runStart(
      mockReq({
        run_id: "run-fff",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: deadPid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );

    // First GET — sweeper should promote.
    const res1 = mockRes();
    await runsCurrent({ method: "GET" } as any, res1);
    assert.equal(res1._body.status, "killed");
    assert.equal(res1._body.term_reason, "crash");
    assert.ok(res1._body.ended_epoch >= startedEpoch);

    // Verify Redis was actually written back.
    const row = await redis.hgetall("hydra:autopilot:run:run-fff");
    assert.equal(row.status, "killed");
    assert.equal(row.term_reason, "crash");

    // Second GET — idempotent, status stays killed/crash, no re-mutation.
    const res2 = mockRes();
    await runsCurrent({ method: "GET" } as any, res2);
    assert.equal(res2._body.status, "killed");
    assert.equal(res2._body.term_reason, "crash");
    assert.equal(res2._body.ended_epoch, res1._body.ended_epoch);
  });

  // ---------------------------------------------------------------------------
  // AC8 — runs/current returns 404 when no runs exist
  // ---------------------------------------------------------------------------
  test("AC8: runs/current returns 404 when index is empty", async () => {
    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._status, 404);
  });

  // ---------------------------------------------------------------------------
  // AC9 — sweeper leaves a live-pid running row alone
  // ---------------------------------------------------------------------------
  test("AC9: sweeper leaves running row with live pid untouched", async () => {
    const startedEpoch = Math.floor(Date.now() / 1000) - 50;
    await runStart(
      mockReq({
        run_id: "run-ggg",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: process.pid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._body.status, "running");
    assert.equal(res._body.pid_alive, true);

    const row = await redis.hgetall("hydra:autopilot:run:run-ggg");
    assert.equal(row.status, "running");
    assert.equal(row.term_reason, undefined);
  });

  // ---------------------------------------------------------------------------
  // AC10 — Multiple runs: runs/current returns the most recent by started_epoch
  // ---------------------------------------------------------------------------
  test("AC10: runs/current returns the run with the highest started_epoch", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i++) {
      await runStart(
        mockReq({
          run_id: `run-mult-${i}`,
          started: new Date((now - 1000 + i * 100) * 1000).toISOString(),
          started_epoch: now - 1000 + i * 100,
          pid: process.pid,
          trigger: "manual",
          limits: {},
        }),
        mockRes(),
      );
    }
    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._body.run_id, "run-mult-2");
  });

  // ---------------------------------------------------------------------------
  // AC11 — Missing run_id on run-start returns 400
  // ---------------------------------------------------------------------------
  test("AC11: run-start with missing run_id returns 400", async () => {
    const res = mockRes();
    await runStart(mockReq({ started: "x", started_epoch: 1, pid: 1 }), res);
    assert.equal(res._status, 400);
  });

  // ---------------------------------------------------------------------------
  // AC12 — Invalid cause on run-end is normalized to "unknown" (won't break
  //        the read-back surface if a writer sends a typo)
  // ---------------------------------------------------------------------------
  test("AC12: run-end with invalid cause normalizes to term_reason=unknown", async () => {
    await runStart(
      mockReq({
        run_id: "run-hhh",
        started: "2026-05-19T10:00:00Z",
        started_epoch: 1747648800,
        pid: process.pid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runEnd(mockReq({ run_id: "run-hhh", cause: "wat-is-this", ended_epoch: 1747677600 }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.term_reason, "unknown");
  });

  // ---------------------------------------------------------------------------
  // AC13 (issue #898) — run-end with cause "interrupted" (the reap-on-exit
  //        backstop's clean-exit cause) records status=ended/interrupted, NOT
  //        killed/crash. A run interrupted by `systemctl restart` / SIGTERM is
  //        recorded deterministically and distinctly from a genuine crash.
  // ---------------------------------------------------------------------------
  test("AC13: run-end cause=interrupted → status=ended, term_reason=interrupted", async () => {
    await runStart(
      mockReq({
        run_id: "run-iii",
        started: "2026-06-02T10:00:00Z",
        started_epoch: 1748858400,
        pid: process.pid,
        trigger: "morning-timer",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runEnd(
      mockReq({ run_id: "run-iii", cause: "interrupted", ended_epoch: 1748862000, exit_code: 0 }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.status, "ended");
    assert.equal(res._body.term_reason, "interrupted");

    const row = await redis.hgetall("hydra:autopilot:run:run-iii");
    assert.equal(row.status, "ended");
    assert.equal(row.term_reason, "interrupted");
    assert.equal(row.exit_code, "0");
  });

  // ---------------------------------------------------------------------------
  // AC14 (issue #898) — sweeper of a dead-pid running row that carries a
  //        recorded clean exit (exit_code === "0") promotes to
  //        status=ended/interrupted, NOT killed/crash. This is the case where
  //        an exit hook stamped a clean exit but the terminal run-end POST
  //        never landed.
  // ---------------------------------------------------------------------------
  test("AC14: sweeper of dead-pid running row with exit_code=0 → ended/interrupted", async () => {
    const deadPid = 2147483646;
    const startedEpoch = Math.floor(Date.now() / 1000) - 300;
    await runStart(
      mockReq({
        run_id: "run-jjj",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: deadPid,
        trigger: "overnight-timer",
        limits: {},
      }),
      mockRes(),
    );
    // Simulate an exit hook that recorded a clean exit code but whose run-end
    // POST never flipped the status off "running".
    await redis.hset("hydra:autopilot:run:run-jjj", "exit_code", "0");

    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._body.status, "ended");
    assert.equal(res._body.term_reason, "interrupted");

    const row = await redis.hgetall("hydra:autopilot:run:run-jjj");
    assert.equal(row.status, "ended");
    assert.equal(row.term_reason, "interrupted");
  });

  // ---------------------------------------------------------------------------
  // AC15 (issue #898) — crash is RESERVED: a dead-pid running row with NO
  //        recorded exit code (the process is gone and nobody recorded a clean
  //        exit) still sweeps to killed/crash. Guards against the fix
  //        accidentally relabelling genuine crashes as clean ends.
  // ---------------------------------------------------------------------------
  test("AC15: sweeper of dead-pid running row with no exit_code → killed/crash", async () => {
    const deadPid = 2147483646;
    const startedEpoch = Math.floor(Date.now() / 1000) - 300;
    await runStart(
      mockReq({
        run_id: "run-kkk",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: deadPid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._body.status, "killed");
    assert.equal(res._body.term_reason, "crash");

    const row = await redis.hgetall("hydra:autopilot:run:run-kkk");
    assert.equal(row.status, "killed");
    assert.equal(row.term_reason, "crash");
  });

  // ---------------------------------------------------------------------------
  // AC16 (issue #898) — sweeper of a dead-pid running row with a NON-ZERO
  //        recorded exit code sweeps to killed/crash with the honest exit.
  // ---------------------------------------------------------------------------
  test("AC16: sweeper of dead-pid running row with non-zero exit_code → killed/crash", async () => {
    const deadPid = 2147483646;
    const startedEpoch = Math.floor(Date.now() / 1000) - 300;
    await runStart(
      mockReq({
        run_id: "run-lll",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: deadPid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );
    await redis.hset("hydra:autopilot:run:run-lll", "exit_code", "137");

    const res = mockRes();
    await runsCurrent({ method: "GET" } as any, res);
    assert.equal(res._body.status, "killed");
    assert.equal(res._body.term_reason, "crash");
  });
});
