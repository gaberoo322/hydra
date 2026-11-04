/**
 * The DEPLOY DRIFT watchdog check (issue #734; ported to TypeScript in #5098).
 *
 * The cases of the former bash suite, driven 1:1 over in-memory fake ports
 * (test/_helpers/watchdog-drift-fakes.mts) — no bash, no PATH shims, no real
 * git. The marker is a FILE in epoch SECONDS (INV-6), so an in-flight episode
 * survives the cut-over deploy.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_DEPLOY_DRIFT_GRACE_S,
  DEPLOY_DRIFT_LOG_PREFIX,
  DEPLOY_DRIFT_MARKER_NAME,
  decideDeployDrift,
  runDeployDrift,
} from "../src/watchdog/deploy-drift.ts";
import { DEPLOY_DRIFT_GRACE_SECONDS } from "../src/health/deployed-sha.ts";
import { NOW_MS, NOW_S, makeDeployDriftHarness } from "./_helpers/watchdog-drift-fakes.mts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const root = "/home/gabe/hydra";
const cfg = (over: Partial<{ autoDeploy: boolean; graceS: number }> = {}) => ({
  root,
  autoDeploy: false,
  graceS: 600,
  ...over,
});
const text = (logs: string[]): string => logs.join("\n");

describe("watchdog deploy-drift check (issue #734, #5098)", () => {
  test("the grace default IS DEPLOY_DRIFT_GRACE_SECONDS (one home, never a second literal)", () => {
    assert.equal(DEFAULT_DEPLOY_DRIFT_GRACE_S, DEPLOY_DRIFT_GRACE_SECONDS);
    const cli = readFileSync(join(import.meta.dirname, "..", "scripts", "hydra-watchdog.ts"), "utf8");
    assert.doesNotMatch(cli, /AUTODEPLOY_GRACE_SECONDS",\s*600/);
  });

  test("the bash entry point calls the deploy-drift CLI wrapper with the 1200s bound, in tick order", () => {
    const sh = readFileSync(join(import.meta.dirname, "..", "scripts", "hydra-watchdog.sh"), "utf8");
    assert.match(sh, /run_deploy_drift_cli\(\) \{ run_watchdog_cli deploy-drift "hydra-deploy-drift-watchdog:" 1200; \}/);
    const entry = sh.slice(sh.indexOf('if [[ "${BASH_SOURCE[0]}" == "${0}" ]]'));
    assert.match(entry, /run_disk_cli\n\s*run_deploy_drift_cli\n\s*run_redis_backup_cli/);
    assert.doesNotMatch(sh, /run_deploy_drift\(\)/);
  });

  test("in sync (deployed == remote): logs 'in sync', no drift warning", async () => {
    const h = makeDeployDriftHarness();
    await runDeployDrift(h.deps, cfg());
    assert.match(text(h.logs), /in sync \(deployed=aaaaaaaa == origin\/master=aaaaaaaa\)/);
    assert.doesNotMatch(text(h.logs), /WARNING DRIFT/);
    assert.ok(h.logs.every((l) => l.startsWith(DEPLOY_DRIFT_LOG_PREFIX)));
    assert.equal(h.deploys.length, 0);
  });

  test("drift, auto-deploy OFF (default): advisory WARNING only, never deploys", async () => {
    const h = makeDeployDriftHarness();
    h.state.remote = SHA_B;
    await runDeployDrift(h.deps, cfg());
    assert.match(text(h.logs), /WARNING DRIFT — deployed=aaaaaaaa != origin\/master=bbbbbbbb \(drift first seen 0s ago\)/);
    assert.match(text(h.logs), /auto-deploy disabled .*advisory only/);
    assert.equal(h.deploys.length, 0);
    assert.deepEqual(h.marker.writes, [NOW_S], "the first drift tick anchors the marker");
    assert.equal(h.scheduler.calls, 0, "advisory never consults the scheduler");
  });

  test("drift, auto-deploy ON but within grace window: waits, does not deploy", async () => {
    const h = makeDeployDriftHarness({ marker: `${NOW_S - 100}\n` });
    h.state.remote = SHA_B;
    await runDeployDrift(h.deps, cfg({ autoDeploy: true }));
    assert.match(text(h.logs), /within grace window \(drift 100s < 600s\)/);
    assert.equal(h.deploys.length, 0);
    assert.equal(h.marker.raw, `${NOW_S - 100}\n`, "an existing marker is kept, not restamped");
    assert.equal(h.scheduler.calls, 0);
  });

  test("drift, auto-deploy ON, grace elapsed: clears the marker BEFORE running deploy.sh", async () => {
    const h = makeDeployDriftHarness({ marker: `${NOW_S - 700}\n` });
    h.state.remote = SHA_B;
    const order: string[] = [];
    const clear = h.marker.clear.bind(h.marker);
    h.marker.clear = () => {
      order.push("clear");
      clear();
    };
    const deploy = h.deps.host.deploy;
    h.deps.host.deploy = async (r) => {
      order.push("deploy");
      return deploy(r);
    };
    await runDeployDrift(h.deps, cfg({ autoDeploy: true }));
    assert.deepEqual(order, ["clear", "deploy"]);
    assert.deepEqual(h.deploys, [root]);
    assert.match(text(h.logs), /AUTO-DEPLOY — drift sustained 700s >= grace 600s/);
    assert.match(text(h.logs), /auto-deploy completed/);
  });

  test("a non-zero deploy.sh exit is one WARN line and the marker stays cleared (next tick re-arms)", async () => {
    const h = makeDeployDriftHarness({ marker: `${NOW_S - 700}\n` });
    h.state.remote = SHA_B;
    h.state.deployRc = 3;
    await runDeployDrift(h.deps, cfg({ autoDeploy: true }));
    assert.match(text(h.logs), /WARN auto-deploy \(scripts\/deploy\.sh\) returned non-zero/);
    assert.equal(h.marker.raw, null);
  });

  test("a scheduler stopped deliberately blocks the auto-deploy; an unreachable API does not", async () => {
    const stopped = makeDeployDriftHarness({ marker: `${NOW_S - 700}\n`, stopReason: "deliberate" });
    stopped.state.remote = SHA_B;
    await runDeployDrift(stopped.deps, cfg({ autoDeploy: true }));
    assert.match(text(stopped.logs), /scheduler stopped deliberately/);
    assert.equal(stopped.deploys.length, 0);

    const unreachable = makeDeployDriftHarness({ marker: `${NOW_S - 700}\n`, stopReason: null });
    unreachable.state.remote = SHA_B;
    await runDeployDrift(unreachable.deps, cfg({ autoDeploy: true }));
    assert.equal(unreachable.deploys.length, 1);
  });

  test("fail-safe: an unresolvable SHA logs ONE WARN and leaves the marker untouched", async () => {
    const remoteDown = makeDeployDriftHarness({ marker: `${NOW_S - 50}\n` });
    remoteDown.state.remote = null;
    await runDeployDrift(remoteDown.deps, cfg());
    assert.equal(remoteDown.logs.length, 1);
    assert.match(text(remoteDown.logs), /WARN could not resolve origin\/master SHA/);
    assert.equal(remoteDown.marker.raw, `${NOW_S - 50}\n`);

    const deployedDown = makeDeployDriftHarness();
    deployedDown.state.deployed = null;
    await runDeployDrift(deployedDown.deps, cfg());
    assert.match(text(deployedDown.logs), /WARN could not resolve deployed SHA/);
  });

  test("a missing .git skips with a WARN", async () => {
    const h = makeDeployDriftHarness();
    h.state.hasGit = false;
    await runDeployDrift(h.deps, cfg());
    assert.match(text(h.logs), /WARN \/home\/gabe\/hydra is not a git repo/);
  });

  test("no-drift clears a stale grace marker", async () => {
    const h = makeDeployDriftHarness({ marker: `${NOW_S - 9999}\n` });
    await runDeployDrift(h.deps, cfg({ autoDeploy: true }));
    assert.equal(h.marker.raw, null);
    assert.equal(h.deploys.length, 0);
  });

  test("a garbage marker reads as now (age 0) and a future marker clamps to age 0", () => {
    const garbage = decideDeployDrift({ deployedSha: SHA_A, remoteSha: SHA_B, markerRaw: "not-a-number", nowMs: NOW_MS });
    assert.deepEqual(garbage, { kind: "drift", firstSeenMs: NOW_MS, newlyAnchored: false });
    const future = decideDeployDrift({ deployedSha: SHA_A, remoteSha: SHA_B, markerRaw: `${NOW_S + 500}`, nowMs: NOW_MS });
    assert.equal(future.kind, "drift");
  });

  test("the marker keeps its pre-cut-over file name (continuity across the deploy)", () => {
    assert.equal(DEPLOY_DRIFT_MARKER_NAME, "hydra-watchdog-drift-since");
    assert.equal(existsSync(join(import.meta.dirname, "..", "src", "watchdog", "deploy-drift.ts")), true);
  });
});
