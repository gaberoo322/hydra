/**
 * Regression test for issue #3868 — the ## GLM DRAINER ZERO-THROUGHPUT block
 * in scripts/hydra-watchdog.sh.
 *
 * The block distinguishes "live but sterile" (fresh drainer heartbeat, but
 * claim attempts are producing zero PRs — the observed 2026-08-05 failure
 * mode, #3863: `gh pr create` failed on every attempt for ~40 min while the
 * heartbeat stayed fresh) from both "down" (stale heartbeat — the existing
 * liveness class's job) and "no work queued" (fresh heartbeat, zero claims).
 * Hard invariants pinned here:
 *
 *   1. Fresh heartbeat + >= N claims + 0 "PR opened" lines in the window ->
 *      WARNING GLM ZERO-THROUGHPUT fires exactly once (idempotent fired
 *      marker), not on every tick while the condition persists.
 *   2. Fresh heartbeat + a "PR opened" line anywhere in the window -> quiet,
 *      and clears any previously-fired marker.
 *   3. Fresh heartbeat + fewer than N claims (including zero) -> quiet (no
 *      work queued is not sterile).
 *   4. Stale/absent heartbeat -> quiet (down is not sterile; that's the
 *      existing liveness class's alarm) and clears any fired marker.
 *   5. Read failure (heartbeat or journal unreadable) -> WARN, and the fired
 *      marker is left untouched (never falsely cleared or falsely set).
 *
 * The block honours off-by-default injection hooks (documented in the
 * script header) so the test never touches the real production
 * hydra:glm:drainer:active key or a real journalctl call:
 *   HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW   Inject the raw heartbeat epoch-ms.
 *   HYDRA_WATCHDOG_GLM_NOW_MS          Inject `now` (epoch-ms).
 *   HYDRA_WATCHDOG_GLM_JOURNAL_TAIL    Inject the drain-log window text.
 *   HYDRA_WATCHDOG_DRIFT_STATE_DIR     Per-test marker dir (shared with the
 *                                      ## DEPLOY DRIFT / ## SKILL MIRROR
 *                                      DRIFT blocks) so the fired marker
 *                                      doesn't collide with a live watchdog.
 *
 * The service-liveness + autopilot-wedge blocks run first on every tick. To
 * keep the test independent of systemd/docker/HTTP state on the host, we
 * feed HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE=1 (autopilot block
 * early-exits) and accept that the service-liveness / other blocks may log
 * whatever they like — we only assert on the
 * `hydra-glm-zero-throughput-watchdog:` lines (mirrors
 * test/watchdog-deploy-drift.test.mts's `driftLines` convention).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WATCHDOG_SPAWN_TIMEOUT_MS,
  throwIfTimedOut,
} from "./_helpers/watchdog-timeouts.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

// A "now" far enough from epoch 0 that a heartbeat 1s earlier is unambiguous.
const NOW_MS = "2000000000000";
const FRESH_HEARTBEAT_MS = "1999999000000"; // now - 1s: well inside 45min stale window
const STALE_HEARTBEAT_MS = "1000000000000"; // now - ~999,999s: far past 45min stale window

function runWatchdog(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(WATCHDOG, [], {
    // Force the autopilot-wedge block to early-exit so the test doesn't
    // depend on the autopilot service / heartbeat state on the host.
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE: "1",
      ...env,
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
    timeout: WATCHDOG_SPAWN_TIMEOUT_MS,
  });
  throwIfTimedOut(r, WATCHDOG_SPAWN_TIMEOUT_MS, "watchdog script");
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Extract only the GLM zero-throughput block's log lines for focused assertions. */
function glmLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-glm-zero-throughput-watchdog:"))
    .join("\n");
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "watchdog-glm-zero-throughput-test-"));
}

function claimsNoPr(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`claiming issue #${i}`);
    lines.push(`ERROR gh pr create failed for issue #${i} branch=x and no existing PR found for that branch — genuine failure`);
  }
  return lines.join("\n");
}

describe("scripts/hydra-watchdog.sh — ## GLM DRAINER ZERO-THROUGHPUT block (issue #3868)", () => {
  test("watchdog script exists and is executable", () => {
    assert.ok(existsSync(WATCHDOG), "watchdog script missing");
    const mode = spawnSync("stat", ["-c", "%a", WATCHDOG], { encoding: "utf-8" }).stdout.trim();
    assert.match(mode, /^[7][0-9]{2}$/, `watchdog not executable (mode=${mode})`);
  });

  test("fresh heartbeat + N claims + 0 PRs: fires WARNING GLM ZERO-THROUGHPUT", () => {
    const dir = makeStateDir();
    try {
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = glmLines(r.stdout);
      assert.match(lines, /WARNING GLM ZERO-THROUGHPUT/, `expected zero-throughput warning, got: ${lines}`);
      assert.match(lines, /live but sterile/, `expected 'live but sterile' framing, got: ${lines}`);
      assert.ok(
        existsSync(join(dir, "hydra-watchdog-glm-zero-throughput-fired")),
        "expected fired marker written",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fired marker persists: does not re-fire the WARNING on a second tick", () => {
    const dir = makeStateDir();
    try {
      // First tick: establishes the fired marker.
      const r1 = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r1.status, 0);
      assert.match(glmLines(r1.stdout), /WARNING GLM ZERO-THROUGHPUT/);

      // Second tick: same sterile condition still holds.
      const r2 = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r2.status, 0, `expected exit 0, got ${r2.status}; stderr=${r2.stderr}`);
      const lines2 = glmLines(r2.stdout);
      assert.doesNotMatch(lines2, /WARNING GLM ZERO-THROUGHPUT/, `must not re-fire, got: ${lines2}`);
      assert.match(lines2, /already alarmed, not re-firing/, `expected persist log, got: ${lines2}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a PR opened in the window: stays quiet and clears a stale fired marker", () => {
    const dir = makeStateDir();
    try {
      // Pre-seed a fired marker as if a prior tick alarmed.
      const seed = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.match(glmLines(seed.stdout), /WARNING GLM ZERO-THROUGHPUT/);
      assert.ok(existsSync(join(dir, "hydra-watchdog-glm-zero-throughput-fired")), "precondition: marker exists");

      const journal = [
        "claiming issue #1",
        "issue #1: PR opened (branch=fix/1), advanced to needs-qa, daily cap incremented",
        "claiming issue #2",
        "claiming issue #3",
      ].join("\n");
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: journal,
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = glmLines(r.stdout);
      assert.doesNotMatch(lines, /WARNING GLM ZERO-THROUGHPUT/, `must not alarm, got: ${lines}`);
      assert.match(lines, /throughput OK/, `expected OK log, got: ${lines}`);
      assert.ok(!existsSync(join(dir, "hydra-watchdog-glm-zero-throughput-fired")), "expected stale marker cleared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh heartbeat but fewer than N claims (no work queued): stays quiet", () => {
    const dir = makeStateDir();
    try {
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: "",
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = glmLines(r.stdout);
      assert.doesNotMatch(lines, /WARNING GLM ZERO-THROUGHPUT/, `must not alarm on no work, got: ${lines}`);
      assert.match(lines, /claims=0, prs=0/, `expected zero-claim OK log, got: ${lines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale heartbeat: quiet (down, not sterile) and clears a stale fired marker", () => {
    const dir = makeStateDir();
    try {
      const seed = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.match(glmLines(seed.stdout), /WARNING GLM ZERO-THROUGHPUT/);
      assert.ok(existsSync(join(dir, "hydra-watchdog-glm-zero-throughput-fired")), "precondition: marker exists");

      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: STALE_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = glmLines(r.stdout);
      assert.doesNotMatch(lines, /WARNING GLM ZERO-THROUGHPUT/, `must not alarm when stale, got: ${lines}`);
      assert.match(lines, /heartbeat stale/, `expected stale log, got: ${lines}`);
      assert.match(lines, /down, not sterile/, `expected down-not-sterile framing, got: ${lines}`);
      assert.ok(!existsSync(join(dir, "hydra-watchdog-glm-zero-throughput-fired")), "expected marker cleared on stale heartbeat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent/unparseable heartbeat: WARN and fired marker left untouched", () => {
    const dir = makeStateDir();
    try {
      const seed = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.match(glmLines(seed.stdout), /WARNING GLM ZERO-THROUGHPUT/);
      assert.ok(existsSync(join(dir, "hydra-watchdog-glm-zero-throughput-fired")), "precondition: marker exists");

      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: "not-a-number",
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: claimsNoPr(3),
        HYDRA_WATCHDOG_GLM_ZERO_THROUGHPUT_CLAIMS: "3",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = glmLines(r.stdout);
      assert.match(lines, /WARN GLM drainer heartbeat unreadable\/absent/, `expected unreadable WARN, got: ${lines}`);
      assert.doesNotMatch(lines, /WARNING GLM ZERO-THROUGHPUT/, `must not alarm on a read failure, got: ${lines}`);
      assert.ok(
        existsSync(join(dir, "hydra-watchdog-glm-zero-throughput-fired")),
        "expected marker LEFT UNTOUCHED (not cleared) on a read failure",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run_glm_zero_throughput is wired into the entry-point call list", () => {
    const dir = makeStateDir();
    try {
      const r = runWatchdog({
        HYDRA_WATCHDOG_GLM_NOW_MS: NOW_MS,
        HYDRA_WATCHDOG_GLM_HEARTBEAT_RAW: FRESH_HEARTBEAT_MS,
        HYDRA_WATCHDOG_GLM_JOURNAL_TAIL: "",
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      // Any glm-zero-throughput-prefixed line proves the block ran on a plain
      // (non-sourced) invocation of the script, i.e. it's wired into the
      // BASH_SOURCE-guarded entry point at the bottom of the file.
      assert.match(glmLines(r.stdout), /hydra-glm-zero-throughput-watchdog:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
