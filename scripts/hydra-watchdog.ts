#!/usr/bin/env -S node --no-warnings --experimental-strip-types
/**
 * hydra-watchdog.ts — one-shot watchdog CLI (issue #5095, epic #5094).
 *
 * A thin shell over src/watchdog/: parse argv, read config from env once, run
 * the named check over production ports. Never a service route — it must work
 * with the orchestrator down (ADR-0043 D2) — and never fails the timer: every
 * verdict and every internal error exits 0 (fail-open, like turn-snapshot.ts).
 *
 *   node --experimental-strip-types scripts/hydra-watchdog.ts liveness
 *       the SERVICE LIVENESS check (was run_service_liveness in hydra-watchdog.sh; issue #5096)
 *   node --experimental-strip-types scripts/hydra-watchdog.ts wedge
 *       the AUTOPILOT WEDGE check (was run_autopilot_wedge in hydra-watchdog.sh)
 *   node --experimental-strip-types scripts/hydra-watchdog.ts disk
 *       the TMPFS EXHAUSTION check (issue #5327): /tmp + /dev/shm inode and space
 *       use over src/watchdog/disk.ts, paged through the Operator Channel
 *   node --experimental-strip-types scripts/hydra-watchdog.ts launch-flow
 *       the LAUNCH FLOW check (issue #5097): pace-gate last-tick streaks via the
 *       shared episode tracker, delivered through the Operator Channel + EventBus
 *   node --experimental-strip-types scripts/hydra-watchdog.ts deploy-drift | redis-backup | skill-mirror | origin-identity
 *       the four slice-4 checks (issue #5098), each its own process so one crash or
 *       timeout never skips the others; env names and defaults unchanged from the
 *       bash blocks (HYDRA_WATCHDOG_AUTODEPLOY*, _SKILL_MIRROR_*, _BACKUP_*,
 *       _EXPECTED_ORIGIN_*, _CANONICAL_ORIGIN_URL, _ORIGIN_*, _DRIFT_STATE_DIR)
 *   node --experimental-strip-types scripts/hydra-watchdog.ts thresholds
 *       print src/autopilot/stale-thresholds.ts as JSON (status.sh, deploy smoke)
 *
 * Env (names and semantics unchanged from the bash block):
 *   HYDRA_AUTOPILOT_STATE      state.json path (default /tmp/hydra-autopilot-state.json)
 *   HYDRA_AUTOPILOT_HEARTBEAT  heartbeat path  (default /tmp/hydra-autopilot-heartbeat.txt)
 *   STALE_THRESHOLD_SECONDS    kill threshold  (default WATCHDOG_WEDGE_KILL_THRESHOLD_S)
 *   KILL_GRACE_SECONDS         SIGTERM->SIGKILL grace (default WATCHDOG_KILL_GRACE_S)
 *   HYDRA_WATCHDOG_DISK_PATHS        comma-separated mounts (default /tmp,/dev/shm)
 *   HYDRA_WATCHDOG_DISK_WARN_PCT     warn threshold, inodes OR space (default 80)
 *   HYDRA_WATCHDOG_DISK_CRITICAL_PCT critical threshold, inodes OR space (default 95)
 *   HYDRA_WATCHDOG_LAUNCH_{FAILSAFE,METER_DARK,QUOTA,PAUSE,LATENCY_BREACH,GLM_STERILE}_SECONDS
 *       launch-flow sustain thresholds (defaults in src/watchdog/launch-flow.ts)
 *   HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS, HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS,
 *   HYDRA_WATCHDOG_LAUNCH_NOW_MS (injectable clock, epoch-ms)
 */

import {
  WATCHDOG_KILL_GRACE_S,
  WATCHDOG_WEDGE_KILL_THRESHOLD_S,
  staleThresholdsJson,
} from "../src/autopilot/stale-thresholds.ts";
import { SCHEDULER_TICK_STALE_S } from "../src/autopilot/stale-thresholds.ts";
import { closeTurnSnapshotRedis } from "../src/redis/turn-snapshot.ts";
import { LIVENESS_LOG_PREFIX, parseStartupGraceS, runLiveness } from "../src/watchdog/liveness.ts";
import {
  DEFAULT_DISK_CRITICAL_PCT,
  DEFAULT_DISK_WARN_PCT,
  DISK_LOG_PREFIX,
  DISK_RECOVER_MARGIN_PCT,
  parseDiskPaths,
  parsePct,
  runDisk,
} from "../src/watchdog/disk.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";
import {
  DEFAULT_LAUNCH_FAILSAFE_S,
  DEFAULT_LAUNCH_GLM_STERILE_S,
  DEFAULT_LAUNCH_GLM_STERILE_WINDOW_HOURS,
  DEFAULT_LAUNCH_LATENCY_BREACH_S,
  DEFAULT_LAUNCH_LATENCY_BUDGET_MS,
  DEFAULT_LAUNCH_METER_DARK_S,
  DEFAULT_LAUNCH_PAUSE_S,
  DEFAULT_LAUNCH_QUOTA_S,
  LAUNCH_FLOW_FORCE_EXIT_MS,
  LAUNCH_FLOW_LOG_PREFIX,
  runLaunchFlow,
} from "../src/watchdog/launch-flow.ts";
import { join } from "node:path";
import { resolveOrchestratorRepo } from "../src/github/repo.ts";
import { parseNonNegativeInt } from "../src/watchdog/drift-gate.ts";
import {
  DEFAULT_DEPLOY_DRIFT_GRACE_S,
  DEPLOY_DRIFT_LOG_PREFIX,
  DEPLOY_DRIFT_MARKER_NAME,
  DEPLOY_DRIFT_TIMEOUT_S,
  runDeployDrift,
} from "../src/watchdog/deploy-drift.ts";
import {
  DEFAULT_ORIGIN_FETCH_TIMEOUT_S,
  DEFAULT_ORIGIN_HOST,
  DEFAULT_ORIGIN_REPAIR_BACKOFF_S,
  ORIGIN_IDENTITY_LOG_PREFIX,
  ORIGIN_IDENTITY_TIMEOUT_S,
  runOriginIdentity,
} from "../src/watchdog/origin-identity.ts";
import {
  DEFAULT_REDIS_BACKUP_DIR,
  REDIS_BACKUP_LOG_PREFIX,
  REDIS_BACKUP_TIMEOUT_S,
  parseStaleHours,
  runRedisBackup,
} from "../src/watchdog/redis-backup.ts";
import {
  DEFAULT_SKILL_MIRROR_GRACE_S,
  SKILL_MIRROR_LOG_PREFIX,
  SKILL_MIRROR_MARKER_NAME,
  SKILL_MIRROR_TIMEOUT_S,
  runSkillMirror,
} from "../src/watchdog/skill-mirror.ts";
import {
  createProductionDeployDriftDeps,
  createProductionDiskDeps,
  createProductionLaunchFlowDeps,
  createProductionLivenessDeps,
  createProductionOriginIdentityDeps,
  createProductionRedisBackupDeps,
  createProductionSkillMirrorDeps,
  createProductionWedgeDeps,
} from "../src/watchdog/ports.ts";
import { runWedge, WEDGE_LOG_PREFIX } from "../src/watchdog/wedge.ts";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (cmd === "thresholds") {
    console.log(JSON.stringify(staleThresholdsJson()));
    return;
  }
  if (cmd === "liveness") {
    const baseUrl = process.env.HYDRA_BASE_URL || "http://localhost:4000";
    const deps = createProductionLivenessDeps((line) => console.log(line), { baseUrl });
    try {
      await runLiveness(deps, {
        unit: "hydra-orchestrator.service",
        dockerUnit: "hydra-docker.service",
        tunnelUnit: "hydra-tunnel.service",
        startupGraceS: parseStartupGraceS(process.env.HYDRA_WATCHDOG_STARTUP_GRACE_SECONDS),
        deployLockPath: process.env.HYDRA_DEPLOY_LOCK || "/tmp/hydra-deploy.lock",
        tunnelUrl: process.env.HYDRA_TUNNEL_URL || "https://admin.clawstreetbets.xyz/api/health",
        tickStaleS: SCHEDULER_TICK_STALE_S,
      });
    } finally {
      // One-shot process: always release the Redis connection so it exits.
      closeTurnSnapshotRedis();
    }
    return;
  }
  if (cmd === "wedge") {
    await runWedge(createProductionWedgeDeps((line) => console.log(line)), {
      unit: "hydra-autopilot.service",
      statePath: process.env.HYDRA_AUTOPILOT_STATE || "/tmp/hydra-autopilot-state.json",
      heartbeatPath: process.env.HYDRA_AUTOPILOT_HEARTBEAT || "/tmp/hydra-autopilot-heartbeat.txt",
      thresholdS: envNumber("STALE_THRESHOLD_SECONDS", WATCHDOG_WEDGE_KILL_THRESHOLD_S),
      graceS: envNumber("KILL_GRACE_SECONDS", WATCHDOG_KILL_GRACE_S),
    });
    return;
  }
  if (cmd === "launch-flow") {
    // The Operator Channel CLI force-exit precedent: the channel's dedup
    // store and the bus hold connections, so an unref'd timer guarantees exit 0.
    setTimeout(() => {
      console.log(
        `hydra-launch-flow-watchdog: WARN force-exit after ${LAUNCH_FLOW_FORCE_EXIT_MS}ms (tick did not settle)`,
      );
      process.exit(0);
    }, LAUNCH_FLOW_FORCE_EXIT_MS).unref();
    const rawNow = process.env.HYDRA_WATCHDOG_LAUNCH_NOW_MS;
    try {
      await runLaunchFlow(createProductionLaunchFlowDeps((line) => console.log(line)), {
        failSafeS: envNumber("HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS", DEFAULT_LAUNCH_FAILSAFE_S),
        meterDarkS: envNumber("HYDRA_WATCHDOG_LAUNCH_METER_DARK_SECONDS", DEFAULT_LAUNCH_METER_DARK_S),
        quotaS: envNumber("HYDRA_WATCHDOG_LAUNCH_QUOTA_SECONDS", DEFAULT_LAUNCH_QUOTA_S),
        pauseS: envNumber("HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS", DEFAULT_LAUNCH_PAUSE_S),
        latencyBudgetMs: envNumber("HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS", DEFAULT_LAUNCH_LATENCY_BUDGET_MS),
        latencyBreachS: envNumber("HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS", DEFAULT_LAUNCH_LATENCY_BREACH_S),
        glmSterileS: envNumber("HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_SECONDS", DEFAULT_LAUNCH_GLM_STERILE_S),
        glmSterileWindowHours: envNumber("HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS", DEFAULT_LAUNCH_GLM_STERILE_WINDOW_HOURS),
        nowMs: rawNow === undefined ? null : envNumber("HYDRA_WATCHDOG_LAUNCH_NOW_MS", 0),
      });
    } catch (err) {
      console.log(`${LAUNCH_FLOW_LOG_PREFIX} WARN ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      closeRedisConnections();
      process.exit(0);
    }
  }
  if (cmd === "disk") {
    try {
      let warnPct = parsePct(process.env.HYDRA_WATCHDOG_DISK_WARN_PCT, DEFAULT_DISK_WARN_PCT);
      let criticalPct = parsePct(process.env.HYDRA_WATCHDOG_DISK_CRITICAL_PCT, DEFAULT_DISK_CRITICAL_PCT);
      if (warnPct >= criticalPct) {
        console.log(`${DISK_LOG_PREFIX} WARN warn pct ${warnPct} >= critical pct ${criticalPct} — using defaults`);
        warnPct = DEFAULT_DISK_WARN_PCT;
        criticalPct = DEFAULT_DISK_CRITICAL_PCT;
      }
      await runDisk(createProductionDiskDeps((line) => console.log(line)), {
        paths: parseDiskPaths(process.env.HYDRA_WATCHDOG_DISK_PATHS),
        thresholds: { warnPct, criticalPct, recoverMarginPct: DISK_RECOVER_MARGIN_PCT },
      });
    } catch (err) {
      console.log(`${DISK_LOG_PREFIX} WARN ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // One-shot process: the channel's Redis dedup store holds a connection
      // open, so exit explicitly (as the Operator Channel CLI does). Always 0.
      process.exit(0);
    }
  }
  if (cmd === "deploy-drift") {
    await runOneShot(DEPLOY_DRIFT_LOG_PREFIX, DEPLOY_DRIFT_TIMEOUT_S, async () => {
      const stateDir = process.env.HYDRA_WATCHDOG_DRIFT_STATE_DIR || "/tmp";
      await runDeployDrift(
        createProductionDeployDriftDeps((line) => console.log(line), {
          markerPath: join(stateDir, DEPLOY_DRIFT_MARKER_NAME),
          baseUrl: process.env.HYDRA_BASE_URL || "http://localhost:4000",
        }),
        {
          root: hydraRoot(),
          autoDeploy: process.env.HYDRA_WATCHDOG_AUTODEPLOY === "1",
          graceS: parseNonNegativeInt(process.env.HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS, DEFAULT_DEPLOY_DRIFT_GRACE_S),
        },
      );
    });
  }
  if (cmd === "skill-mirror") {
    await runOneShot(SKILL_MIRROR_LOG_PREFIX, SKILL_MIRROR_TIMEOUT_S, async () => {
      const stateDir = process.env.HYDRA_WATCHDOG_DRIFT_STATE_DIR || "/tmp";
      await runSkillMirror(
        createProductionSkillMirrorDeps((line) => console.log(line), {
          markerPath: join(stateDir, SKILL_MIRROR_MARKER_NAME),
          baseUrl: process.env.HYDRA_BASE_URL || "http://localhost:4000",
        }),
        {
          root: hydraRoot(),
          liveDir:
            process.env.HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR ||
            process.env.CLAUDE_SKILLS_DIR ||
            join(process.env.HOME || "", ".claude", "skills"),
          autoFix: process.env.HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX === "1",
          graceS: parseNonNegativeInt(process.env.HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_GRACE_SECONDS, DEFAULT_SKILL_MIRROR_GRACE_S),
        },
      );
    });
  }
  if (cmd === "redis-backup") {
    await runOneShot(REDIS_BACKUP_LOG_PREFIX, REDIS_BACKUP_TIMEOUT_S, async () => {
      await runRedisBackup(createProductionRedisBackupDeps((line) => console.log(line)), {
        backupDir: process.env.HYDRA_WATCHDOG_BACKUP_DIR || DEFAULT_REDIS_BACKUP_DIR,
        staleHours: parseStaleHours(process.env.HYDRA_WATCHDOG_BACKUP_STALE_HOURS),
      });
    });
  }
  if (cmd === "origin-identity") {
    await runOneShot(ORIGIN_IDENTITY_LOG_PREFIX, ORIGIN_IDENTITY_TIMEOUT_S, async () => {
      await runOriginIdentity(
        createProductionOriginIdentityDeps((line) => console.log(line), {
          stateDir: process.env.HYDRA_WATCHDOG_ORIGIN_STATE_DIR || "/tmp",
        }),
        {
          root: hydraRoot(),
          // Unset-only default: an explicit empty value is honoured (repair then refuses to act).
          expectedRepo: process.env.HYDRA_WATCHDOG_EXPECTED_ORIGIN_REPO ?? resolveOrchestratorRepo(),
          expectedHost: process.env.HYDRA_WATCHDOG_EXPECTED_ORIGIN_HOST || DEFAULT_ORIGIN_HOST,
          canonicalEnv: process.env.HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL,
          autoRepair: process.env.HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR !== "0",
          fetchTimeoutS: parseNonNegativeInt(process.env.HYDRA_WATCHDOG_ORIGIN_FETCH_TIMEOUT_S, DEFAULT_ORIGIN_FETCH_TIMEOUT_S),
          backoffS: parseNonNegativeInt(process.env.HYDRA_WATCHDOG_ORIGIN_REPAIR_BACKOFF_S, DEFAULT_ORIGIN_REPAIR_BACKOFF_S),
        },
      );
    });
  }
  console.error(
    `hydra-watchdog.ts: unknown subcommand '${cmd ?? ""}' (expected: liveness | wedge | disk | launch-flow | deploy-drift | redis-backup | skill-mirror | origin-identity | thresholds)`,
  );
}

/** The checkout the watchdog inspects (bash: `${HYDRA_ROOT:-/home/gabe/hydra}`; same default as src/health/deployed-sha.ts). */
function hydraRoot(): string {
  return process.env.HYDRA_ROOT || join(process.env.HOME || "", "hydra");
}

/**
 * Run one of the slice-4 checks as its own one-shot process (INV-1/INV-14): an
 * unref'd force-exit timer just under the bash wrapper's timeout, every
 * internal error a WARN, Redis/bus connections released, exit 0 always.
 */
async function runOneShot(prefix: string, wrapperTimeoutS: number, body: () => Promise<void>): Promise<never> {
  setTimeout(() => {
    console.log(`${prefix} WARN force-exit before the ${wrapperTimeoutS}s wrapper bound (tick did not settle)`);
    process.exit(0);
  }, Math.max(1, wrapperTimeoutS - 10) * 1000).unref();
  try {
    await body();
  } catch (err) {
    console.log(`${prefix} WARN ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    closeRedisConnections();
    process.exit(0);
  }
}

main(process.argv.slice(2)).catch((err) => {
  // Fail-open: the timer tick must never be failed by the watchdog itself.
  const prefix = process.argv[2] === "liveness" ? LIVENESS_LOG_PREFIX : WEDGE_LOG_PREFIX;
  console.log(`${prefix} WARN ${err instanceof Error ? err.message : String(err)}`);
});
