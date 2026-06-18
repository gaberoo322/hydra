/**
 * Regression tests for the /api/autopilot/runs/:runId/log + /journal surface
 * (issue #499, slice 3 of epic #496).
 *
 * Slice 3 builds the "Why did that crash?" log-tail endpoints — read-only
 * surfaces over `/tmp/hydra-autopilot-nightly.log`(.prev) and `journalctl
 * --user -u hydra-autopilot.service`. The endpoints serve plain text for
 * the dashboard's collapsible log panel.
 *
 * Tests verify:
 *   AC1  — GET /log?tail=N returns last N lines from the LIVE log when
 *          runId == state.json.run_id
 *   AC2  — GET /log serves .log.prev when runId matches the prior run and
 *          .prev mtime is within tolerance of started_epoch
 *   AC3  — GET /log returns 404 when .prev mtime is too far from
 *          started_epoch (rotated past the window)
 *   AC4  — GET /log returns 404 for an unknown runId
 *   AC5  — GET /log returns 400 for tail outside [1, 2000]
 *   AC6  — GET /log default tail is 50 when query param absent
 *   AC7  — GET /journal spawns argv array (no shell), reads server-side
 *          --since/--until from the Redis hash (not from the request)
 *   AC8  — GET /journal returns 404 for unknown runId
 *   AC9  — GET /journal truncates output at 1MB with a marker line
 *   AC10 — GET /journal SIGTERMs at 10s timeout with a marker line
 *   AC11 — sanitizeIso rejects malformed strings (defense-in-depth check)
 *   AC12 — slice-1/2 schema closure: this slice writes NO new keys to
 *          hydra:autopilot:run:<id> (proves separation; AC10 of slice 2
 *          still passes)
 *
 * Uses Redis DB 1 — never touches production. File-level after() closes
 * the Redis client (PR #518 lesson). Uses tmp files under
 * os.tmpdir()/autopilot-logs-test-<pid> to avoid clobbering /tmp/hydra-*.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;
let tmpDir: string;
let logPath: string;
let logPrevPath: string;
let statePath: string;
let journalShimPath: string;

async function cleanKeys() {
  const keys = await redis.keys("hydra:autopilot:*");
  if (keys.length > 0) await redis.del(...keys);
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

async function seedRunRow(runId: string, startedEpoch: number, opts: { ended_epoch?: number } = {}) {
  const startedIso = new Date(startedEpoch * 1000).toISOString();
  const row: Record<string, string> = {
    run_id: runId,
    started: startedIso,
    started_epoch: String(startedEpoch),
    status: opts.ended_epoch ? "ended" : "running",
    trigger: "manual",
    pid: String(process.pid),
    limits: "{}",
    turns: "0",
    dispatches: "0",
    cumulative_tokens: "0",
    idle_turns: "0",
    last_heartbeat_epoch: String(startedEpoch),
  };
  if (opts.ended_epoch) row.ended_epoch = String(opts.ended_epoch);
  await redis.hset(`hydra:autopilot:run:${runId}`, row);
  await redis.zadd("hydra:autopilot:runs:index", startedEpoch, runId);
}

async function writeState(runId: string) {
  await writeFile(statePath, JSON.stringify({ run_id: runId, pid: process.pid }), "utf-8");
}

describe("autopilot logs API (issue #499, slice 3)", () => {
  let createAutopilotRouter: any;
  let logHandler: any;
  let journalHandler: any;
  let helpers: any;

  before(async () => {
    redis = new Redis(REDIS_URL);
    tmpDir = await mkdtemp(join(tmpdir(), "autopilot-logs-test-"));
    logPath = join(tmpDir, "nightly.log");
    logPrevPath = join(tmpDir, "nightly.log.prev");
    statePath = join(tmpDir, "state.json");

    // Build a deterministic "journalctl" shim: a tiny shell script that
    // prints its argv (one per line) so we can assert the exact arg vector.
    // The /journal endpoint will spawn THIS instead of real journalctl when
    // HYDRA_AUTOPILOT_JOURNAL_CMD is set.
    journalShimPath = join(tmpDir, "journalctl-shim.sh");
    await writeFile(
      journalShimPath,
      "#!/usr/bin/env bash\nfor a in \"$@\"; do echo \"ARG:$a\"; done\necho 'STDOUT_END'\n",
      "utf-8",
    );
    await chmod(journalShimPath, 0o755);

    process.env.HYDRA_AUTOPILOT_LOG = logPath;
    process.env.HYDRA_AUTOPILOT_LOG_PREV = logPrevPath;
    process.env.HYDRA_AUTOPILOT_STATE = statePath;
    process.env.HYDRA_AUTOPILOT_JOURNAL_CMD = journalShimPath;
    process.env.HYDRA_AUTOPILOT_JOURNAL_UNIT = "hydra-autopilot.service";

    const mod = await import("../src/api/autopilot-log.ts");
    createAutopilotRouter = mod.createAutopilotLogRouter;
    helpers = mod;
    const router = createAutopilotRouter();
    logHandler = findHandler(router, "GET", "/autopilot/runs/:runId/log");
    journalHandler = findHandler(router, "GET", "/autopilot/runs/:runId/journal");
    assert.ok(logHandler, "log handler must exist");
    assert.ok(journalHandler, "journal handler must exist");
  });

  beforeEach(async () => {
    await cleanKeys();
    // Reset state.json between tests so the "live" predicate is per-test.
    await writeFile(statePath, "{}", "utf-8");
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    delete process.env.HYDRA_AUTOPILOT_LOG;
    delete process.env.HYDRA_AUTOPILOT_LOG_PREV;
    delete process.env.HYDRA_AUTOPILOT_STATE;
    delete process.env.HYDRA_AUTOPILOT_JOURNAL_CMD;
    delete process.env.HYDRA_AUTOPILOT_JOURNAL_UNIT;
  });

  // ---------------------------------------------------------------------------
  // AC1 — live-log serve: runId matches state.json.run_id
  // ---------------------------------------------------------------------------
  test("AC1: serves live log when runId == state.json.run_id, respects tail=N", async () => {
    const runId = "run-live-1";
    await seedRunRow(runId, Math.floor(Date.now() / 1000) - 60);
    await writeState(runId);
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(logPath, body, "utf-8");

    const res = mockRes();
    await logHandler(mockReq({ runId }, { tail: "10" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._headers["x-autopilot-log-source"], "live");
    const tail = String(res._body).split("\n");
    assert.equal(tail.length, 10);
    assert.equal(tail[0], "line 191");
    assert.equal(tail[9], "line 200");
  });

  // ---------------------------------------------------------------------------
  // AC2 — serves .log.prev when runId is the immediately prior run
  // ---------------------------------------------------------------------------
  test("AC2: serves .log.prev when runId.started_epoch ~= prev mtime", async () => {
    const runId = "run-prev-1";
    const now = Math.floor(Date.now() / 1000);
    const startedEpoch = now - 3600; // 1h ago
    await seedRunRow(runId, startedEpoch, { ended_epoch: now - 60 });
    // The CURRENT live run is a different run_id.
    await writeState("a-different-run");
    await writeFile(logPrevPath, "prev a\nprev b\nprev c\n", "utf-8");
    // Set prev mtime to match started_epoch (rotation happens at run-start).
    await utimes(logPrevPath, startedEpoch, startedEpoch);

    const res = mockRes();
    await logHandler(mockReq({ runId }, { tail: "10" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._headers["x-autopilot-log-source"], "prev");
    assert.equal(res._body, "prev a\nprev b\nprev c");
  });

  // ---------------------------------------------------------------------------
  // AC3 — 404 when .log.prev mtime is too far from started_epoch
  // ---------------------------------------------------------------------------
  test("AC3: 404 when prev mtime is outside tolerance (log rotated away)", async () => {
    const runId = "run-rotated";
    const now = Math.floor(Date.now() / 1000);
    const startedEpoch = now - 86400; // 1 day ago
    await seedRunRow(runId, startedEpoch, { ended_epoch: now - 86000 });
    await writeState("some-other-live");
    await writeFile(logPrevPath, "old\n", "utf-8");
    // mtime is "now" — 1 day off from startedEpoch, way outside the 5-min tolerance.
    await utimes(logPrevPath, now, now);

    const res = mockRes();
    await logHandler(mockReq({ runId }, {}), res);
    assert.equal(res._status, 404);
    assert.match(String(res._body.error || ""), /rotated/);
  });

  // ---------------------------------------------------------------------------
  // AC4 — 404 for unknown runId
  // ---------------------------------------------------------------------------
  test("AC4: 404 for unknown runId", async () => {
    const res = mockRes();
    await logHandler(mockReq({ runId: "no-such-run" }, {}), res);
    assert.equal(res._status, 404);
    assert.match(String(res._body.error || ""), /unknown run_id/);
  });

  // ---------------------------------------------------------------------------
  // AC5 — 400 for invalid tail
  // ---------------------------------------------------------------------------
  test("AC5: 400 for invalid tail (out of [1, 2000])", async () => {
    const runId = "run-tailcheck";
    await seedRunRow(runId, Math.floor(Date.now() / 1000));
    await writeState(runId);
    await writeFile(logPath, "x\n", "utf-8");

    for (const bad of ["0", "-1", "2001", "abc", "1.5"]) {
      const res = mockRes();
      await logHandler(mockReq({ runId }, { tail: bad }), res);
      assert.equal(res._status, 400, `tail=${bad} should be 400, got ${res._status}`);
    }
  });

  // ---------------------------------------------------------------------------
  // AC6 — default tail = 50 when query param absent
  // ---------------------------------------------------------------------------
  test("AC6: default tail is 50 lines when query param absent", async () => {
    const runId = "run-default-tail";
    await seedRunRow(runId, Math.floor(Date.now() / 1000));
    await writeState(runId);
    const body = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    await writeFile(logPath, body, "utf-8");

    const res = mockRes();
    await logHandler(mockReq({ runId }, {}), res);
    assert.equal(res._status, 200);
    const tail = String(res._body).split("\n");
    assert.equal(tail.length, 50);
    assert.equal(tail[0], "L51");
    assert.equal(tail[49], "L100");
  });

  // ---------------------------------------------------------------------------
  // AC7 — journal endpoint spawns argv array; --since/--until come from row
  // ---------------------------------------------------------------------------
  test("AC7: journal spawns argv array with --since/--until from Redis row", async () => {
    const runId = "run-journal-argv";
    const startedEpoch = Math.floor(Date.now() / 1000) - 600;
    const endedEpoch = startedEpoch + 300;
    await seedRunRow(runId, startedEpoch, { ended_epoch: endedEpoch });

    const res = mockRes();
    await journalHandler(mockReq({ runId }, {}), res);
    assert.equal(res._status, 200);
    const text = String(res._body);
    // The shim writes one "ARG:<arg>" line per argv element. Under the
    // override path the wrapper sends [unit, sinceIso, untilIso]. We verify
    // it's exactly 3 args and that the timestamps were derived from Redis,
    // not from the request.
    const argLines = text.split("\n").filter((l) => l.startsWith("ARG:"));
    assert.equal(argLines.length, 3, `expected 3 args, got: ${argLines.join("|")}`);
    assert.equal(argLines[0], "ARG:hydra-autopilot.service");
    assert.equal(argLines[1], `ARG:${new Date(startedEpoch * 1000).toISOString()}`);
    assert.equal(argLines[2], `ARG:${new Date(endedEpoch * 1000).toISOString()}`);
  });

  // ---------------------------------------------------------------------------
  // AC8 — journal 404 for unknown runId
  // ---------------------------------------------------------------------------
  test("AC8: journal returns 404 for unknown runId", async () => {
    const res = mockRes();
    await journalHandler(mockReq({ runId: "nope" }, {}), res);
    assert.equal(res._status, 404);
  });

  // ---------------------------------------------------------------------------
  // AC9 — journal truncates output at 1MB with marker
  // ---------------------------------------------------------------------------
  test("AC9: journal truncates >1MB output with marker line", async () => {
    // Swap in a shim that emits >1MB of output. We only do this inside the
    // test scope so other tests keep the small argv shim.
    const bigShim = join(tmpDir, "journalctl-big-shim.sh");
    await writeFile(
      bigShim,
      "#!/usr/bin/env bash\nyes 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' | head -c 2000000\n",
      "utf-8",
    );
    await chmod(bigShim, 0o755);
    const original = process.env.HYDRA_AUTOPILOT_JOURNAL_CMD;
    process.env.HYDRA_AUTOPILOT_JOURNAL_CMD = bigShim;
    try {
      // The spawn primitive moved to the Journal Adapter seam
      // (src/journal/exec.ts, issue #1958): `runJournal` reads the env knobs
      // (HYDRA_AUTOPILOT_JOURNAL_CMD / _TIMEOUT_MS) at call time, so a plain
      // static import picks up the env we mutate just above — no cache-busted
      // dynamic import needed. (The dedicated injectable-deps path lives on
      // readJournalSlice; here we drive the low-level primitive directly to
      // pin its output-cap behavior against a real >1MB shim.)
      const { runJournal } = await import("../src/journal/exec.ts");
      const r = await runJournal("hydra-autopilot.service", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z");
      assert.equal(r.truncated, true, "output >1MB must set truncated=true");
      assert.ok(r.text.length <= 1024 * 1024 + 500, `text should be ~capped, got ${r.text.length}`);
      assert.match(r.text, /output truncated at 1048576 bytes/);
    } finally {
      if (original) process.env.HYDRA_AUTOPILOT_JOURNAL_CMD = original;
    }
  });

  // ---------------------------------------------------------------------------
  // AC10 — journal SIGTERMs slow children (timeout)
  // ---------------------------------------------------------------------------
  test("AC10: journal SIGTERMs at timeout, with timed_out marker", async () => {
    // Slow shim that sleeps far longer than the (shortened) timeout. We use
    // HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS to make this a sub-second test
    // instead of forcing CI to wait the full production 10s budget.
    const slowShim = join(tmpDir, "journalctl-slow-shim.sh");
    await writeFile(
      slowShim,
      "#!/usr/bin/env bash\nsleep 30\necho 'never-reached'\n",
      "utf-8",
    );
    await chmod(slowShim, 0o755);
    const originalCmd = process.env.HYDRA_AUTOPILOT_JOURNAL_CMD;
    const originalTimeout = process.env.HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS;
    process.env.HYDRA_AUTOPILOT_JOURNAL_CMD = slowShim;
    process.env.HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS = "300";
    try {
      // Journal Adapter seam (issue #1958): runJournal reads the timeout env at
      // call time, so a static import suffices (no cache-bust query needed).
      const { runJournal } = await import("../src/journal/exec.ts");
      const start = Date.now();
      const r = await runJournal("hydra-autopilot.service", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z");
      const elapsed = Date.now() - start;
      assert.equal(r.timedOut, true, "slow journal must set timedOut=true");
      assert.match(r.text, /timed out after 300ms/);
      assert.ok(elapsed < 2500, `should kill near 300ms, took ${elapsed}ms`);
    } finally {
      if (originalCmd) process.env.HYDRA_AUTOPILOT_JOURNAL_CMD = originalCmd;
      if (originalTimeout) {
        process.env.HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS = originalTimeout;
      } else {
        delete process.env.HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // AC11 — sanitizeIso rejects junk (defense-in-depth)
  // ---------------------------------------------------------------------------
  test("AC11: sanitizeIso accepts valid ISO and rejects junk", async () => {
    // sanitizeIso moved to the Journal Adapter seam (src/journal/read.ts, issue
    // #1958) alongside the journal-slice accessor it guards. Imported lazily
    // inside the test for symmetry with the other Journal-seam imports; read.ts
    // has no env-derived module-eval constants, so a static import would also be
    // safe here.
    const { sanitizeIso } = await import("../src/journal/read.ts");
    assert.equal(sanitizeIso("2026-05-19T10:00:00Z"), "2026-05-19T10:00:00Z");
    assert.equal(sanitizeIso("2026-05-19T10:00:00.123Z"), "2026-05-19T10:00:00.123Z");
    assert.equal(sanitizeIso("2026-05-19T10:00:00+02:00"), "2026-05-19T10:00:00+02:00");
    assert.equal(sanitizeIso(""), null);
    assert.equal(sanitizeIso(null), null);
    assert.equal(sanitizeIso(undefined), null);
    assert.equal(sanitizeIso("2026-05-19"), null);
    assert.equal(sanitizeIso("$(rm -rf /)"), null);
    assert.equal(sanitizeIso("2026-05-19T10:00:00Z; ls"), null);
    assert.equal(sanitizeIso("2026-05-19T10:00:00Z && true"), null);
  });

  // ---------------------------------------------------------------------------
  // AC12 — schema closure: slice 3 writes NO new run-hash fields
  // ---------------------------------------------------------------------------
  test("AC12: log + journal endpoints write no fields to the run hash", async () => {
    const runId = "run-schema-closed";
    const startedEpoch = Math.floor(Date.now() / 1000);
    await seedRunRow(runId, startedEpoch);
    await writeState(runId);
    await writeFile(logPath, "x\n", "utf-8");
    const before = await redis.hgetall(`hydra:autopilot:run:${runId}`);

    await logHandler(mockReq({ runId }, { tail: "10" }), mockRes());
    await journalHandler(mockReq({ runId }, {}), mockRes());

    const after = await redis.hgetall(`hydra:autopilot:run:${runId}`);
    assert.deepEqual(after, before, "slice 3 must not mutate the run hash");
    // And no `:log` or `:journal` sidecar keys either — both endpoints are
    // read-only relative to Redis (filesystem + journalctl only).
    const sidecars = await redis.keys(`hydra:autopilot:run:${runId}:*`);
    assert.deepEqual(sidecars, [], `no sidecar keys allowed, got: ${sidecars.join(",")}`);
  });
});
