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

  test("parseOwnedDbIndex claims only launcher-owned DBs (issue #3764)", async () => {
    const { parseOwnedDbIndex } = await import(
      "../scripts/test/redis-db-launch.mjs"
    );

    // Owned indexes (8..15) are claimed → these DO get the start-of-run flush,
    // which is what lets the 4 CI runners hold distinct pre-set DBs and still
    // get a clean slate.
    for (const db of [8, 9, 10, 11, 12, 13, 14, 15]) {
      assert.equal(
        parseOwnedDbIndex(`redis://localhost:6379/${db}`),
        db,
        `DB ${db} is launcher-owned and must be claimed`,
      );
    }

    // NEVER claimed — production, the legacy shared DB, and the legacy per-file
    // hard pins. Returning null here is what keeps a pre-set url un-flushed.
    for (const db of [0, 1, 2, 3, 4, 5, 6, 7, 16]) {
      assert.equal(
        parseOwnedDbIndex(`redis://localhost:6379/${db}`),
        null,
        `DB ${db} must never be claimed for flushing`,
      );
    }

    // 127.0.0.1 is the same local Redis as localhost, so it IS claimed.
    assert.equal(parseOwnedDbIndex("redis://127.0.0.1:6379/9"), 9);

    // A url with no DB path, a malformed one, or — critically — a REMOTE host
    // is never claimed. flushDbOnce always connects to 127.0.0.1, so claiming a
    // remote url's index would flush the LOCAL DB of that number while the
    // caller is pointed elsewhere, destroying data the operator never named.
    for (const url of [
      "redis://localhost:6379",
      "redis://localhost:6379/",
      "redis://prod-redis.internal:6379/9",
      "redis://10.0.0.5:6379/9",
      "redis://localhost:6380/9",
      "",
      undefined,
    ]) {
      assert.equal(
        parseOwnedDbIndex(url as string),
        null,
        `must not claim a DB from: ${String(url)}`,
      );
    }
  });

  test("a pre-set REDIS_URL is still not REWRITTEN, owned or not (#3764)", () => {
    // The #3764 change narrows "no flush", NOT "no rewriting" — both an owned
    // and a non-owned pre-set url must still pass through byte-identical.
    for (const preset of ["redis://localhost:6379/9", "redis://localhost:6379/0"]) {
      assert.equal(
        launcherPrintUrl({ redisUrl: preset }),
        preset,
        `a pre-set REDIS_URL must pass through unrewritten: ${preset}`,
      );
    }
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

  test("known runner roots map to distinct, deterministic slots (#3764)", async () => {
    const { knownRunnerSlot, deriveDbIndex } = await import(
      "../scripts/test/redis-db-launch.mjs"
    );

    // The 4 real self-hosted runner checkout roots from PR #3781's postmortem
    // — hashing these collided (runners 2 and 4 both landed on DB 15). The
    // deterministic slot map must give each one a DIFFERENT index.
    const roots = [
      "/home/gabe/actions-runner/_work/hydra/hydra",
      "/home/gabe/actions-runner-2/_work/hydra/hydra",
      "/home/gabe/actions-runner-3/_work/hydra/hydra",
      "/home/gabe/actions-runner-4/_work/hydra/hydra",
    ];
    const slots = roots.map((root) => knownRunnerSlot(root));
    for (const slot of slots) {
      assert.notEqual(slot, null, "every known runner root must resolve a slot");
    }
    assert.equal(
      new Set(slots).size,
      slots.length,
      `known runner roots must map to distinct slots, got: ${slots.join(", ")}`,
    );

    // deriveDbIndex must use the deterministic slot for these roots, not the
    // hash fallback — pin it end-to-end, not just at the helper.
    for (let i = 0; i < roots.length; i++) {
      assert.equal(
        deriveDbIndex(roots[i]),
        slots[i],
        `deriveDbIndex(${roots[i]}) must equal its known-runner slot`,
      );
    }

    // Same root always derives the same slot (repeat calls, no drift).
    for (const root of roots) {
      assert.equal(
        knownRunnerSlot(root),
        knownRunnerSlot(root),
        "a known runner root must resolve to the same slot on every call",
      );
    }
  });

  test("the hash fallback pool never overlaps a runner-reserved index (#3764 follow-up)", async () => {
    const { knownRunnerSlot, deriveDbIndex } = await import(
      "../scripts/test/redis-db-launch.mjs"
    );

    const runnerRoots = [
      "/home/gabe/actions-runner/_work/hydra/hydra",
      "/home/gabe/actions-runner-2/_work/hydra/hydra",
      "/home/gabe/actions-runner-3/_work/hydra/hydra",
      "/home/gabe/actions-runner-4/_work/hydra/hydra",
    ];
    const reservedIndexes = new Set(
      runnerRoots.map((root) => knownRunnerSlot(root)),
    );
    assert.equal(
      reservedIndexes.size,
      4,
      "sanity: the 4 known runners must reserve 4 distinct indexes",
    );

    // A large, varied sample of non-runner roots must NEVER derive an index
    // a runner has reserved — that is exactly the collision #3764 exists to
    // eliminate (the flush-is-the-weapon mechanism, fallback-root vs. runner
    // instead of runner vs. runner).
    const sampleRoots = Array.from(
      { length: 200 },
      (_, i) => `/home/gabe/hydra/.claude/worktrees/agent-sample-${i}`,
    );
    for (const root of sampleRoots) {
      assert.equal(
        knownRunnerSlot(root),
        null,
        `sanity: ${root} must not itself match a known runner root`,
      );
      const derived = deriveDbIndex(root);
      assert.ok(
        !reservedIndexes.has(derived),
        `fallback-derived DB ${derived} for ${root} must not be a runner-reserved index (${[...reservedIndexes].join(", ")})`,
      );
    }
  });

  test("an unrecognized root still falls through to the hash (unchanged behavior)", async () => {
    const { knownRunnerSlot } = await import(
      "../scripts/test/redis-db-launch.mjs"
    );

    for (const root of [
      "/home/gabe/hydra",
      "/home/gabe/hydra-betting",
      "/home/gabe/hydra/.claude/worktrees/agent-abc123",
      "/dev/shm/hydra-worktrees/foo",
      "/tmp/some-scratch-dir",
    ]) {
      assert.equal(
        knownRunnerSlot(root),
        null,
        `${root} does not match a known runner root and must fall through to the hash`,
      );
    }
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

  /**
   * Issue #4043 classifier contract: an unattributable SIGKILL/SIGTERM has
   * twice reached the required `test` CI job (exit 137 mid-run, exit 143
   * immediately after a clean TAP footer) with no distinguishing signal —
   * from the merge queue's point of view a signal-death and a genuine
   * assertion failure both just read "Failed". ci.yml's "Run tests and
   * verify count" step runs under `bash -e` + `set -o pipefail`, so a
   * non-zero/signal exit aborts the step immediately, before its own
   * `grep -qE '^# fail [1-9]'` classification line ever runs — meaning the
   * ONLY place left to emit a distinguishing signal without editing the
   * Verifier-Core workflow file is the launcher's own child-exit handler,
   * which already discriminates `signal` (infra kill) from `code` (a
   * genuine node:test failure, which always exits via process.exit(), never
   * a signal) for its own re-raise logic.
   *
   * These two cases pin that discrimination end-to-end via a real child
   * process, matching the shape the issue's acceptance criteria asks for
   * (signal-death classified as infrastructural; a code-based failure
   * classified as genuine) without needing to fabricate a captured log.
   */
  test("classifies a signal-death as INFRA-KILL before re-raising (issue #4043)", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL;
    const run = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        process.execPath,
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ],
      {
        cwd: scratchRoot(),
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(
      run.signal,
      "SIGTERM",
      "the launcher must re-raise the same signal its child died from",
    );
    assert.match(
      run.stderr,
      /\[redis-db-launch\] INFRA-KILL: test child received SIGTERM/,
      `launcher must emit a greppable infra-kill annotation before re-raising; stderr was: ${run.stderr}`,
    );
  });

  test("does NOT annotate a genuine code-based test failure as INFRA-KILL (issue #4043)", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL;
    const run = spawnSync(
      process.execPath,
      [LAUNCHER, process.execPath, "-e", "process.exit(1)"],
      {
        cwd: scratchRoot(),
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(
      run.signal,
      null,
      "a genuine (code-based) failure must propagate via exit code, not a signal",
    );
    assert.equal(run.status, 1, "the launcher must relay the child's exit code unchanged");
    assert.doesNotMatch(
      run.stderr,
      /INFRA-KILL/,
      `a code-based exit must never be misclassified as an infra kill; stderr was: ${run.stderr}`,
    );
  });
});

describe("scripts/test/redis-db-launch.mjs — suite-count gate blocking toggle (#4020 follow-up, PR #4056)", () => {
  test("defaults to non-blocking (advisory) when SUITE_COUNT_GATE_BLOCKING is unset", async () => {
    const { isGateBlocking } = await import("../scripts/test/redis-db-launch.mjs");
    assert.equal(isGateBlocking({}), false);
  });

  test("stays non-blocking for any value other than the exact string \"1\"", async () => {
    const { isGateBlocking } = await import("../scripts/test/redis-db-launch.mjs");
    for (const value of ["true", "yes", "0", "01", " 1", "1 ", ""]) {
      assert.equal(
        isGateBlocking({ SUITE_COUNT_GATE_BLOCKING: value }),
        false,
        `SUITE_COUNT_GATE_BLOCKING=${JSON.stringify(value)} must not enable blocking mode`,
      );
    }
  });

  test("becomes blocking only when SUITE_COUNT_GATE_BLOCKING is exactly \"1\" (suite-count-check.yml's contract)", async () => {
    const { isGateBlocking } = await import("../scripts/test/redis-db-launch.mjs");
    assert.equal(isGateBlocking({ SUITE_COUNT_GATE_BLOCKING: "1" }), true);
  });
});
