#!/usr/bin/env node
/**
 * scripts/test/redis-db-launch.mjs — per-run Redis DB-index isolation
 * (issue #1676, extends #1231).
 *
 * # Problem
 *
 * Every Redis-touching test file defers to REDIS_URL with a DB-1 fallback, so
 * concurrent `npm test` runs from different checkouts (the local repo, agent
 * worktrees, the 4 self-hosted CI runners) all shared logical DB 1 of the
 * single hydra-redis-1 container. Within one run `--test-concurrency=1` keeps
 * files serial, but ACROSS runs one run's `beforeEach` keyspace-clean wiped
 * another run's fixtures mid-test — the documented backlog-state-machine /
 * api-maintenance-timing flake class ("fails in worktree QA, passes in CI").
 *
 * # Fix (per-RUN, not per-file — see #1231 for why per-file was rejected)
 *
 * This launcher derives a stable per-run DB index from the repo/worktree root
 * path, sets REDIS_URL once, FLUSHDBs that index at run start (clean slate for
 * serial re-runs in the same worktree), then spawns the real `node --test`
 * invocation with the env inherited. Same worktree → same DB; different
 * worktrees → different DBs, so cross-run wipes cannot happen.
 *
 * ## Deterministic runner slots (#3764 root-cause fix)
 *
 * Deriving the index by hashing the root path onto 8 slots is only
 * PROBABILISTIC — 4 runners over 8 slots collide ~59% of the time, and PR
 * #3781's postmortem caught exactly that: runners 2 and 4 both hashed to DB
 * 15, so whichever's start-of-run FLUSHDB ran second wiped the other's
 * mid-test fixtures (the flush is the weapon, which is why the failing test
 * sets were disjoint and tracked no code change). #3781 proposed closing this
 * with explicit per-runner `REDIS_URL` assignment in each runner's `.env` —
 * an operator action outside this repo, not yet done as of #3764 reopening.
 * `KNOWN_RUNNER_SLOTS` / `knownRunnerSlot()` below fix the same collision in
 * code instead: the 4 runner checkout roots
 * (`/home/gabe/actions-runner{,-2,-3,-4}/...`) are a small, known, stable set,
 * so each maps to a DISTINCT index directly rather than through a hash —
 * collision is categorically impossible for the documented topology, no
 * `ci.yml` edit needed (a runner's checkout root isn't workflow config), and
 * no per-runner `.env` file for an operator to create or for a reimaged
 * runner to silently lose. A root that doesn't match a known runner (a
 * laptop, an agent worktree, a future unrecognized runner) still falls
 * through to the SHA-256 hash, unchanged.
 *
 * A key-prefix namespace (isolate within one shared DB instead of assigning
 * distinct DBs) was considered and rejected for this same problem back in the
 * #1231 design-concept (ADR-0014 simplicity) and is rejected again here: the
 * repo has 87 test files (116 call sites) that open their own raw
 * `new Redis(process.env.REDIS_URL)` probe connection rather than going
 * through `src/redis/connection.ts`, and a prefix only isolates traffic that
 * passes through a client configured with it — retrofitting all 87 files is
 * disproportionate blast radius for a CI-infra fix and was not attempted.
 *
 * # Contract (pinned by test/redis-db-helper.test.mts)
 *
 *   - A pre-set REDIS_URL is respected VERBATIM (CI or operator override):
 *     no derivation, no rewriting. It IS still flushed at run start when its
 *     DB index is one this launcher owns (ALLOWED_DB_INDEXES) — see #3764: the
 *     4 self-hosted runners are pinned to distinct owned DBs via their runner
 *     `.env`, and skipping the flush there would cost them the clean slate this
 *     launcher exists to provide. A pre-set url on a NON-owned DB (0, 1, a
 *     remote host) is never flushed — that is the case the verbatim rule
 *     protects, and `flushDbOnce` hard-refuses it independently.
 *   - The derived index is stable for a given root path and always inside
 *     2..15 — NEVER 0 (production) and NEVER 1 (the legacy shared test DB).
 *   - Within 2..15, the legacy per-file hard-pinned indexes {2..7} are also
 *     excluded from derivation: checkouts of branches cut before #1676 still
 *     hard-pin those DBs (pr-lifecycle-bridge / bounded-list → 2,
 *     scheduler-status → 3, api-maintenance → 4, backlog-stale-claim-reaper
 *     → 5, backlog-reaper-open-pr-guard → 6, outcomes-producer → 7), and a
 *     derived run flushing one of them mid-CI would recreate exactly the
 *     cross-run collision this launcher exists to kill. Widen
 *     ALLOWED_DB_INDEXES once no live branch hard-pins them.
 *   - FLUSHDB hard-refuses any index outside ALLOWED_DB_INDEXES — DB 0 above
 *     all. There is no code path that can flush DB 0.
 *
 * # Why node stdlib only (ADR-0005)
 *
 * The one Redis exchange needed (SELECT + FLUSHDB) is two inline commands
 * over a raw TCP socket, so no ioredis import: the launcher adds zero
 * dependency surface and works even before node_modules is installed (it
 * degrades to a warning when Redis itself is down — the test files already
 * skip cleanly in that case).
 *
 * # Usage
 *
 *   node scripts/test/redis-db-launch.mjs <command> [args...]
 *       resolve REDIS_URL (derive + flush only when not pre-set), then spawn
 *       <command> with the env inherited; exits with the child's exit code.
 *
 *   node scripts/test/redis-db-launch.mjs --print-url
 *       print the resolved REDIS_URL and exit. NO flush, NO spawn — this is
 *       the side-effect-free observability hook the contract tests use.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import process from "node:process";

const REDIS_HOST = "127.0.0.1";
const REDIS_PORT = 6379;

/**
 * Derivable indexes: 2..15 minus the legacy per-file hard pins {2..7}
 * (see header). Order matters only for hash → index stability; never reorder
 * without accepting that every worktree remaps.
 */
const ALLOWED_DB_INDEXES = [8, 9, 10, 11, 12, 13, 14, 15];

/**
 * Deterministic, collision-free slot assignment for the KNOWN self-hosted
 * runner topology (issue #3764 root-cause fix).
 *
 * Hashing an arbitrary worktree root path onto 8 slots is only PROBABILISTIC:
 * PR #3781's postmortem showed the 4 real runners hash to {8, 15, 9, 15} —
 * runners 2 and 4 collide on DB 15, so whichever's start-of-run FLUSHDB lands
 * second wipes the other's mid-run fixtures. That IS the "disjoint,
 * code-unrelated failure sets" reported in #3764: the flush is the weapon.
 *
 * The 4 runner checkout roots are a small, known, stable set —
 * `/home/gabe/actions-runner{,-2,-3,-4}/_work/...` — so map each one to a
 * distinct index directly instead of hashing it. This makes collision
 * categorically impossible for the documented topology, requires no
 * `ci.yml` edit (a runner's checkout path is not workflow config — it comes
 * from how the runner service itself was registered), and needs no operator
 * per-runner `.env` maintenance (the prescribed-but-still-pending fix note
 * from PR #3781): a reimaged or freshly-registered runner keeps working
 * without anyone hand-editing a file outside this repo.
 *
 * Anything that doesn't match a known runner root (a developer's laptop, an
 * agent worktree, a future unrecognized runner) falls through to the
 * pre-existing SHA-256 hash below. The hash's candidate pool
 * (FALLBACK_DB_INDEXES, defined after this map) additionally excludes the
 * indexes reserved here, so a fallback root can never collide with a live
 * runner's DB either.
 */
const KNOWN_RUNNER_SLOTS = new Map([
  ["actions-runner", ALLOWED_DB_INDEXES[0]],
  ["actions-runner-2", ALLOWED_DB_INDEXES[1]],
  ["actions-runner-3", ALLOWED_DB_INDEXES[2]],
  ["actions-runner-4", ALLOWED_DB_INDEXES[3]],
]);

/**
 * Match a `/actions-runner(-N)?/` path segment and return its deterministic
 * slot, or null when the path isn't one of the known runner roots.
 */
export function knownRunnerSlot(rootPath) {
  const match = /\/(actions-runner(?:-\d+)?)(?:\/|$)/.exec(resolve(rootPath));
  if (!match) return null;
  return KNOWN_RUNNER_SLOTS.get(match[1]) ?? null;
}

/**
 * Fallback hash candidate pool: ALLOWED_DB_INDEXES minus every index
 * KNOWN_RUNNER_SLOTS reserves for the 4 known self-hosted runners (#3764
 * QA follow-up). Without this exclusion, a root that doesn't match a known
 * runner (an agent worktree, a laptop, a future unrecognized runner) could
 * still hash onto a runner-owned DB, and the launcher's start-of-run
 * FLUSHDB would wipe that runner's mid-test fixtures — the identical
 * "flush is the weapon" mechanism as the original bug, just a different
 * actor pairing (fallback-root vs. runner instead of runner vs. runner).
 * This mirrors the shape ALLOWED_DB_INDEXES already uses to exclude the
 * legacy {2..7} hard pins — narrow the derivable set rather than special-case
 * the flush.
 *
 * Derived from KNOWN_RUNNER_SLOTS's values (not hardcoded a second time) so
 * the reserved set can never drift out of sync with the actual runner
 * assignments.
 *
 * Resulting pool for non-runner roots: {12, 13, 14, 15} (4 slots instead of
 * 8). This roughly doubles the worktree-vs-worktree hash-collision
 * probability for non-runner roots — an acceptable trade, since a
 * worktree-vs-worktree collision is a worktree-local flake (this repo's
 * standing guidance is to trust CI over worktree-local Redis flakes),
 * whereas a fallback root landing on a runner's DB reddens the REQUIRED
 * `test` job non-deterministically on the shared CI pool — exactly the
 * failure mode #3764 exists to eliminate. Protecting the authoritative CI
 * signal is worth more than a marginally higher worktree-local flake rate.
 */
const RUNNER_RESERVED_INDEXES = new Set(KNOWN_RUNNER_SLOTS.values());
const FALLBACK_DB_INDEXES = ALLOWED_DB_INDEXES.filter(
  (index) => !RUNNER_RESERVED_INDEXES.has(index),
);

/** Stable per-root DB index — same path always maps to the same DB. */
export function deriveDbIndex(rootPath) {
  const known = knownRunnerSlot(rootPath);
  if (known !== null) return known;
  const digest = createHash("sha256").update(resolve(rootPath)).digest();
  return FALLBACK_DB_INDEXES[digest.readUInt32BE(0) % FALLBACK_DB_INDEXES.length];
}

/**
 * Resolve the run's REDIS_URL: a pre-set env value wins verbatim; otherwise
 * derive a per-run DB from the root path.
 */
/**
 * Parse the trailing `/<n>` DB index off a redis URL, but ONLY when that index
 * is one this launcher owns (ALLOWED_DB_INDEXES). Returns null otherwise —
 * including for DB 0/1, a remote host, or an unparseable URL.
 *
 * This is what makes flushing a PRE-SET url safe: an index outside the owned
 * set is never returned, so it can never reach flushDbOnce (which independently
 * hard-refuses it anyway — belt and braces).
 */
export function parseOwnedDbIndex(url) {
  // The HOST must be the local Redis this launcher flushes. flushDbOnce always
  // connects to 127.0.0.1, so claiming a DB off a REMOTE url would flush the
  // local DB of that index while the caller is pointed somewhere else entirely
  // — destroying data the operator never named. Only localhost:<REDIS_PORT> is
  // ever claimed.
  const match = new RegExp(
    `^redis://(?:localhost|127\\.0\\.0\\.1):${REDIS_PORT}/(\\d+)$`,
  ).exec(String(url ?? "").trim());
  if (!match) return null;
  const db = Number(match[1]);
  return ALLOWED_DB_INDEXES.includes(db) ? db : null;
}

export function resolveRedisUrl(env, rootPath) {
  if (env.REDIS_URL) {
    // Respected VERBATIM — never rewritten (issue #1676 contract). But a
    // pre-set url pointing at a DB this launcher OWNS still gets the
    // start-of-run flush (issue #3764): the 4 self-hosted CI runners are
    // assigned distinct owned DBs by their runner `.env`, and without this they
    // would silently lose the clean slate that #1676 added — trading a
    // cross-runner flake for a same-runner one, since consecutive jobs reuse
    // one workspace. `db: null` (a real/remote Redis, DB 0/1) still means no
    // flush, which is the case the verbatim rule exists to protect.
    return { url: env.REDIS_URL, derived: false, db: parseOwnedDbIndex(env.REDIS_URL) };
  }
  const db = deriveDbIndex(rootPath);
  return { url: `redis://localhost:${REDIS_PORT}/${db}`, derived: true, db };
}

/**
 * The last line of defence for the "DB 0 is never touched" invariant (#1231):
 * refuse to flush anything outside the derivable set. DB 1 (legacy shared)
 * and the legacy hard-pinned indexes are equally non-flushable — another
 * checkout may be mid-run in them.
 */
function assertFlushableDbIndex(db) {
  if (!Number.isInteger(db) || !ALLOWED_DB_INDEXES.includes(db)) {
    throw new Error(
      `[redis-db-launch] refusing to FLUSHDB index ${db}: only derived ` +
        `per-run indexes (${ALLOWED_DB_INDEXES.join(",")}) may be flushed — ` +
        `DB 0 is production and DB 1..7 may host other runs (#1676).`,
    );
  }
}

/**
 * Best-effort one-shot FLUSHDB of the derived index via two inline RESP
 * commands on a raw socket. Resolves true on success, false on any failure —
 * a flush miss only costs the clean-slate guarantee for THIS worktree's
 * serial re-run; the per-file beforeEach cleans still apply, and when Redis
 * is down the test files skip themselves. Never throws past the guard.
 */
function flushDbOnce(db) {
  assertFlushableDbIndex(db);
  return new Promise((resolveFlush) => {
    const socket = connect({ host: REDIS_HOST, port: REDIS_PORT });
    let buffer = "";
    let settled = false;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!ok) {
        // Fail loud (but non-fatal): a missed flush is survivable, a silent
        // one would hide a broken isolation assumption.
        console.error(
          `[redis-db-launch] WARN: could not FLUSHDB ${db} (${why}) — ` +
            `continuing; Redis-touching tests skip cleanly when Redis is down.`,
        );
      }
      resolveFlush(ok);
    };
    socket.setTimeout(3000, () => finish(false, "timeout after 3s"));
    socket.on("error", (err) => finish(false, err.message));
    socket.on("connect", () => {
      socket.write(`SELECT ${db}\r\nFLUSHDB\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const replies = buffer.split("\r\n").filter((line) => line.length > 0);
      if (replies.length >= 2) {
        const ok = replies[0] === "+OK" && replies[1] === "+OK";
        finish(ok, ok ? "" : `unexpected reply: ${replies.join(" | ")}`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entrypoint. Guarded so this module can be IMPORTED for its exported pure
// helpers (deriveDbIndex / resolveRedisUrl / parseOwnedDbIndex) without running
// the launcher. Before this guard the top-level ran on import, so an importer
// hit the no-args usage branch and `process.exit(1)` — which made the exports
// effectively unreachable and forced every contract test through a subprocess.
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  await main();
}

async function main() {
const args = process.argv.slice(2);
const resolved = resolveRedisUrl(process.env, process.cwd());

if (args[0] === "--print-url") {
  // Side-effect-free mode for the contract tests: no flush, no spawn.
  process.stdout.write(`${resolved.url}\n`);
  process.exit(0);
}

if (args.length === 0) {
  console.error(
    "[redis-db-launch] usage: node scripts/test/redis-db-launch.mjs <command> [args...] | --print-url",
  );
  process.exit(1);
}

// Flush whenever the resolved DB is one this launcher OWNS — whether it was
// derived from the worktree path or pre-set (issue #3764). A pre-set url on a
// non-owned DB (0/1, remote) resolves db=null and is left untouched.
if (resolved.db !== null) {
  await flushDbOnce(resolved.db);
  // Info to stderr so the node:test TAP footer on stdout (the CI MIN_TESTS
  // grep surface) stays untouched.
  console.error(
    `[redis-db-launch] per-run Redis DB ${resolved.db} ` +
      (resolved.derived
        ? `(derived from ${resolve(process.cwd())})`
        : `(pre-set REDIS_URL)`),
  );
}

const child = spawn(args[0], args.slice(1), {
  stdio: "inherit",
  env: { ...process.env, REDIS_URL: resolved.url },
});
child.on("error", (err) => {
  console.error(`[redis-db-launch] failed to spawn ${args[0]}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    // Issue #4043: a signal-death here (observed as SIGKILL/137 mid-run and
    // SIGTERM/143 immediately after a clean TAP footer) is CATEGORICALLY an
    // infrastructural kill, never a genuine test failure — node:test's own
    // failure path always exits via `code` (process.exit(1)), never via a
    // signal. ci.yml's "Run tests and verify count" step runs under the
    // Actions default `bash -e` PLUS an explicit `set -o pipefail`, so a
    // non-zero/signal exit from this launcher aborts that step immediately,
    // before its own `grep -qE '^# fail [1-9]'` classification line is ever
    // reached — today a signal-death and a genuine failure are
    // indistinguishable from the job's outside (both just "Failed"). Emitting
    // this BEFORE re-raising means it still lands in the live job log and in
    // `tee`'d test-output.txt (both writes happen while the process is still
    // alive), giving a human or the autopilot PR sweep a greppable signal
    // without requiring a ci.yml change (ci.yml is Verifier Core / T4).
    console.error(
      `[redis-db-launch] INFRA-KILL: test child received ${signal} — ` +
        "this is an infrastructural kill, not a genuine test failure (a real " +
        "test failure exits via a status code, never a signal). See issue #4043.",
    );
    // Re-raise so the parent observes the same termination signal.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
}
