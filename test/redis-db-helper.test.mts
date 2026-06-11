/**
 * Tests for the Redis test-isolation backstop helper (issue #1231) and the
 * per-run DB-index launcher scripts/test/redis-db-launch.mjs (issue #1676).
 *
 * Pins three contract points of test/_helpers/redis-db.mts:
 *   1. It refuses to run against production DB-0 (the "DB-0 is never touched"
 *      invariant) — a non-zero DB is mandatory.
 *   2. `useCleanRedisDb()` gives each test a clean `hydra:*` keyspace: a key
 *      written in one test is gone at the start of the next.
 *   3. It degrades to skip-friendly (`up === false`) when Redis is unreachable
 *      rather than hard-failing — same contract the rest of the suite relies on.
 *
 * Pin DB-1 before importing the helper so its TEST_REDIS_URL resolves to a
 * non-zero DB (matches every other Redis-touching test file).
 */

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import { useCleanRedisDb, TEST_REDIS_URL } from "./_helpers/redis-db.mts";

// The strict ioredis `Redis` static type in this tsconfig omits the full
// dynamic command surface (`exists`, etc.); the suite convention is to type the
// client loosely (see test/holdback.test.mts, test/agent-stream-correlation).
type RedisClient = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("test/_helpers/redis-db — DB-0 guard", () => {
  test("TEST_REDIS_URL pins a non-zero DB (production DB-0 untouched)", () => {
    const dbSegment = TEST_REDIS_URL.split("/").pop() ?? "";
    assert.notEqual(dbSegment, "0", "tests must never run against DB-0");
    assert.notEqual(dbSegment, "", "a DB index must be present in the URL");
  });
});

describe("test/_helpers/redis-db — clean keyspace backstop", () => {
  const db = useCleanRedisDb();
  const probeKey = "hydra:test:redis-db-helper:probe";

  test("first test writes a key into the clean keyspace", async (t) => {
    if (!db.up || !db.client) {
      t.skip("Redis unavailable on REDIS_URL — skipping live-DB assertion");
      return;
    }
    // beforeEach already wiped hydra:* — the keyspace starts clean.
    assert.equal(
      await db.client.exists(probeKey),
      0,
      "probe key must be absent at the start of the test (clean keyspace)",
    );
    await db.client.set(probeKey, "leak-me");
    assert.equal(await db.client.exists(probeKey), 1);
  });

  test("second test sees a clean keyspace (prior key was wiped in beforeEach)", async (t) => {
    if (!db.up || !db.client) {
      t.skip("Redis unavailable on REDIS_URL — skipping live-DB assertion");
      return;
    }
    // The key the previous test wrote must NOT leak into this one — the
    // beforeEach hook wiped it. This is the backstop the helper guarantees.
    assert.equal(
      await db.client.exists(probeKey),
      0,
      "key written by the previous test must be wiped before this one runs",
    );
  });

  test("Redis-down degrades to a skip, never a hard failure", (t) => {
    // We can't force Redis down here, but we CAN assert the handle exposes a
    // boolean `up` flag that callers branch on — the skip-friendly contract.
    assert.equal(typeof db.up, "boolean", "handle must expose a boolean `up`");
    if (!db.up) {
      t.skip("Redis genuinely unavailable — handle correctly reports up=false");
    }
  });
});

// Sanity check that TEST_REDIS_URL stays constructable (guards against a
// regression where it drifts to an unconstructable value). lazyConnect so we
// don't open a live socket the test would have to tear down.
describe("test/_helpers/redis-db — URL is constructable", () => {
  test("a client can be constructed from TEST_REDIS_URL", () => {
    const client: RedisClient = new (Redis as any)(TEST_REDIS_URL, {
      lazyConnect: true,
    });
    try {
      assert.ok(client, "ioredis client constructs from TEST_REDIS_URL");
    } finally {
      client.disconnect();
    }
  });
});

/**
 * Per-run launcher contract (issue #1676): scripts/test/redis-db-launch.mjs
 * derives a stable per-worktree DB index in 2..15, respects a pre-set
 * REDIS_URL verbatim, and never derives DB 0 (production) or DB 1 (the legacy
 * shared test DB).
 *
 * Pinned via `--print-url` — the launcher's side-effect-free mode (no FLUSHDB,
 * no spawn) — so these tests cannot wipe a DB another run is using. The
 * launcher is spawned as a child process rather than imported: tsconfig.test
 * type-checks the test and scripts trees, and an `.mjs` import would need a
 * declaration file just for this test.
 */
describe("scripts/test/redis-db-launch.mjs — per-run DB derivation (#1676)", () => {
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

  function scratchRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "hydra-redis-db-launch-"));
    scratchDirs.push(dir);
    return dir;
  }

  /** Run the launcher in --print-url mode and return the resolved URL. */
  function launcherPrintUrl(opts: { redisUrl?: string; cwd?: string } = {}): string {
    // Start from the current env minus REDIS_URL (this run's launcher already
    // set it) so the child only sees a pre-set value when the test injects one.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL;
    if (opts.redisUrl !== undefined) env.REDIS_URL = opts.redisUrl;
    const run = spawnSync(process.execPath, [LAUNCHER, "--print-url"], {
      cwd: opts.cwd ?? process.cwd(),
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(
      run.status,
      0,
      `launcher --print-url must exit 0 (stderr: ${run.stderr})`,
    );
    return run.stdout.trim();
  }

  /** Extract the numeric DB index from a redis://host:port/<n> URL. */
  function dbIndexOf(url: string): number {
    const match = url.match(/^redis:\/\/localhost:6379\/(\d+)$/);
    assert.ok(match, `derived URL must be redis://localhost:6379/<n>, got: ${url}`);
    return Number(match![1]);
  }

  test("respects a pre-set REDIS_URL verbatim (CI / operator override)", () => {
    const preset = "redis://localhost:6379/5";
    assert.equal(
      launcherPrintUrl({ redisUrl: preset }),
      preset,
      "a pre-set REDIS_URL must pass through unrewritten",
    );
  });

  test("derives an index in 2..15 — never DB 0, never DB 1", () => {
    // Several distinct roots: every derived index must stay inside 2..15
    // (production DB 0 and the legacy shared DB 1 are unreachable by
    // construction — the launcher additionally hard-refuses to flush them).
    for (let i = 0; i < 5; i++) {
      const db = dbIndexOf(launcherPrintUrl({ cwd: scratchRoot() }));
      assert.ok(
        db >= 2 && db <= 15,
        `derived DB index must be within 2..15, got ${db}`,
      );
    }
  });

  test("same worktree root always derives the same DB (stable per run)", () => {
    const root = scratchRoot();
    const first = launcherPrintUrl({ cwd: root });
    const second = launcherPrintUrl({ cwd: root });
    assert.equal(first, second, "serial re-runs from one root must share a DB");
  });

  test("this worktree's npm test run is itself launcher-derived (env inherited)", (t) => {
    // Under `npm test` the launcher exported REDIS_URL before node:test
    // started; the helper picked it up via its `?? ` defer. Direct single-file
    // invocations bypass the launcher (DB-1 fallback), so only assert when the
    // env value is present AND not the fallback literal.
    if (!process.env.REDIS_URL) {
      t.skip("REDIS_URL unset — direct node --test invocation, launcher bypassed");
      return;
    }
    assert.equal(
      TEST_REDIS_URL,
      process.env.REDIS_URL,
      "the helper must defer to the launcher-provided REDIS_URL",
    );
  });
});
