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
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import { useCleanRedisDb, TEST_REDIS_URL } from "./_helpers/redis-db.mts";
import { ownedRedisDb, ownedDbSkip, ownedDbContext } from "./_helpers/owned-redis-db.mts";
import { fidelityBattery } from "./_helpers/watchdog-redis-shim.mts";

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

  /**
   * Issue #4083: the "resolved DB is not launcher-owned" branch used to be a
   * silent no-op — indistinguishable from an intentional operator override,
   * and the exact gap that let a pre-set REDIS_URL pointing at production
   * DB 0 (or the legacy shared DB 1, or a remote host) run tests against a
   * live-shared keyspace with zero trace in the log. These two cases pin the
   * launcher's silent-path fix: a non-owned resolved DB is now loud, and an
   * owned one (derived, the common case) stays exactly as before — no new
   * noise on the path every ordinary `npm test` run takes.
   */
  test("logs a loud WARN when a pre-set REDIS_URL resolves to a non-owned DB (issue #4083)", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL;
    env.REDIS_URL = "redis://localhost:6379/0";
    const run = spawnSync(
      process.execPath,
      [LAUNCHER, process.execPath, "-e", "process.exit(0)"],
      {
        cwd: scratchRoot(),
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(
      run.status,
      0,
      `launcher must relay the child's exit code unchanged; stderr: ${run.stderr}`,
    );
    assert.match(
      run.stderr,
      /\[redis-db-launch\] WARN: REDIS_URL=redis:\/\/localhost:6379\/0 resolves to a DB this launcher does not own/,
      `launcher must emit a loud WARN for a non-owned pre-set DB; stderr was: ${run.stderr}`,
    );
  });

  test("stays silent on the non-owned-DB WARN when the resolved DB is launcher-owned (issue #4083)", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL; // unset → derives an owned index (2..15 minus legacy pins)
    const run = spawnSync(
      process.execPath,
      [LAUNCHER, process.execPath, "-e", "process.exit(0)"],
      {
        cwd: scratchRoot(),
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(run.status, 0, `unexpected failure; stderr: ${run.stderr}`);
    assert.doesNotMatch(
      run.stderr,
      /WARN: REDIS_URL=.*resolves to a DB this launcher does not own/,
      `an owned/derived DB must never trip the non-owned-DB WARN; stderr was: ${run.stderr}`,
    );
  });
});

describe("scripts/test/redis-db-launch.mjs — redisChildEnv (issue #4183)", () => {
  const LAUNCHER = fileURLToPath(new URL("../scripts/test/redis-db-launch.mjs", import.meta.url));
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
    const dir = mkdtempSync(join(tmpdir(), "hydra-redis-child-env-"));
    scratchDirs.push(dir);
    return dir;
  }

  test("sets HYDRA_REDIS_DB when the resolved DB is launcher-owned", async () => {
    const { redisChildEnv } = await import("../scripts/test/redis-db-launch.mjs");
    const overlay = redisChildEnv({ FOO: "bar" }, "redis://localhost:6379/9", 9);
    assert.equal(overlay.REDIS_URL, "redis://localhost:6379/9");
    assert.equal(overlay.HYDRA_REDIS_DB, "9", "HYDRA_REDIS_DB must be the string form of the resolved db");
    assert.equal(overlay.FOO, "bar", "the base env must be preserved");
  });

  test("omits HYDRA_REDIS_DB when the resolved db is null (non-owned/production DB)", async () => {
    const { redisChildEnv } = await import("../scripts/test/redis-db-launch.mjs");
    const overlay = redisChildEnv({ FOO: "bar" }, "redis://localhost:6379/0", null);
    assert.equal(overlay.REDIS_URL, "redis://localhost:6379/0");
    assert.equal(
      "HYDRA_REDIS_DB" in overlay,
      false,
      "a non-owned resolved db must never set HYDRA_REDIS_DB — bash's own default-to-0 must apply",
    );
  });

  test("a spawned child observes HYDRA_REDIS_DB matching the launcher's resolved per-run DB", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL;
    const run = spawnSync(
      process.execPath,
      [LAUNCHER, process.execPath, "-e", "console.log(process.env.HYDRA_REDIS_DB)"],
      {
        cwd: scratchRoot(),
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(run.status, 0, `unexpected failure; stderr: ${run.stderr}`);
    const printedDb = run.stdout.trim();
    assert.match(printedDb, /^\d+$/, `child must observe a numeric HYDRA_REDIS_DB; got: ${JSON.stringify(printedDb)}`);
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

  test("becomes blocking only when SUITE_COUNT_GATE_BLOCKING is exactly \"1\" (reserved for #4141's zero-entry gate)", async () => {
    const { isGateBlocking } = await import("../scripts/test/redis-db-launch.mjs");
    assert.equal(isGateBlocking({ SUITE_COUNT_GATE_BLOCKING: "1" }), true);
  });
});

/**
 * Issue #4137 — an isolated retry that never finished must not be reported as
 * a confirmed suite-count drop.
 *
 * The retry ran under a 60s `spawnSync` timeout and never inspected the spawn
 * result. test/sync-skills.test.mts takes ~151s standalone, so every attempt
 * was SIGTERMed at 60s with a near-empty capture, and the gate published
 * "expected 15, observed 0 ... after 2 isolated retry attempts" — a fabricated
 * verdict about a file it never actually measured (CI run 32051075513).
 */
describe("scripts/test/redis-db-launch.mjs — incomplete-retry classification (#4137)", () => {
  test("a completed run is conclusive regardless of a non-zero exit status", async () => {
    const { describeIncompleteRun } = await import("../scripts/test/redis-db-launch.mjs");
    // status 1 is the ordinary "a test in this file failed" case: the child
    // RAN, so its capture is trustworthy and must still be compared.
    assert.equal(describeIncompleteRun({ status: 1, signal: null, error: undefined }), null);
    assert.equal(describeIncompleteRun({ status: 0, signal: null, error: undefined }), null);
  });

  test("a timeout kill is inconclusive and says so", async () => {
    const { describeIncompleteRun, RETRY_TIMEOUT_MS } = await import(
      "../scripts/test/redis-db-launch.mjs"
    );
    const err = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
    const reason = describeIncompleteRun({ status: null, signal: "SIGTERM", error: err });
    assert.ok(reason, "a timeout kill must produce an inconclusive reason, not null");
    assert.match(reason, /timed out/);
    assert.match(reason, new RegExp(String(RETRY_TIMEOUT_MS)));
  });

  test("a signal kill with no error object is still inconclusive", async () => {
    const { describeIncompleteRun } = await import("../scripts/test/redis-db-launch.mjs");
    assert.equal(
      describeIncompleteRun({ status: null, signal: "SIGKILL", error: undefined }),
      "killed by SIGKILL",
    );
  });

  test("a non-timeout spawn error is reported verbatim rather than swallowed", async () => {
    const { describeIncompleteRun } = await import("../scripts/test/redis-db-launch.mjs");
    const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    assert.equal(
      describeIncompleteRun({ status: null, signal: null, error: err }),
      "spawn error: ENOENT: no such file",
    );
  });

  test("the retry timeout clears the slowest known file standalone", async () => {
    const { RETRY_TIMEOUT_MS } = await import("../scripts/test/redis-db-launch.mjs");
    // test/sync-skills.test.mts measured ~151s standalone on an idle machine.
    // The ceiling must keep real headroom over that on a loaded CI runner, or
    // the #4137 false-verdict regression returns.
    assert.ok(
      RETRY_TIMEOUT_MS >= 300_000,
      `RETRY_TIMEOUT_MS=${RETRY_TIMEOUT_MS} is too tight for the suite's slowest file (~151s idle)`,
    );
  });
});

describe("scripts/test/redis-db-launch.mjs — zero-entry verdict wiring (#4141)", () => {
  // compareCapture's own tests cover the DECISION (partial vs zero). What only
  // the launcher can get wrong is the WIRING around it, and both mistakes here
  // are silent: a retried zero-entry file always passes, and a zero-entry
  // verdict left behind SUITE_COUNT_GATE_BLOCKING never fires. Neither shows up
  // as a failing assertion anywhere else, so they are pinned structurally.
  const SOURCE = readFileSync(
    join(import.meta.dirname, "..", "scripts", "test", "redis-db-launch.mjs"),
    "utf8",
  );

  /** Just the body of `retryShortfallsInIsolation`, where the retry decision lives. */
  function retryFnBody(): string {
    const start = SOURCE.indexOf("async function retryShortfallsInIsolation");
    assert.ok(start >= 0, "retryShortfallsInIsolation not found");
    const end = SOURCE.indexOf("\n}", start);
    assert.ok(end > start, "retryShortfallsInIsolation closing brace not found");
    return SOURCE.slice(start, end);
  }

  test("the retry loop iterates shortfalls only — a missing file is never retried", () => {
    // A by-name retry bypasses the glob that dropped the file, so it would
    // always pass and mask the regression. Scoped to the retry function on
    // purpose: the REPORTING block further down legitimately iterates
    // missingFiles to print them, and must not trip this.
    const body = retryFnBody();
    const loop = body.match(/for \(const shortfall of ([^)]+)\)/);
    assert.ok(loop, "expected the isolation-retry loop over shortfalls");
    assert.equal(loop[1].trim(), "result.shortfalls");
    assert.ok(
      !/for \(const \w+ of [^)]*missingFiles[^)]*\)/.test(body),
      "missingFiles must not be iterated inside the retry function — a by-name retry always passes",
    );
    // `missingFiles` may appear in the function only to be carried through to
    // the return value — never as the subject of a loop or a spawn argument.
    for (const line of body.split("\n")) {
      if (!line.includes("missingFiles")) continue;
      assert.ok(
        /^\s*(\/\/|\*)/.test(line) ||
          /const missingFiles = result\.missingFiles/.test(line) ||
          /missingFiles(,|\.length === 0)/.test(line),
        `unexpected use of missingFiles inside the retry function: ${line.trim()}`,
      );
    }
  });

  test("the zero-entry verdict does NOT exit on its own (#4141 reverted)", () => {
    // #4141 shipped this as an unconditional exit, on the argument that
    // truncation drops a tail and so cannot zero a file that ran. Production
    // falsified that within hours: test/design-concept-reconcile-check.test.mts
    // reported "expected 2, observed 0" on a PR whose diff was a workflow
    // comment and one test file. The premise confused a per-FILE tail with the
    // RUN's event-stream tail — for a 2-entry file the whole thing fits inside
    // the undrained window.
    //
    // It also could not catch its motivating case: `npm test` passes a
    // SHELL-EXPANDED test/*.test.mts, so a glob change that drops files drops
    // them from testFiles too, and compareCapture only inspects files in
    // testFiles. Nothing about "a file vanished" was ever reachable here.
    assert.ok(
      !/failing the run on the zero-entry verdict/.test(SOURCE),
      "the unconditional zero-entry exit is back; it false-positives on truncation and " +
        "cannot detect a dropped file, so it must not redden the required `test` job",
    );
    assert.ok(
      !/missingFiles\.length > 0 && \(code \?\? 1\) === 0/.test(SOURCE),
      "the zero-entry blocking guard is back",
    );
  });

  test("the zero-entry verdict is still REPORTED separately", () => {
    // Withdrawing the exit is not the same as withdrawing the signal.
    // "observed 0" reads differently from a partial shortfall and is worth
    // surfacing; only the process.exit is gone.
    assert.match(SOURCE, /FILE NEVER RAN/);
    assert.match(SOURCE, /missingFiles/);
  });
});

// =============================================================================
// File-set coverage gate (issue #4141).
//
// Its own top-level suite with its own lifecycle — a nested case would inherit
// a sibling's teardown timing.
//
// This is the only suite-count verdict that may block, and the reason is
// structural rather than empirical: it compares two static lists and reads no
// reporter capture, so `--test-force-exit`'s truncation (#4137) has no route
// into it. The zero-entry verdict was promoted on an empirical argument in
// #4141's first attempt and production falsified it within hours; the gate
// here does not rest on one.
// =============================================================================
describe("scripts/test/redis-db-launch.mjs — file-set coverage gate (issue #4141)", () => {
  const LAUNCHER = fileURLToPath(new URL("../scripts/test/redis-db-launch.mjs", import.meta.url));
  const covScratch: string[] = [];

  after(() => {
    for (const dir of covScratch) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* intentional: best-effort scratch-dir cleanup on teardown */
      }
    }
  });

  function covRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "hydra-coverage-gate-"));
    covScratch.push(dir);
    return dir;
  }

  /**
   * Run the launcher over a child that exits 0, naming ONE test file. The real
   * baseline lists 400+, so a full-suite run that names one file is by
   * definition missing the rest — the cheapest honest way to drive the gate
   * without fabricating a baseline.
   */
  function runLauncher(fullSuite: boolean) {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL;
    if (fullSuite) env.HYDRA_FULL_SUITE = "1";
    else delete env.HYDRA_FULL_SUITE;
    return spawnSync(
      process.execPath,
      [LAUNCHER, process.execPath, "-e", "process.exit(0)", "test/suite-count-check.test.mts"],
      { cwd: covRoot(), env, encoding: "utf8", timeout: 30_000 },
    );
  }

  test("isFullSuiteRun keys on the invocation, not on the shape of argv", async () => {
    const { isFullSuiteRun } = await import("../scripts/test/redis-db-launch.mjs");
    assert.equal(isFullSuiteRun({ HYDRA_FULL_SUITE: "1" }), true);
    assert.equal(isFullSuiteRun({}), false);
    assert.equal(isFullSuiteRun({ HYDRA_FULL_SUITE: "0" }), false);
    // Not truthiness — only the exact opt-in string, so a stray inherited
    // value cannot switch a subset run into full-suite mode.
    assert.equal(isFullSuiteRun({ HYDRA_FULL_SUITE: "true" }), false);
    assert.equal(isFullSuiteRun({ HYDRA_FULL_SUITE: "" }), false);
  });

  test("a full-suite run missing baselined files FAILS, and names them", () => {
    const run = runLauncher(true);
    assert.equal(run.status, 1, `expected the gate to block; stderr was: ${run.stderr}`);
    assert.match(
      run.stderr,
      /BASELINED FILE\(S\) WERE NOT RUN \(issue #4141\)/,
      `gate must name the class it detected; stderr was: ${run.stderr}`,
    );
    assert.match(
      run.stderr,
      /--update-baseline/,
      "a blocking gate must state the deterministic way to clear it",
    );
    // It must NOT be mistaken for the truncation artifact, which is advisory
    // and means something entirely different to whoever reads the log.
    assert.match(run.stderr, /This is NOT the #4137 truncation artifact/);
  });

  test("the SAME invocation without the full-suite opt-in does NOT fail — test:file stays usable", () => {
    // The safety property. `npm run test:file -- test/one.test.mts` omits 400+
    // baselined files by design; if that read as a drop, the single-file path
    // documented in CLAUDE.md would be unusable and the gate would be an
    // ambient poison pill.
    const run = runLauncher(false);
    assert.equal(run.status, 0, `a subset run must not be failed by the coverage gate; stderr was: ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /WERE NOT RUN \(issue #4141\)/);
  });

  test("package.json wires the opt-in on the full suite ONLY", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.match(
      pkg.scripts.test,
      /^HYDRA_FULL_SUITE=1 /,
      "the `test` script is the single place that declares a run to be the whole suite",
    );
    assert.doesNotMatch(
      pkg.scripts["test:file"],
      /HYDRA_FULL_SUITE/,
      "test:file runs a hand-picked subset and must never claim full-suite coverage",
    );
  });
});

describe("scripts/test/redis-db-launch.mjs — hermeticChildEnv (GLM off-switch isolation)", () => {
  test("points HYDRA_GLM_DISABLED_FILE at a never-existing path when unset", async () => {
    const { hermeticChildEnv, TEST_GLM_DISABLED_FILE } = await import("../scripts/test/redis-db-launch.mjs");
    const env = hermeticChildEnv({ FOO: "bar" });
    assert.equal(env.HYDRA_GLM_DISABLED_FILE, TEST_GLM_DISABLED_FILE);
    assert.equal(env.FOO, "bar", "the base env must be preserved");
    assert.equal(existsSync(TEST_GLM_DISABLED_FILE), false);
  });

  test("a caller-set HYDRA_GLM_DISABLED_FILE is kept verbatim", async () => {
    const { hermeticChildEnv } = await import("../scripts/test/redis-db-launch.mjs");
    assert.equal(hermeticChildEnv({ HYDRA_GLM_DISABLED_FILE: "/x" }).HYDRA_GLM_DISABLED_FILE, "/x");
  });
});

// Issue #5062: no test may hand a live Redis selector one of the launcher's
// pool indexes as a literal — a concurrent run owns that index and FLUSHDBs it.
// The scan matches WHOLE-FILE text, not line by line, so an argv list or call
// split across lines is still caught. Pure URL string literals
// (redis://host:port/N) stay benign (design concept INV-5): nothing here
// selects a DB from them.
describe("no test file hardcodes a launcher-pool Redis DB index (issue #5062)", () => {
  interface SelectorPattern {
    shape: string;
    re: RegExp;
  }

  async function selectorPatterns(): Promise<SelectorPattern[]> {
    const { ALLOWED_DB_INDEXES } = await import("../scripts/test/redis-db-launch.mjs");
    // A pool index as a whole number, never the prefix of a longer one (90, 9.5).
    const idx = `(?:${(ALLOWED_DB_INDEXES as number[]).join("|")})(?![\\d.])`;
    const q = "[\"'`]";
    const val = `(?:${q}${idx}${q}|${idx})`; // quoted or bare numeric
    // A DB-index-shaped name: its FINAL segment is DB (FOO_DB, REDIS_DB,
    // SELECTED_DB, OWNED_DB, HYDRA_REDIS_DB), REDISDB, or camel *Db (redisDb).
    // A leading DB segment (DB_PORT, DB_HOST) names something else, so never.
    const dbName = "(?:\\b(?:[A-Z][A-Z0-9_]*_|[A-Z0-9_]*REDIS)?DB\\b|\\b[a-z][A-Za-z0-9]*Db\\b)";
    return [
      // argv list: ["-n", "<n>", …] or ["-n", <n>, …]; \s spans newlines.
      { shape: "argv -n", re: new RegExp(`${q}-n${q}\\s*,\\s*${val}`) },
      // Shell string: `redis-cli … -n <n> …`, the selector unquoted in the
      // command text. Anchored on redis-cli so `nice -n <n>` / `head -n <n>` stay benign.
      { shape: "redis-cli -n", re: new RegExp(`redis-cli\\b[^\\n;|&"'\`]*?\\s-n\\s+["']?${idx}`) },
      // A DB-first drc* helper: drcAt("<n>", …) or drcAt(<n>, …).
      { shape: "drc*(index)", re: new RegExp(`\\bdrc\\w*\\s*\\(\\s*${val}`) },
      // Env/object property: { HYDRA_REDIS_DB: "<n>" }.
      { shape: "DB property", re: new RegExp(`${dbName}\\s*:\\s*${val}`) },
      // Constant, optionally typed, or a shell env pin: const SELECTED_DB = "<n>",
      // const FOO_DB: string = "<n>", HYDRA_REDIS_DB=<n> node … (never ==/===/=>).
      { shape: "DB constant", re: new RegExp(`${dbName}(?:\\s*:\\s*[^=;\\n]+?)?\\s*(?<![=!<>])=(?![=>])\\s*${val}`) },
    ];
  }

  /** Every pattern hit in a whole file's text, as `line: shape`. */
  function scanText(text: string, patterns: SelectorPattern[]): string[] {
    const hits: string[] = [];
    for (const { shape, re } of patterns) {
      for (const m of text.matchAll(new RegExp(re.source, `${re.flags}g`))) {
        hits.push(`${text.slice(0, m.index).split("\n").length}: ${shape}`);
      }
    }
    return hits;
  }

  // Each fixture interpolates its pool index (`${P}`) so this file's own source
  // never holds the literal shape the whole-file scan below hunts for.
  const P = 9;
  const fixtures: Array<{ shape: string; flagged: string[]; benign: string[] }> = [
    {
      shape: "argv -n",
      flagged: [`["-n", "${P}", "SET"]`, `["-n", ${P}, "SET"]`, `spawnSync("redis-cli", [\n  "-n",\n  "${P}",\n  "GET", k])`],
      benign: ['drc(["-n", "0", "GET", key])', '["-n", owned, "SET"]', 'spawnSync("bash", ["-n", WATCHDOG])'],
    },
    {
      shape: "redis-cli -n",
      flagged: [`redis-cli -n ${P} GET k`, `docker exec hydra-redis-1 redis-cli --raw -n ${P} DEL k`],
      benign: ["redis-cli -n 0 GET k", `nice -n ${10} git status`, "redis-cli -n ${db} GET k"],
    },
    {
      shape: "drc*(index)",
      flagged: [`drcAt("${P}", ["GET", k])`, `drcAt(${P}, ["GET", k])`, `drcAt(\n  "${P}",\n  ["DEL", k])`],
      benign: ['drcAt("0", ["DEL", ...keys])', "drcAt(OWNED_DB, args)", 'drc(["GET", key])'],
    },
    {
      shape: "DB property",
      flagged: [`HYDRA_REDIS_DB: "${P}",`, `{ REDIS_DB: ${P} }`],
      benign: ['HYDRA_REDIS_DB: "0",', `{ DB_PORT: "${P}" }`, "{ HYDRA_REDIS_DB: owned }"],
    },
    {
      shape: "DB constant",
      flagged: [
        `const SELECTED_DB = "${P}";`,
        `const FOO_DB: string = "${P}";`,
        `const OWNED_DB: string | null =\n  "${P}";`,
        `let redisDb = ${P};`,
        `HYDRA_REDIS_DB=${P} node x`,
      ],
      benign: [
        'const SELECTED_DB = "0";',
        `const DB_PORT = "${P}";`,
        `const DB_PORT: string = "${P}";`,
        `if (SELECTED_DB === "${P}") {}`,
        `const REDIS_URL = "redis://localhost:6379/${P}";`,
      ],
    },
  ];

  for (const { shape, flagged, benign } of fixtures) {
    test(`pool-index guard shape "${shape}": flags its positives, never its negatives`, async () => {
      const patterns = await selectorPatterns();
      const flaggedBy = (src: string): string[] => patterns.filter((p) => p.re.test(src)).map((p) => p.shape);
      assert.ok(flagged.length > 0 && benign.length > 0, "every shape needs a positive and a negative case");
      for (const src of flagged) assert.ok(flaggedBy(src).includes(shape), `"${shape}" must flag: ${src}`);
      for (const src of benign) assert.deepEqual(flaggedBy(src), [], `must not flag: ${src}`);
    });
  }

  test("the pool-index guard never flags db 0 pins or pure URL string literals", async () => {
    const patterns = await selectorPatterns();
    for (const src of [
      'HYDRA_REDIS_DB: "0",',
      'drc(["-n", "0", "GET", key])',
      "redis-cli -n 0 GET k",
      'drcAt("0", ["DEL", k])',
      `parseOwnedDbIndex("redis://localhost:6379/${P}")`,
      `parseOwnedDbIndex("redis://127.0.0.1:6379/${P}")`,
      `launcherPrintUrl({ redisUrl: "redis://localhost:6379/${P}" })`,
    ]) {
      assert.deepEqual(scanText(src, patterns), [], `must not flag: ${src}`);
    }
  });

  test("the scan matches whole-file text and reports the line a split argv starts on", async () => {
    const patterns = await selectorPatterns();
    const text = `const a = 1;\nredisCli([\n  "-n",\n  "${P}",\n  "GET", k]);\ndrcAt(\n  ${P}, args);\n`;
    assert.deepEqual(scanText(text, patterns), ["3: argv -n", "6: drc*(index)"]);
  });

  test("no test file passes a literal ALLOWED_DB_INDEXES index as a live Redis selector", async () => {
    const { readdirSync, readFileSync: readFile } = await import("node:fs");
    const patterns = await selectorPatterns();
    const testDir = fileURLToPath(new URL(".", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".mts")) files.push(p);
      }
    };
    walk(testDir);
    const hits = files.flatMap((f) => scanText(readFile(f, "utf8"), patterns).map((h) => `${f}:${h}`));
    assert.deepEqual(hits, [], `pool-index literals used as live Redis selectors:\n${hits.join("\n")}`);
  });
});

describe("test/_helpers/owned-redis-db decision matrix (issue #5062)", () => {
  test("ownedRedisDb accepts only a non-zero integer string", () => {
    assert.equal(ownedRedisDb({}), null, "unset");
    assert.equal(ownedRedisDb({ HYDRA_REDIS_DB: "0" }), null, "db 0 is never owned");
    assert.equal(ownedRedisDb({ HYDRA_REDIS_DB: "abc" }), null, "non-numeric");
    assert.equal(ownedRedisDb({ HYDRA_REDIS_DB: "" }), null, "empty");
    assert.equal(ownedRedisDb({ HYDRA_REDIS_DB: "3" }), "3", "launcher-exported index passes through");
  });

  test("ownedDbSkip: owned DB never skips", () => {
    assert.equal(ownedDbSkip("3", {}), false);
  });

  test("ownedDbSkip: bare node --test (no FULL_SUITE) skips with a reason", () => {
    assert.equal(typeof ownedDbSkip(null, {}), "string");
  });

  test("ownedDbSkip: remote REDIS_URL skips even on a full-suite run", () => {
    const r = ownedDbSkip(null, { HYDRA_FULL_SUITE: "1", REDIS_URL: "redis://redis.example.com:6379" });
    assert.equal(typeof r, "string");
  });

  test("ownedDbSkip: full-suite local run returns false so the test body fails loudly", () => {
    assert.equal(ownedDbSkip(null, { HYDRA_FULL_SUITE: "1" }), false);
    assert.equal(ownedDbSkip(null, { HYDRA_FULL_SUITE: "1", REDIS_URL: "redis://127.0.0.1:6379/0" }), false);
  });

  test("ownedDbContext pairs the owned DB with its skip verdict", () => {
    assert.deepEqual(ownedDbContext({ HYDRA_REDIS_DB: "3" }), { db: "3", skip: false });
    assert.deepEqual(ownedDbContext({ HYDRA_FULL_SUITE: "1" }), { db: null, skip: false });
    assert.equal(typeof ownedDbContext({}).skip, "string");
  });

  // The shim's fidelity battery (test/_helpers/watchdog-redis-shim.mts) follows
  // the same rule: its SELECT-path entries are omitted only where no owned DB is
  // expected, and a full-suite local run with none fails loudly.
  const key = (n: string): string => `k:${n}`;
  const selectsNonZeroDb = (cases: string[][]): boolean => cases.some((c) => c[0] === "-n" && c[1] !== "0");

  test("fidelityBattery: an owned DB adds the SELECT-path entries on that DB", () => {
    const owned = fidelityBattery(key, { HYDRA_REDIS_DB: "3" }).filter((c) => c[1] === "3");
    assert.deepEqual(owned.map((c) => c[2]), ["SET", "GET", "DEL"]);
  });

  test("fidelityBattery: bare node --test and remote REDIS_URL omit the SELECT-path entries", () => {
    assert.equal(selectsNonZeroDb(fidelityBattery(key, {})), false, "bare node --test");
    const remote = { HYDRA_FULL_SUITE: "1", REDIS_URL: "redis://redis.example.com:6379" };
    assert.equal(selectsNonZeroDb(fidelityBattery(key, remote)), false, "remote REDIS_URL");
  });

  test("fidelityBattery: a full-suite local run with no owned DB throws instead of omitting them", () => {
    for (const env of [{ HYDRA_FULL_SUITE: "1" }, { HYDRA_FULL_SUITE: "1", REDIS_URL: "redis://127.0.0.1:6379/0" }]) {
      assert.throws(
        () => fidelityBattery(key, env),
        (err: unknown) => (err as { code?: string }).code === "invariant-violation" && /HYDRA_REDIS_DB/.test(String(err)),
        `must throw for ${JSON.stringify(env)}`,
      );
    }
  });
});

describe("scripts/test/redis-db-launch.mjs — terminal VERDICT line (#5106)", () => {
  const LAUNCHER = fileURLToPath(
    new URL("../scripts/test/redis-db-launch.mjs", import.meta.url),
  );
  const scratch: string[] = [];

  after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  function runLauncher(script: string) {
    const dir = mkdtempSync(join(tmpdir(), "redis-db-verdict-"));
    scratch.push(dir);
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.REDIS_URL;
    return spawnSync(process.execPath, [LAUNCHER, process.execPath, "-e", script], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
  }

  function lastLine(stderr: string): string {
    const lines = stderr.split("\n").filter((l) => l.trim() !== "");
    return lines[lines.length - 1] ?? "";
  }

  test("VERDICT is the last stderr line on a clean exit", () => {
    const run = runLauncher("process.exit(0)");
    assert.equal(run.status, 0);
    assert.match(
      lastLine(run.stderr),
      /^\[redis-db-launch\] VERDICT exit=0 outcome=PASS top-level-pass=n\/a top-level-fail=n\/a suites-gate=skipped$/,
    );
    assert.doesNotMatch(run.stdout, /VERDICT/, "stdout must stay untouched");
  });

  test("VERDICT exit= equals the launcher's real exit status on failure", () => {
    const run = runLauncher("process.exit(3)");
    const m = /VERDICT exit=(\d+) outcome=FAIL/.exec(lastLine(run.stderr));
    assert.ok(m, `no FAIL verdict; stderr was: ${run.stderr}`);
    assert.equal(run.status, Number(m[1]));
    assert.equal(run.status, 3);
  });

  test("VERDICT follows the INFRA-KILL lines on a signal death", () => {
    const run = runLauncher("process.kill(process.pid, 'SIGTERM')");
    assert.equal(run.signal, "SIGTERM");
    const last = lastLine(run.stderr);
    assert.match(last, /VERDICT exit=signal:SIGTERM outcome=INFRA-KILL .* suites-gate=skipped$/);
    assert.ok(run.stderr.indexOf("INFRA-KILL: test child") < run.stderr.indexOf("VERDICT"));
  });

  test("launcherVerdictLine formats n/a counts and every suites-gate value", async () => {
    const { launcherVerdictLine } = await import("../scripts/test/redis-db-launch.mjs");
    for (const g of ["ok", "advisory", "blocking", "skipped", "error"]) {
      assert.equal(
        launcherVerdictLine({ exit: 1, outcome: "FAIL", topLevelPass: 4, topLevelFail: 2, suitesGate: g }),
        `[redis-db-launch] VERDICT exit=1 outcome=FAIL top-level-pass=4 top-level-fail=2 suites-gate=${g}`,
      );
    }
    assert.match(
      launcherVerdictLine({ exit: 0, outcome: "PASS", topLevelPass: null, topLevelFail: null, suitesGate: "ok" }),
      /top-level-pass=n\/a top-level-fail=n\/a/,
    );
  });

  test("captureTopLevelCounts counts only the ok field and tolerates a torn last line", async () => {
    const { captureTopLevelCounts } = await import("../scripts/test/redis-db-launch.mjs");
    const dir = mkdtempSync(join(tmpdir(), "redis-db-capture-"));
    scratch.push(dir);
    const p = join(dir, "cap.ndjson");
    writeFileSync(
      p,
      '{"file":"a","name":"x","ok":true}\n{"file":"a","name":"y","ok":false}\n{"file":"b","name":"z","ok":true}\n{"file":',
    );
    assert.deepEqual(captureTopLevelCounts(p), { pass: 2, fail: 1 });
    assert.equal(captureTopLevelCounts(join(dir, "missing")), null);
  });

  test("no bare process.exit remains in the child exit handler (single exit seam)", () => {
    const src = readFileSync(LAUNCHER, "utf8");
    const start = src.indexOf('child.on("exit"');
    assert.ok(start > 0);
    const body = src.slice(start);
    assert.equal(body.includes("process.exit("), false);
  });
});
