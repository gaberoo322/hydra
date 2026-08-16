/**
 * Regression tests for scheduler mergeRate persistence (issue #208).
 *
 * Bug: `cyclesRun` was persisted to Redis via an atomic counter (issue #140),
 * but `cyclesMerged` and `cyclesFailed` lived only in in-memory `state`.
 * After every orchestrator restart, mergeRate snapped to 0% (numerator reset
 * but denominator persisted), which made the zero-output circuit breaker fire
 * on transient resets and produced misleading stall alerts.
 *
 * This test file verifies:
 * - AC1: incrSchedulerCyclesMerged / getSchedulerCyclesMerged round-trip and increment atomically.
 * - AC2: incrSchedulerCyclesFailed / getSchedulerCyclesFailed round-trip and increment atomically.
 * - AC3: After simulating two consecutive merges, the persisted counter reads 2.
 * - AC4: After "restarting" (reading from Redis), the merge counter is preserved.
 * - AC5: Concurrent INCRs produce no lost increments.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0). Since #4083 a
 * REDIS_URL that resolves to DB 0 is refused at module load, BEFORE the
 * beforeEach keyspace wipe could DEL live scheduler state: an ambient
 * production-pointing URL was the one path static inspection could not rule
 * out for the 1-in-4 full-run flake, so it fails loud instead of silently
 * racing the live orchestrator's INCRs.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Set test DB before any adapter imports
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

// #4083 hard refusal: never even load against DB 0. Under npm test the
// per-run launcher derives an isolated DB (8..15); under a raw single-file
// run the ?? fallback above pins DB 1. The only way to reach 0 is an ambient
// pre-set REDIS_URL — precisely the silent-path gap #4083 closed in the
// launcher — and this suite's beforeEach would otherwise DEL production
// scheduler keys while the live orchestrator INCRs them.
const { redisUrlDbIndex } = await import("../src/redis/connection.ts");
const RESOLVED_TEST_DB = redisUrlDbIndex(process.env.REDIS_URL);
if (RESOLVED_TEST_DB === 0) {
  throw new Error(
    `[scheduler-merge-rate-persistence] REDIS_URL=${process.env.REDIS_URL} resolves to ` +
      `DB 0 (production) — refusing to run. Unset REDIS_URL or point it at an ` +
      `isolated DB (issue #4083).`,
  );
}

const adapter = await import("../src/redis/scheduler.ts");

let testRedis: any;

const TEST_PREFIX = "hydra:scheduler";

describe("scheduler mergeRate persistence (issue #208)", () => {
  beforeEach(async () => {
    // #4083 AC1 diagnostic — permanent. One stderr line per test so any future
    // failing run's log answers "which DB was this suite actually on" without
    // re-instrumenting (the capture that settled #4072/#4083). stderr keeps
    // the TAP stdout surface (CI's MIN_TESTS grep) untouched.
    console.error(
      `[scheduler-merge-rate-persistence] REDIS_URL=${process.env.REDIS_URL} -> db ${RESOLVED_TEST_DB} (#4083 AC1 diagnostic)`,
    );
    if (!testRedis) {
      testRedis = new Redis(process.env.REDIS_URL);
    }
    // Clean scheduler keys used in tests
    const keys = await testRedis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    const keys = await testRedis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) await testRedis.del(...keys);
    if (testRedis) testRedis.disconnect();
  });

  // -------------------------------------------------------------------------
  // AC1 — atomic cyclesMerged increment + read
  // -------------------------------------------------------------------------

  describe("AC1 — incrSchedulerCyclesMerged is atomic and monotonic", () => {
    test("incrSchedulerCyclesMerged returns monotonically increasing values", async () => {
      const v1 = await adapter.incrSchedulerCyclesMerged();
      const v2 = await adapter.incrSchedulerCyclesMerged();
      const v3 = await adapter.incrSchedulerCyclesMerged();
      assert.equal(v1, 1);
      assert.equal(v2, 2);
      assert.equal(v3, 3);
    });

    test("getSchedulerCyclesMerged returns 0 when no counter exists", async () => {
      const v = await adapter.getSchedulerCyclesMerged();
      assert.equal(v, 0);
    });

    test("getSchedulerCyclesMerged matches latest INCR result", async () => {
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();
      const v = await adapter.getSchedulerCyclesMerged();
      assert.equal(v, 3);
    });
  });

  // -------------------------------------------------------------------------
  // AC2 — atomic cyclesFailed increment + read
  // -------------------------------------------------------------------------

  describe("AC2 — incrSchedulerCyclesFailed is atomic and monotonic", () => {
    test("incrSchedulerCyclesFailed returns monotonically increasing values", async () => {
      const v1 = await adapter.incrSchedulerCyclesFailed();
      const v2 = await adapter.incrSchedulerCyclesFailed();
      assert.equal(v1, 1);
      assert.equal(v2, 2);
    });

    test("getSchedulerCyclesFailed returns 0 when no counter exists", async () => {
      const v = await adapter.getSchedulerCyclesFailed();
      assert.equal(v, 0);
    });

    test("merged and failed counters are stored independently", async () => {
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesFailed();
      const merged = await adapter.getSchedulerCyclesMerged();
      const failed = await adapter.getSchedulerCyclesFailed();
      assert.equal(merged, 2);
      assert.equal(failed, 1);
    });
  });

  // -------------------------------------------------------------------------
  // AC2b (issue #1919) — atomic cyclesUnaccounted increment + read, stored
  // independently of merged/failed so the run = merged + failed + unaccounted
  // identity is restart-stable.
  // -------------------------------------------------------------------------

  describe("AC2b — incrSchedulerCyclesUnaccounted is atomic and independent (#1919)", () => {
    test("incrSchedulerCyclesUnaccounted returns monotonically increasing values", async () => {
      const v1 = await adapter.incrSchedulerCyclesUnaccounted();
      const v2 = await adapter.incrSchedulerCyclesUnaccounted();
      assert.equal(v1, 1);
      assert.equal(v2, 2);
    });

    test("getSchedulerCyclesUnaccounted returns 0 when no counter exists", async () => {
      const v = await adapter.getSchedulerCyclesUnaccounted();
      assert.equal(v, 0);
    });

    test("unaccounted counter is independent of merged/failed and the identity holds", async () => {
      for (let i = 0; i < 10; i++) await adapter.incrSchedulerCyclesRun();
      for (let i = 0; i < 6; i++) await adapter.incrSchedulerCyclesMerged();
      for (let i = 0; i < 3; i++) await adapter.incrSchedulerCyclesFailed();
      await adapter.incrSchedulerCyclesUnaccounted(); // 1

      const run = await adapter.getSchedulerCyclesRun();
      const merged = await adapter.getSchedulerCyclesMerged();
      const failed = await adapter.getSchedulerCyclesFailed();
      const unaccounted = await adapter.getSchedulerCyclesUnaccounted();

      assert.equal(unaccounted, 1);
      assert.equal(
        run,
        merged + failed + unaccounted,
        "run == merged + failed + unaccounted should hold across restart",
      );
    });
  });

  // -------------------------------------------------------------------------
  // AC3 — primary regression scenario from issue body:
  // "simulating two consecutive cycles, restarting state, and reading the
  //  counter returns 2"
  // -------------------------------------------------------------------------

  describe("AC3 — counters survive simulated restart", () => {
    test("two merge increments + restart still reports 2", async () => {
      // First "process": run two merges.
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();

      // "Restart" the orchestrator — wipe in-memory state, then load from Redis.
      const inMemoryAfterRestart = { cyclesMerged: 0 };
      const persisted = await adapter.getSchedulerCyclesMerged();
      if (persisted > 0) inMemoryAfterRestart.cyclesMerged = persisted;

      assert.equal(
        inMemoryAfterRestart.cyclesMerged,
        2,
        "after restart, in-memory cyclesMerged should reload from Redis",
      );
    });

    test("mergeRate is stable across restart given persisted counters", async () => {
      // Pretend the scheduler ran 10 cycles, of which 8 merged and 2 failed.
      for (let i = 0; i < 10; i++) await adapter.incrSchedulerCyclesRun();
      for (let i = 0; i < 8; i++) await adapter.incrSchedulerCyclesMerged();
      for (let i = 0; i < 2; i++) await adapter.incrSchedulerCyclesFailed();

      // Simulate /api/scheduler/status restart: reload everything from Redis.
      const cyclesRun = await adapter.getSchedulerCyclesRun();
      const cyclesMerged = await adapter.getSchedulerCyclesMerged();
      const cyclesFailed = await adapter.getSchedulerCyclesFailed();

      const mergeRate = cyclesRun > 0 ? Math.round((cyclesMerged / cyclesRun) * 100) : 0;

      assert.equal(cyclesRun, 10);
      assert.equal(cyclesMerged, 8);
      assert.equal(cyclesFailed, 2);
      assert.equal(
        mergeRate,
        80,
        "mergeRate should be 80% immediately after restart, not 0%",
      );
    });
  });

  // -------------------------------------------------------------------------
  // AC4 — concurrent merge increments produce no lost updates
  // -------------------------------------------------------------------------

  describe("AC4 — concurrent INCR has no lost updates", () => {
    test("concurrent merged INCRs produce unique sequential values", async () => {
      const N = 15;
      const results = await Promise.all(
        Array.from({ length: N }, () => adapter.incrSchedulerCyclesMerged()),
      );
      const sorted = [...results].sort((a, b) => a - b);
      for (let i = 0; i < N; i++) {
        assert.equal(sorted[i], i + 1, `expected ${i + 1}, got ${sorted[i]}`);
      }
      const final = await adapter.getSchedulerCyclesMerged();
      assert.equal(final, N);
    });

    test("concurrent failed INCRs produce unique sequential values", async () => {
      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, () => adapter.incrSchedulerCyclesFailed()),
      );
      const sorted = [...results].sort((a, b) => a - b);
      for (let i = 0; i < N; i++) {
        assert.equal(sorted[i], i + 1);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Isolation guards (issue #4083) — AC4's regression ratchet, scoped to the
// launcher's silent-path gap and the connection seam's DB-0 refusal. They live
// here (not in redis-db-helper.test.mts) because the issue's Files-in-scope
// contract names this file; per the issue, a per-run key-namespace rewrite was
// NOT ported from #4072 — this suite already routes through the REDIS_URL
// isolation seam, and the live repro pinned the flake on cross-run fallback-
// slot collision, not on a namespace the seam fails to cover.
// ---------------------------------------------------------------------------

describe("isolation guards (issue #4083)", () => {
  const LAUNCHER = fileURLToPath(
    new URL("../scripts/test/redis-db-launch.mjs", import.meta.url),
  );
  const scratchDirs: string[] = [];

  after(() => {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* intentional: best-effort scratch-dir cleanup on teardown */
      }
    }
  });

  test("launcher logs its resolved DB unconditionally and WARNs loudly on a pre-set non-owned REDIS_URL (AC2)", () => {
    // A pre-set REDIS_URL on DB 0 is respected verbatim and never flushed (the
    // #1676 contract) — but it must not be SILENT. Before #4083 this path
    // emitted zero log lines, making an ambient production-pointing URL
    // indistinguishable from a deliberate operator override. The spawned
    // command is a no-op (`node -e 0`), so nothing ever connects anywhere.
    const env: Record<string, string | undefined> = { ...process.env };
    env.REDIS_URL = "redis://localhost:6379"; // DB 0 — non-owned, never flushed
    const run = spawnSync(process.execPath, [LAUNCHER, process.execPath, "-e", "0"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(
      run.status,
      0,
      `launcher must propagate the no-op child's exit 0 (stderr: ${run.stderr})`,
    );
    assert.match(
      run.stderr,
      /per-run Redis DB <not launcher-owned> \(pre-set REDIS_URL\)/,
      "resolved DB + source must be logged unconditionally (the AC1 capture surface)",
    );
    assert.match(
      run.stderr,
      /WARN: pre-set REDIS_URL=redis:\/\/localhost:6379 resolves to a non-owned DB/,
      "a pre-set REDIS_URL on a non-owned DB must WARN loudly on stderr",
    );
    assert.match(
      run.stderr,
      /per-run isolation is NOT active/,
      "the WARN must say isolation is not active",
    );
  });

  test("assertNotProductionDbForTestProcess refuses DB 0 only inside a test process", async () => {
    const { assertNotProductionDbForTestProcess, redisUrlDbIndex } = await import(
      "../src/redis/connection.ts"
    );

    // URL parsing: an absent trailing index IS Redis's default — DB 0.
    assert.equal(redisUrlDbIndex("redis://localhost:6379"), 0);
    assert.equal(redisUrlDbIndex("redis://localhost:6379/1"), 1);
    assert.equal(redisUrlDbIndex("redis://localhost:6379/13"), 13);
    assert.ok(Number.isNaN(redisUrlDbIndex("not a url")));

    // Inside a node:test child (NODE_TEST_CONTEXT set), DB 0 is refused with a
    // typed, machine-readable code — never a bare Error.
    const testEnv = { NODE_TEST_CONTEXT: "child-v8" } as NodeJS.ProcessEnv;
    assert.throws(
      () => assertNotProductionDbForTestProcess("redis://localhost:6379", testEnv),
      (err: unknown) => (err as { code?: string }).code === "redis-seam",
      "DB 0 inside a test process must throw a RedisSeamError",
    );

    // Outside a test process (service, scripts) the default is untouched, and
    // an indexed URL passes even under test context.
    assert.doesNotThrow(() =>
      assertNotProductionDbForTestProcess("redis://localhost:6379", {}),
    );
    assert.doesNotThrow(() =>
      assertNotProductionDbForTestProcess("redis://localhost:6379/13", testEnv),
    );
  });

  test("getRedisConnection applies the DB-0 refusal end-to-end (subprocess wiring)", () => {
    // Probe process: NODE_TEST_CONTEXT set explicitly (deterministic whatever
    // invocation spawned this suite) and REDIS_URL pointed at DB 0. The seam
    // must throw BEFORE any client is constructed — no socket, no commands,
    // production untouched — which is what makes the guard a refusal rather
    // than a late connect error.
    const probeDir = mkdtempSync(join(tmpdir(), "hydra-4083-db0-guard-"));
    scratchDirs.push(probeDir);
    const probePath = join(probeDir, "probe.mts");
    writeFileSync(
      probePath,
      [
        "const mod = await import(process.argv[2]);",
        "try {",
        '  mod.getRedisConnection();',
        '  console.log("NO_THROW");',
        "} catch (err) {",
        '  console.log("THREW:" + (err && err.code));',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const connUrl = pathToFileURL(
      fileURLToPath(new URL("../src/redis/connection.ts", import.meta.url)),
    ).href;
    const env: Record<string, string | undefined> = { ...process.env };
    env.NODE_TEST_CONTEXT = "child-v8";
    env.REDIS_URL = "redis://localhost:6379";
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", probePath, connUrl],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(
      run.status,
      0,
      `probe must exit 0 after reporting (stdout: ${run.stdout}, stderr: ${run.stderr})`,
    );
    assert.match(
      run.stdout,
      /THREW:redis-seam/,
      "the seam must refuse a DB-0 URL inside a test process before connecting",
    );
  });
});
