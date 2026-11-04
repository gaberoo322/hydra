/**
 * watchdog/deploy-drift.ts — the DEPLOY DRIFT check (issue #5098, epic #5094,
 * slice 4/5; ADR-0040 Decision 2 shape: one pure decide + one run over injected
 * ports). Ported from `run_deploy_drift` in scripts/hydra-watchdog.sh (#734).
 *
 * Compares the SHA the orchestrator runs from against `origin/master` HEAD.
 * READ-ONLY on the main tree (never fetch/pull/checkout): the deployed SHA is
 * `getDeployedSha` and the remote SHA `getRemoteMasterSha` (src/health/
 * deployed-sha.ts), and the first-seen transition IS `nextDriftFirstSeen`.
 *
 * Advisory by default (log-only, no page, no event). The opt-in auto-deploy
 * (HYDRA_WATCHDOG_AUTODEPLOY=1) needs drift older than the grace window, and
 * is skipped while the scheduler is deliberately stopped. The marker is cleared
 * BEFORE the deploy so a failed deploy re-arms the window next tick.
 */

import { DEPLOY_DRIFT_GRACE_SECONDS, nextDriftFirstSeen } from "../health/deployed-sha.ts";
import {
  decideAutoAction,
  driftAgeSeconds,
  parseMarkerSeconds,
  type DriftMarkerPort,
  type SchedulerStopPort,
} from "./drift-gate.ts";

export const DEPLOY_DRIFT_LOG_PREFIX = "hydra-deploy-drift-watchdog:";

/** Wrapper bound: covers an opt-in deploy.sh run (INV-14, >= 1200s). */
export const DEPLOY_DRIFT_TIMEOUT_S = 1200;

/** Marker file name under HYDRA_WATCHDOG_DRIFT_STATE_DIR (default /tmp). */
export const DEPLOY_DRIFT_MARKER_NAME = "hydra-watchdog-drift-since";

export interface DeployDriftConfig {
  root: string;
  autoDeploy: boolean;
  graceS: number;
}

export const DEFAULT_DEPLOY_DRIFT_GRACE_S = DEPLOY_DRIFT_GRACE_SECONDS;

export interface DeployDriftDeps {
  repo: {
    /** Whether `<root>/.git` exists. */
    hasGit(root: string): boolean;
    /** `git rev-parse HEAD`, or `null` when unresolvable. */
    deployedSha(): Promise<string | null>;
    /** `git ls-remote origin master`, or `null` when unresolvable. */
    remoteSha(): Promise<string | null>;
  };
  marker: DriftMarkerPort;
  scheduler: SchedulerStopPort;
  host: {
    /** `bash scripts/deploy.sh`: its exit code, or `null` when it could not be run. */
    deploy(root: string): Promise<number | null>;
  };
  clock: { nowMs(): number };
  log: (line: string) => void;
}

export type DeployDriftState =
  | { kind: "unknown"; missing: "deployed" | "remote" }
  | { kind: "in-sync" }
  | { kind: "drift"; firstSeenMs: number; newlyAnchored: boolean };

/**
 * Pure drift state. Delegates the first-seen transition to
 * `nextDriftFirstSeen`; a garbage/absent marker is `prev = null` (anchors now).
 */
export function decideDeployDrift(input: {
  deployedSha: string | null;
  remoteSha: string | null;
  markerRaw: string | null;
  nowMs: number;
}): DeployDriftState {
  const { deployedSha, remoteSha, markerRaw, nowMs } = input;
  if (deployedSha === null) return { kind: "unknown", missing: "deployed" };
  if (remoteSha === null) return { kind: "unknown", missing: "remote" };
  const nowS = Math.floor(nowMs / 1000);
  const prev = markerRaw === null ? null : parseMarkerSeconds(markerRaw, nowS) * 1000;
  const next = nextDriftFirstSeen(prev, deployedSha, remoteSha, nowMs);
  if (next === null) return { kind: "in-sync" };
  return { kind: "drift", firstSeenMs: next, newlyAnchored: prev === null };
}

const short = (sha: string): string => sha.slice(0, 8);

/** One watchdog tick of the deploy-drift check. Never throws. */
export async function runDeployDrift(deps: DeployDriftDeps, config: DeployDriftConfig): Promise<void> {
  const say = (line: string): void => deps.log(`${DEPLOY_DRIFT_LOG_PREFIX} ${line}`);
  try {
    if (!deps.repo.hasGit(config.root)) {
      say(`WARN ${config.root} is not a git repo (.git missing); skipping drift check`);
      return;
    }
    const deployedSha = await deps.repo.deployedSha();
    if (deployedSha === null) {
      say("WARN could not resolve deployed SHA; skipping drift check");
      return;
    }
    const remoteSha = await deps.repo.remoteSha();
    if (remoteSha === null) {
      say("WARN could not resolve origin/master SHA (network/git error); skipping drift check");
      return;
    }

    const nowMs = deps.clock.nowMs();
    const nowS = Math.floor(nowMs / 1000);
    const state = decideDeployDrift({ deployedSha, remoteSha, markerRaw: deps.marker.read(), nowMs });
    if (state.kind === "unknown") return; // unreachable: both SHAs are non-null here
    if (state.kind === "in-sync") {
      deps.marker.clear();
      say(`in sync (deployed=${short(deployedSha)} == origin/master=${short(remoteSha)})`);
      return;
    }

    if (state.newlyAnchored) deps.marker.write(nowS);
    const driftAgeS = driftAgeSeconds(Math.floor(state.firstSeenMs / 1000), nowS);
    say(
      `WARNING DRIFT — deployed=${short(deployedSha)} != origin/master=${short(remoteSha)} (drift first seen ${driftAgeS}s ago). Production is running stale code; a deploy was likely cancelled by concurrency (see reference_deploy_concurrency_cancels_master).`,
    );

    // The scheduler is only consulted once the enable + grace gates pass.
    const preGate = decideAutoAction({ enabled: config.autoDeploy, driftAgeS, graceS: config.graceS, stopReason: null });
    if (preGate === "advisory") {
      say("auto-deploy disabled (HYDRA_WATCHDOG_AUTODEPLOY != 1); advisory only — run scripts/deploy.sh to converge");
      return;
    }
    if (preGate === "within-grace") {
      say(`auto-deploy armed but within grace window (drift ${driftAgeS}s < ${config.graceS}s); waiting for next tick`);
      return;
    }
    const verdict = decideAutoAction({
      enabled: config.autoDeploy,
      driftAgeS,
      graceS: config.graceS,
      stopReason: await deps.scheduler.stopReason(),
    });
    if (verdict === "deliberate-stop") {
      say("drift sustained but scheduler stopped deliberately (stopReason=deliberate); NOT auto-deploying — operator paused the system on purpose");
      return;
    }

    say(`AUTO-DEPLOY — drift sustained ${driftAgeS}s >= grace ${config.graceS}s; running scripts/deploy.sh to converge to origin/master`);
    deps.marker.clear();
    const rc = await deps.host.deploy(config.root);
    if (rc === 0) say("auto-deploy completed");
    else say("WARN auto-deploy (scripts/deploy.sh) returned non-zero; operator intervention may be needed");
  } catch (err) {
    say(`WARN deploy-drift tick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
