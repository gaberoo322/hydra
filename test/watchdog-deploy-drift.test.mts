/**
 * Regression test for issue #734 — the ## DEPLOY DRIFT block in
 * scripts/hydra-watchdog.sh.
 *
 * The deploy-drift backstop compares the SHA the orchestrator is running
 * from (deployed) against origin/master HEAD (remote) and surfaces drift.
 * Hard invariants pinned here (from the gate-approved design-concept for
 * issue-734):
 *
 *   1. Advisory by default — drift logs a WARNING only; it does NOT deploy
 *      unless HYDRA_WATCHDOG_AUTODEPLOY=1.
 *   2. Grace-windowed — even with auto-deploy enabled, drift must persist
 *      past HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS before a deploy fires.
 *   3. Respects deliberate operator stops — never auto-deploys when the
 *      scheduler reports stopReason="deliberate".
 *   4. Read-only / fail-safe — git or network errors skip+log and the
 *      script still exits 0.
 *
 * The block honours off-by-default injection hooks (documented in the
 * script header) so the test never touches the real git remote or runs a
 * real deploy:
 *   HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA / HYDRA_WATCHDOG_DRIFT_REMOTE_SHA
 *       Inject the two SHAs.
 *   HYDRA_WATCHDOG_AUTODEPLOY_DRY_RUN=1
 *       In the auto-deploy branch, log "would-deploy" instead of execing.
 *   HYDRA_WATCHDOG_DRIFT_STATE_DIR
 *       Per-test marker dir so the grace-window marker doesn't collide
 *       with a live watchdog on the dev host.
 *
 * The service-liveness + autopilot-wedge blocks run first on every tick.
 * To keep the test independent of systemd/docker/HTTP state on the host,
 * we feed HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE=1 (autopilot
 * block early-exits) and accept that the service-liveness block may log
 * whatever it likes — we only assert on the `hydra-deploy-drift-watchdog:`
 * lines.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WATCHDOG = join(REPO_ROOT, "scripts", "hydra-watchdog.sh");

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";

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
    timeout: 20_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Extract only the deploy-drift block's log lines for focused assertions. */
function driftLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => l.includes("hydra-deploy-drift-watchdog:"))
    .join("\n");
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "watchdog-drift-test-"));
}

describe("scripts/hydra-watchdog.sh — ## DEPLOY DRIFT block (issue #734)", () => {
  test("watchdog script exists and is executable", () => {
    assert.ok(existsSync(WATCHDOG), "watchdog script missing");
    const mode = spawnSync("stat", ["-c", "%a", WATCHDOG], { encoding: "utf-8" }).stdout.trim();
    assert.match(mode, /^[7][0-9]{2}$/, `watchdog not executable (mode=${mode})`);
  });

  test("in sync (deployed == remote): logs 'in sync', no drift warning", () => {
    const dir = makeStateDir();
    try {
      const r = runWatchdog({
        HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA: SHA_A,
        HYDRA_WATCHDOG_DRIFT_REMOTE_SHA: SHA_A,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /in sync/, `expected 'in sync', got: ${lines}`);
      assert.doesNotMatch(lines, /DRIFT|would-deploy|AUTO-DEPLOY/, `must not warn drift, got: ${lines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drift, auto-deploy OFF (default): advisory WARNING only, never deploys", () => {
    const dir = makeStateDir();
    try {
      const r = runWatchdog({
        HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA: SHA_A,
        HYDRA_WATCHDOG_DRIFT_REMOTE_SHA: SHA_B,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
        // HYDRA_WATCHDOG_AUTODEPLOY unset -> advisory default
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /WARNING DRIFT/, `expected drift warning, got: ${lines}`);
      assert.match(lines, /auto-deploy disabled/, `expected advisory-only log, got: ${lines}`);
      assert.doesNotMatch(lines, /would-deploy|AUTO-DEPLOY/, `must not deploy when disabled, got: ${lines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drift, auto-deploy ON but within grace window: waits, does not deploy", () => {
    const dir = makeStateDir();
    try {
      const r = runWatchdog({
        HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA: SHA_A,
        HYDRA_WATCHDOG_DRIFT_REMOTE_SHA: SHA_B,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
        HYDRA_WATCHDOG_AUTODEPLOY: "1",
        HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS: "600",
        HYDRA_WATCHDOG_AUTODEPLOY_DRY_RUN: "1",
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /within grace window/, `expected grace-window log, got: ${lines}`);
      assert.doesNotMatch(lines, /would-deploy|AUTO-DEPLOY/, `must wait within grace, got: ${lines}`);
      // Marker file should now exist recording first-seen epoch.
      assert.ok(existsSync(join(dir, "hydra-watchdog-drift-since")), "expected drift marker file written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drift, auto-deploy ON, grace elapsed: would-deploy (dry-run)", () => {
    const dir = makeStateDir();
    try {
      // Pre-seed the marker far in the past so the grace window is already
      // satisfied on this single tick.
      const marker = join(dir, "hydra-watchdog-drift-since");
      writeFileSync(marker, String(Math.floor(Date.now() / 1000) - 5000));
      const r = runWatchdog({
        HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA: SHA_A,
        HYDRA_WATCHDOG_DRIFT_REMOTE_SHA: SHA_B,
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
        HYDRA_WATCHDOG_AUTODEPLOY: "1",
        HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS: "600",
        HYDRA_WATCHDOG_AUTODEPLOY_DRY_RUN: "1",
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      // Deliberate-stop guard reads /api/scheduler/status. On a host where the
      // orchestrator is stopped deliberately the block would short-circuit
      // there. Accept either: would-deploy (no deliberate stop) OR the
      // deliberate-stop guard line. Both prove grace elapsed + gate honored.
      assert.match(
        lines,
        /would-deploy|stopped deliberately/,
        `expected would-deploy or deliberate-stop guard, got: ${lines}`,
      );
      // Critically: a real deploy must never have been exec'd in dry-run.
      assert.doesNotMatch(lines, /^.*AUTO-DEPLOY — drift sustained.*\n.*auto-deploy completed/m,
        `dry-run must not run a real deploy, got: ${lines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fail-safe: empty remote SHA (git/network error) skips with WARN, exits 0", () => {
    const dir = makeStateDir();
    try {
      // Inject a deployed SHA but force the remote resolution down the real
      // ls-remote path by pointing HYDRA_ROOT at a throwaway non-repo dir so
      // `git ls-remote` fails -> empty remote_sha -> WARN + return 0.
      const r = runWatchdog({
        HYDRA_ROOT: dir, // not a git repo
        HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA: SHA_A, // skip deployed rev-parse
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0 on git error, got ${r.status}; stderr=${r.stderr}`);
      const lines = driftLines(r.stdout);
      assert.match(lines, /could not resolve origin\/master SHA/, `expected fail-safe WARN, got: ${lines}`);
      assert.doesNotMatch(lines, /DRIFT|would-deploy|AUTO-DEPLOY/, `must not act on a resolution failure, got: ${lines}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-drift clears a stale grace marker", () => {
    const dir = makeStateDir();
    try {
      const marker = join(dir, "hydra-watchdog-drift-since");
      writeFileSync(marker, String(Math.floor(Date.now() / 1000) - 9999));
      assert.ok(existsSync(marker), "precondition: marker exists");
      const r = runWatchdog({
        HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA: SHA_A,
        HYDRA_WATCHDOG_DRIFT_REMOTE_SHA: SHA_A, // now in sync
        HYDRA_WATCHDOG_DRIFT_STATE_DIR: dir,
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.ok(!existsSync(marker), "expected stale marker cleared once back in sync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
