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
 * # Contract (pinned by test/redis-db-helper.test.mts)
 *
 *   - A pre-set REDIS_URL is respected VERBATIM (CI or operator override):
 *     no derivation, no flush, no rewriting.
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

/** Stable per-root DB index — same path always maps to the same DB. */
export function deriveDbIndex(rootPath) {
  const digest = createHash("sha256").update(resolve(rootPath)).digest();
  return ALLOWED_DB_INDEXES[digest.readUInt32BE(0) % ALLOWED_DB_INDEXES.length];
}

/**
 * Resolve the run's REDIS_URL: a pre-set env value wins verbatim; otherwise
 * derive a per-run DB from the root path.
 */
export function resolveRedisUrl(env, rootPath) {
  if (env.REDIS_URL) {
    return { url: env.REDIS_URL, derived: false, db: null };
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

if (resolved.derived) {
  await flushDbOnce(resolved.db);
  // Info to stderr so the node:test TAP footer on stdout (the CI MIN_TESTS
  // grep surface) stays untouched.
  console.error(
    `[redis-db-launch] per-run Redis DB ${resolved.db} ` +
      `(derived from ${resolve(process.cwd())})`,
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
    // Re-raise so the parent observes the same termination signal.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
