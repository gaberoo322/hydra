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
      // #2034: run-start/run-end (lifecycle WRITES) live in
      // autopilot-lifecycle.ts; runs/current (READ projection) lives in
      // autopilot-runs.ts. This suite spans both, so it concatenates the two
      // sub-routers' route layers into one flat router (findHandler walks the
      // top-level stack only, not nested `.use()` mounts).
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
  // AC13b (issue #1903) — run-end with cause "handoff" (the clean baton-pass:
  //        a print-mode session that ended a turn with subagent slots still in
  //        flight) records status=ended/handoff. `handoff` is a VALID, CLEAN
  //        term_reason distinct from `interrupted` (the zero-slot bypass).
  // ---------------------------------------------------------------------------
  test("AC13b: run-end cause=handoff → status=ended, term_reason=handoff (#1903)", async () => {
    await runStart(
      mockReq({
        run_id: "run-handoff",
        started: "2026-06-15T10:00:00Z",
        started_epoch: 1750068000,
        pid: process.pid,
        trigger: "morning-timer",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runEnd(
      mockReq({ run_id: "run-handoff", cause: "handoff", ended_epoch: 1750071600, exit_code: 0 }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.status, "ended");
    assert.equal(res._body.term_reason, "handoff", "handoff is a valid term_reason, not normalized to unknown");

    const row = await redis.hgetall("hydra:autopilot:run:run-handoff");
    assert.equal(row.status, "ended");
    assert.equal(row.term_reason, "handoff");
    assert.equal(row.exit_code, "0");
    assert.equal(row.crash_detail, undefined, "a clean handoff persists no crash_detail");
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

  // ---------------------------------------------------------------------------
  // AC17 (issue #1079) — run-end with cause=crash persists a structured
  //        crash_detail on the run hash and surfaces it on the projected view.
  // ---------------------------------------------------------------------------
  test("AC17: run-end cause=crash persists + surfaces crash_detail", async () => {
    const startedEpoch = Math.floor(Date.now() / 1000) - 50;
    await runStart(
      mockReq({
        run_id: "run-crash1",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: process.pid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runEnd(
      mockReq({
        run_id: "run-crash1",
        cause: "crash",
        ended_epoch: startedEpoch + 10,
        exit_code: 139,
        crash_detail: {
          signal: "SEGV",
          exit_code: 139,
          log_tail: "slot_complete class=dev_orch\nfatal: segfault in tool\n",
        },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.term_reason, "crash");

    // Persisted as a JSON string on the hash (durable past log rotation).
    const row = await redis.hgetall("hydra:autopilot:run:run-crash1");
    assert.ok(row.crash_detail, "crash_detail should be persisted on the hash");
    const persisted = JSON.parse(row.crash_detail);
    assert.equal(persisted.signal, "SEGV");
    assert.equal(persisted.exit_code, 139);
    assert.match(persisted.log_tail, /segfault/);

    // Surfaced (parsed back to an object) on the projected runs/current view.
    const view = mockRes();
    await runsCurrent({ method: "GET" } as any, view);
    assert.ok(view._body.crash_detail, "crash_detail should surface on the view");
    assert.equal(view._body.crash_detail.signal, "SEGV");
    assert.equal(view._body.crash_detail.exit_code, 139);
  });

  // ---------------------------------------------------------------------------
  // AC18 (issue #1079) — a CLEAN stop never persists crash_detail even if a
  //        caller mistakenly sends one. The field stays a "died badly" signal.
  // ---------------------------------------------------------------------------
  test("AC18: run-end clean cause drops crash_detail", async () => {
    const startedEpoch = Math.floor(Date.now() / 1000) - 50;
    await runStart(
      mockReq({
        run_id: "run-clean1",
        started: new Date(startedEpoch * 1000).toISOString(),
        started_epoch: startedEpoch,
        pid: process.pid,
        trigger: "manual",
        limits: {},
      }),
      mockRes(),
    );

    const res = mockRes();
    await runEnd(
      mockReq({
        run_id: "run-clean1",
        cause: "budget",
        ended_epoch: startedEpoch + 10,
        crash_detail: { signal: "SEGV", log_tail: "should-be-ignored" },
      }),
      res,
    );
    assert.equal(res._body.term_reason, "budget");

    const row = await redis.hgetall("hydra:autopilot:run:run-clean1");
    assert.equal(row.crash_detail, undefined, "clean stop must not persist crash_detail");
  });

  // ---------------------------------------------------------------------------
  // AC19 (issue #1079) — the read-time sweeper of a dead-pid running row (no
  //        run-end POST ever landed) stamps a MINIMAL crash_detail so the
  //        fallback crash path is still drillable / distinguishable.
  // ---------------------------------------------------------------------------
  test("AC19: dead-pid sweep stamps minimal crash_detail", async () => {
    const deadPid = 2147483646;
    const startedEpoch = Math.floor(Date.now() / 1000) - 300;
    await runStart(
      mockReq({
        run_id: "run-sweep1",
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
    assert.equal(res._body.term_reason, "crash");
    assert.ok(res._body.crash_detail, "sweep should stamp a crash_detail");
    assert.match(res._body.crash_detail.last_action, /swept-dead-pid/);

    // Persisted on the hash too.
    const row = await redis.hgetall("hydra:autopilot:run:run-sweep1");
    assert.ok(row.crash_detail, "sweep crash_detail should be persisted");
  });
});

// ---------------------------------------------------------------------------
// projectRunView wedge cross-check (issue #1091) — Redis-free, pure projection.
//
// `wedge_likely` must only fire when BOTH the per-turn heartbeat (age_s) AND
// the continuously-written OS heartbeat are stale. A run mid-long-turn has a
// stale per-turn heartbeat but a fresh OS heartbeat → NOT a wedge.
// ---------------------------------------------------------------------------
describe("projectRunView wedge cross-check (issue #1091)", () => {
  let projectRunView: any;
  let WEDGE_AGE_THRESHOLD_S: number;

  beforeEach(async () => {
    if (!projectRunView) {
      const mod = await import("../src/autopilot/runs.ts");
      projectRunView = mod.projectRunView;
      WEDGE_AGE_THRESHOLD_S = mod.WEDGE_AGE_THRESHOLD_S;
    }
  });

  function runningRow(staleSeconds: number): Record<string, string> {
    const now = Math.floor(Date.now() / 1000);
    return {
      run_id: "wedge-test",
      status: "running",
      started_epoch: String(now - staleSeconds),
      last_heartbeat_epoch: String(now - staleSeconds),
      pid: String(process.pid),
    };
  }

  test("per-turn heartbeat stale but OS heartbeat FRESH → not a wedge (#1091)", () => {
    const row = runningRow(WEDGE_AGE_THRESHOLD_S + 300);
    const v = projectRunView(row, () => 30); // OS heartbeat fresh (30s old)
    assert.equal(v.wedge_likely, false);
  });

  test("both heartbeats stale → wedge_likely true (#1091)", () => {
    const row = runningRow(WEDGE_AGE_THRESHOLD_S + 300);
    const v = projectRunView(row, () => WEDGE_AGE_THRESHOLD_S + 300);
    assert.equal(v.wedge_likely, true);
  });

  test("OS heartbeat unreadable (null) fails open → wedge when per-turn stale (#1091)", () => {
    const row = runningRow(WEDGE_AGE_THRESHOLD_S + 300);
    const v = projectRunView(row, () => null);
    assert.equal(v.wedge_likely, true);
  });

  test("per-turn heartbeat fresh → never a wedge regardless of OS heartbeat (#1091)", () => {
    const row = runningRow(60); // per-turn fresh
    const v = projectRunView(row, () => WEDGE_AGE_THRESHOLD_S + 9999); // OS stale
    assert.equal(v.wedge_likely, false);
  });
});

// ---------------------------------------------------------------------------
// summarizeTerminationHealth — clean-termination-rate observability (#1352)
//
// Pure rollup over run digests. The retro learning loop is structurally
// starved when this rate sits at ~0 over dispatch-bearing runs (every run dies
// `interrupted` before its dispatches' terminal cycle records materialise), so
// a consumer can alarm on it. Pure → no Redis (the file-level `after` still
// closes the shared client for the Redis-backed suites above).
// ---------------------------------------------------------------------------
describe("summarizeTerminationHealth (issue #1352)", () => {
  let summarizeTerminationHealth: any;

  beforeEach(async () => {
    if (!summarizeTerminationHealth) {
      const mod = await import("../src/autopilot/runs.ts");
      summarizeTerminationHealth = mod.summarizeTerminationHealth;
    }
  });

  test("clean rate is the fraction of dispatch-bearing ended runs with a clean term_reason", () => {
    const h = summarizeTerminationHealth([
      { status: "ended", term_reason: "idle", dispatches: 3 },
      { status: "ended", term_reason: "budget", dispatches: 5 },
      { status: "ended", term_reason: "interrupted", dispatches: 7 },
      { status: "ended", term_reason: "wall_clock", dispatches: 2 },
    ]);
    assert.equal(h.endedRuns, 4);
    assert.equal(h.cleanRuns, 3);
    // All four runs are dispatch-bearing, so the gated denominator == endedRuns.
    assert.equal(h.dispatchBearingRuns, 4);
    assert.equal(h.dispatchBearingCleanRuns, 3);
    assert.equal(h.cleanTerminationRate, 0.75);
    assert.equal(h.endedDispatchTotal, 17);
  });

  test("the all-interrupted starvation case reports rate 0 with non-trivial dispatches (the #1352 alarm)", () => {
    const h = summarizeTerminationHealth([
      { status: "ended", term_reason: "interrupted", dispatches: 12 },
      { status: "ended", term_reason: "interrupted", dispatches: 8 },
      { status: "ended", term_reason: "interrupted", dispatches: 4 },
    ]);
    assert.equal(h.cleanTerminationRate, 0, "all interrupted → rate 0");
    assert.equal(h.cleanRuns, 0);
    assert.equal(h.endedRuns, 3);
    assert.equal(h.dispatchBearingRuns, 3);
    assert.equal(h.endedDispatchTotal, 24, "non-trivial dispatch total gates the alarm");
    assert.equal(h.starved, false, "below the 5-run sample floor the alarm stays off");
  });

  test("starved flips true at >=5 dispatch-bearing ended runs with zero clean terminations", () => {
    const runs = Array.from({ length: 5 }, () => ({
      status: "ended", term_reason: "interrupted", dispatches: 3,
    }));
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.endedRuns, 5);
    assert.equal(h.dispatchBearingRuns, 5);
    assert.equal(h.cleanRuns, 0);
    assert.equal(h.dispatchBearingCleanRuns, 0);
    assert.equal(h.starved, true, "the #1352 starvation alarm");
  });

  // issue #1815: the sample floor counts DISPATCH-BEARING runs, not raw ended
  // runs. A single dispatch-bearing run padded with four trivial disp=0
  // idle-drains is below the floor → no alarm, no false-positive.
  test("disp=0 idle-drains do NOT count toward the dispatch-bearing sample floor (#1815)", () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({
      status: "ended", term_reason: "interrupted", dispatches: i === 0 ? 6 : 0,
    }));
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.endedRuns, 5);
    assert.equal(h.dispatchBearingRuns, 1, "only one run did any dispatch work");
    assert.equal(h.starved, false, "one dispatch-bearing run is below the 5-run floor");
  });

  // issue #1815 — the headline regression: a board dominated by trivial
  // disp=0 idle-drains (clean `idle` term_reason) must NOT mask the starvation
  // alarm. Pre-#1815, the 6 clean idle-drains made cleanRuns>0 so starved stayed
  // false even though every dispatch-bearing run died interrupted.
  test("trivial disp=0 idle-drains do not mask the alarm; dispatch-bearing runs still drive it (#1815)", () => {
    const runs = [
      // 6 trivial idle-at-startup runs: clean term_reason but zero dispatch work.
      ...Array.from({ length: 6 }, () => ({
        status: "ended", term_reason: "idle", dispatches: 0,
      })),
      // 5 dispatch-bearing runs, every one dies interrupted mid-loop.
      ...Array.from({ length: 5 }, () => ({
        status: "ended", term_reason: "interrupted", dispatches: 4,
      })),
    ];
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.endedRuns, 11);
    assert.equal(h.cleanRuns, 6, "raw clean count still includes the trivial idle-drains");
    assert.equal(h.dispatchBearingRuns, 5, "only the dispatch-bearing runs gate the rate");
    assert.equal(h.dispatchBearingCleanRuns, 0);
    assert.equal(
      h.cleanTerminationRate,
      0,
      "dispatch-gated rate is 0/5 — the trivial idle-drains no longer inflate it",
    );
    assert.equal(
      h.starved,
      true,
      "alarm fires: 0 dispatch-bearing clean terminations over a non-trivial sample",
    );
  });

  // issue #1815/#1847: 1 clean of 6 dispatch-bearing runs = 0.167. Under the
  // #1847 rate floor (0.15) this still CLEARS the alarm because 0.167 >= 0.15
  // — the dispatch-bearing clean run keeps the rate above the floor. (Pre-#1847
  // this cleared via `dispatchBearingCleanRuns === 0` being false; the
  // assertion is unchanged but the mechanism is now the rate comparison.)
  test("a single dispatch-bearing clean termination clears the starvation alarm (1/6=0.167 >= floor, #1815/#1847)", () => {
    const runs = [
      { status: "ended", term_reason: "idle", dispatches: 3 },
      ...Array.from({ length: 5 }, () => ({
        status: "ended", term_reason: "interrupted", dispatches: 3,
      })),
    ];
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.dispatchBearingRuns, 6);
    assert.equal(h.dispatchBearingCleanRuns, 1);
    assert.equal(h.cleanTerminationRate, 1 / 6);
    assert.equal(
      h.starved,
      false,
      "1/6 = 0.167 is >= the 0.15 rate floor → alarm clears",
    );
  });

  // issue #1815: an idle clean termination with disp=0 does NOT clear the alarm,
  // because it is filtered out of the dispatch-bearing numerator entirely.
  test("a disp=0 idle clean run does NOT clear the alarm (#1815)", () => {
    const runs = [
      { status: "ended", term_reason: "idle", dispatches: 0 },
      ...Array.from({ length: 5 }, () => ({
        status: "ended", term_reason: "interrupted", dispatches: 3,
      })),
    ];
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.cleanRuns, 1, "raw clean count sees the idle-drain");
    assert.equal(h.dispatchBearingCleanRuns, 0, "but it is not dispatch-bearing");
    assert.equal(h.starved, true, "so it does not mask the alarm");
  });

  test("zero-dispatch all-interrupted runs do NOT alarm (ran-out-of-work, not starvation)", () => {
    const runs = Array.from({ length: 6 }, () => ({
      status: "ended", term_reason: "interrupted", dispatches: 0,
    }));
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.endedRuns, 6);
    assert.equal(h.dispatchBearingRuns, 0);
    assert.equal(h.endedDispatchTotal, 0);
    assert.equal(h.cleanTerminationRate, null, "no dispatch-bearing runs → no-data, not 0");
    assert.equal(h.starved, false, "no dispatch work → rate 0 is not the starvation signal");
  });

  test("crash / failure_backstop are NOT clean", () => {
    const h = summarizeTerminationHealth([
      { status: "ended", term_reason: "crash", dispatches: 1 },
      { status: "ended", term_reason: "failure_backstop", dispatches: 1 },
      { status: "ended", term_reason: "idle", dispatches: 1 },
    ]);
    assert.equal(h.cleanRuns, 1);
    assert.equal(h.dispatchBearingRuns, 3);
    assert.equal(h.dispatchBearingCleanRuns, 1);
    assert.equal(h.cleanTerminationRate, 1 / 3);
  });

  test("running rows are excluded from the denominator", () => {
    const h = summarizeTerminationHealth([
      { status: "running", term_reason: null, dispatches: 9 },
      { status: "ended", term_reason: "idle", dispatches: 2 },
    ]);
    assert.equal(h.endedRuns, 1, "only ended runs count");
    assert.equal(h.cleanRuns, 1);
    assert.equal(h.cleanTerminationRate, 1);
    assert.equal(h.endedDispatchTotal, 2, "running-run dispatches excluded");
  });

  test("no ended runs → null rate (no-data, not a misleading 0)", () => {
    const h = summarizeTerminationHealth([
      { status: "running", term_reason: null, dispatches: 3 },
    ]);
    assert.equal(h.cleanTerminationRate, null);
    assert.equal(h.endedRuns, 0);
    assert.equal(h.dispatchBearingRuns, 0);
  });

  test("empty input → null rate, zero counts", () => {
    const h = summarizeTerminationHealth([]);
    assert.deepEqual(h, {
      cleanTerminationRate: null,
      endedRuns: 0,
      cleanRuns: 0,
      dispatchBearingRuns: 0,
      dispatchBearingCleanRuns: 0,
      endedDispatchTotal: 0,
      starved: false,
    });
  });

  // issue #1847: the residual brittle-threshold gap on top of #1815. The live
  // 2026-06-14 evidence — 2 clean of 33 dispatch-bearing runs (~6%) — read
  // `starved: false` under the old `dispatchBearingCleanRuns === 0` boolean
  // because the count was 2, not 0. Under the #1847 rate floor (0.15) a ~6%
  // rate now TRIPS the alarm, surfacing the starved learning loop.
  test("a live-style 2/33 = 6% clean rate trips the alarm (the #1847 residual gap)", () => {
    const runs = [
      ...Array.from({ length: 2 }, () => ({
        status: "ended", term_reason: "budget", dispatches: 4,
      })),
      ...Array.from({ length: 31 }, () => ({
        status: "ended", term_reason: "interrupted", dispatches: 4,
      })),
    ];
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.dispatchBearingRuns, 33);
    assert.equal(h.dispatchBearingCleanRuns, 2);
    assert.equal(h.cleanTerminationRate, 2 / 33);
    assert.ok(2 / 33 < 0.15, "2/33 ≈ 0.0606 is below the 0.15 floor");
    assert.equal(
      h.starved,
      true,
      "~6% clean rate trips the alarm — pre-#1847 the `=== 0` boolean masked it as false",
    );
  });

  // issue #1847: boundary around the rate floor. 1 clean of 7 (≈0.143) is BELOW
  // 0.15 → trips; 1 clean of 5 (0.20) is ABOVE → clears. This is the exact
  // sharpening #1847 intends: one clean run no longer permanently silences the
  // alarm as the dispatch-bearing sample N grows.
  test("rate-floor boundary: 1/7 ≈ 0.143 trips, 1/5 = 0.20 clears (#1847)", () => {
    const trips = summarizeTerminationHealth([
      { status: "ended", term_reason: "idle", dispatches: 2 },
      ...Array.from({ length: 6 }, () => ({
        status: "ended", term_reason: "interrupted", dispatches: 3,
      })),
    ]);
    assert.equal(trips.dispatchBearingRuns, 7);
    assert.equal(trips.dispatchBearingCleanRuns, 1);
    assert.equal(trips.cleanTerminationRate, 1 / 7);
    assert.ok(1 / 7 < 0.15, "1/7 ≈ 0.143 is below the 0.15 floor");
    assert.equal(trips.starved, true, "1/7 below the floor → alarm fires");

    const clears = summarizeTerminationHealth([
      { status: "ended", term_reason: "idle", dispatches: 2 },
      ...Array.from({ length: 4 }, () => ({
        status: "ended", term_reason: "interrupted", dispatches: 3,
      })),
    ]);
    assert.equal(clears.dispatchBearingRuns, 5);
    assert.equal(clears.dispatchBearingCleanRuns, 1);
    assert.equal(clears.cleanTerminationRate, 0.2);
    assert.ok(0.2 >= 0.15, "1/5 = 0.20 is at/above the 0.15 floor");
    assert.equal(clears.starved, false, "1/5 above the floor → alarm clears");
  });

  // issue #1847: the 0/5 floor case still trips — the rate comparison preserves
  // the pre-#1847 `=== 0` behavior at the minimum sample size (0/5 = 0 < 0.15).
  test("0/5 still trips at the minimum sample floor (preserves pre-#1847 behavior)", () => {
    const runs = Array.from({ length: 5 }, () => ({
      status: "ended", term_reason: "interrupted", dispatches: 3,
    }));
    const h = summarizeTerminationHealth(runs);
    assert.equal(h.dispatchBearingRuns, 5);
    assert.equal(h.dispatchBearingCleanRuns, 0);
    assert.equal(h.cleanTerminationRate, 0);
    assert.equal(h.starved, true, "0/5 = 0 < 0.15 floor → alarm fires");
  });

  // issue #1903: `handoff` (the honest baton-pass — a clean exit with subagent
  // slots still in flight) counts as a CLEAN terminator, so a board of
  // baton-passes is no longer falsely starved.
  test("handoff counts as a clean terminator (#1903)", () => {
    const h = summarizeTerminationHealth([
      { status: "ended", term_reason: "handoff", dispatches: 4 },
      { status: "ended", term_reason: "handoff", dispatches: 6 },
    ]);
    assert.equal(h.dispatchBearingRuns, 2);
    assert.equal(h.dispatchBearingCleanRuns, 2, "both handoff runs are clean");
    assert.equal(h.cleanTerminationRate, 1, "all baton-passes are clean");
    assert.equal(h.starved, false);
  });

  // issue #1903: the headline reclassification — a board that was 100%
  // `interrupted` (rate 0, permanently starved) reads healthy once the honest
  // baton-passes are stamped `handoff`. Genuine zero-slot `interrupted` exits
  // stay non-clean, so the alarm still fires on REAL starvation.
  test("handoff reclassification clears the all-baton-pass false starvation, real starvation still alarms (#1903)", () => {
    const cleared = summarizeTerminationHealth(
      Array.from({ length: 5 }, () => ({
        status: "ended", term_reason: "handoff", dispatches: 4,
      })),
    );
    assert.equal(cleared.dispatchBearingCleanRuns, 5);
    assert.equal(cleared.cleanTerminationRate, 1);
    assert.equal(cleared.starved, false, "baton-passes are clean → not starved");

    const stillStarved = summarizeTerminationHealth(
      Array.from({ length: 5 }, () => ({
        status: "ended", term_reason: "interrupted", dispatches: 4,
      })),
    );
    assert.equal(stillStarved.cleanTerminationRate, 0);
    assert.equal(stillStarved.starved, true, "genuine zero-slot interrupted still alarms");
  });
});

// ---------------------------------------------------------------------------
// deriveInflightSlotSeed — cross-relaunch pipeline-slot seeding (#1352 Problem A)
//
// Pure map from the in-flight subagent dispatch ledger onto the fixed
// pipeline-slot occupancy decide.py reasons about. The seed is what bootstrap.sh
// injects into state.json.slots on a pace-gate relaunch so `_rule_idle_fallback`
// sees occupied > 0 (→ wait) instead of terminate(idle) → interrupted. Pure →
// no Redis.
// ---------------------------------------------------------------------------
describe("deriveInflightSlotSeed (issue #1352)", () => {
  let deriveInflightSlotSeed: any;

  beforeEach(async () => {
    if (!deriveInflightSlotSeed) {
      const mod = await import("../src/autopilot/runs.ts");
      deriveInflightSlotSeed = mod.deriveInflightSlotSeed;
    }
  });

  const sub = (over: Record<string, string>) => ({
    sessionId: "sess",
    skill: "hydra-dev",
    dispatchId: "disp",
    startedAt: "2026-06-14T00:00:00.000Z",
    ...over,
  });

  test("maps a pipeline-skill subagent onto its slot class with a non-null seed object", () => {
    const seed = deriveInflightSlotSeed([
      sub({ sessionId: "s1", skill: "hydra-dev", dispatchId: "d1" }),
    ]);
    assert.deepEqual(Object.keys(seed), ["dev_orch"]);
    assert.equal(seed.dev_orch.skill, "hydra-dev");
    assert.equal(seed.dev_orch.task_id, "d1", "task_id prefers dispatchId");
    assert.equal(seed.dev_orch._source, "inflight-seed");
    assert.equal(
      seed.dev_orch.started_epoch,
      Math.floor(Date.parse("2026-06-14T00:00:00.000Z") / 1000),
      "started_epoch derived from the dispatch startedAt (for orphaned-slot aging)",
    );
  });

  test("maps every distinct pipeline skill to its own slot class", () => {
    const seed = deriveInflightSlotSeed([
      sub({ sessionId: "a", skill: "hydra-dev" }),
      sub({ sessionId: "b", skill: "hydra-target-build" }),
      sub({ sessionId: "c", skill: "hydra-qa" }),
    ]);
    assert.deepEqual(Object.keys(seed).sort(), ["dev_orch", "dev_target", "qa_orch"]);
  });

  test("skips signal-class and unknown skills — only pipeline slots are seeded", () => {
    const seed = deriveInflightSlotSeed([
      sub({ sessionId: "x", skill: "hydra-sweep" }), // signal class, no slot
      sub({ sessionId: "y", skill: "hydra-cleanup" }), // signal class, no slot
      sub({ sessionId: "z", skill: "totally-made-up" }), // unknown skill
    ]);
    assert.deepEqual(seed, {}, "no pipeline subagents → empty seed (all-null slots)");
  });

  test("newest-wins on the ≤1-per-slot invariant (ledger is newest-first)", () => {
    // listActiveSubagentDispatches returns newest-first; the first row per slot
    // wins so the freshest dispatch occupies the slot.
    const seed = deriveInflightSlotSeed([
      sub({ sessionId: "new", skill: "hydra-dev", dispatchId: "newest", startedAt: "2026-06-14T05:00:00.000Z" }),
      sub({ sessionId: "old", skill: "hydra-dev", dispatchId: "older", startedAt: "2026-06-14T01:00:00.000Z" }),
    ]);
    assert.deepEqual(Object.keys(seed), ["dev_orch"]);
    assert.equal(seed.dev_orch.task_id, "newest", "the first (newest) row per slot wins");
  });

  test("falls back to sessionId for task_id when dispatchId is empty", () => {
    const seed = deriveInflightSlotSeed([
      sub({ sessionId: "sess-id", skill: "hydra-dev", dispatchId: "" }),
    ]);
    assert.equal(seed.dev_orch.task_id, "sess-id");
  });

  test("empty input → empty seed (no in-flight subagents)", () => {
    assert.deepEqual(deriveInflightSlotSeed([]), {});
  });
});
