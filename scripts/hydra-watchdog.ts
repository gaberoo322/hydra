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
 *   node --experimental-strip-types scripts/hydra-watchdog.ts thresholds
 *       print src/autopilot/stale-thresholds.ts as JSON (status.sh, deploy smoke)
 *
 * Env (names and semantics unchanged from the bash block):
 *   HYDRA_AUTOPILOT_STATE      state.json path (default /tmp/hydra-autopilot-state.json)
 *   HYDRA_AUTOPILOT_HEARTBEAT  heartbeat path  (default /tmp/hydra-autopilot-heartbeat.txt)
 *   STALE_THRESHOLD_SECONDS    kill threshold  (default WATCHDOG_WEDGE_KILL_THRESHOLD_S)
 *   KILL_GRACE_SECONDS         SIGTERM->SIGKILL grace (default WATCHDOG_KILL_GRACE_S)
 */

import {
  WATCHDOG_KILL_GRACE_S,
  WATCHDOG_WEDGE_KILL_THRESHOLD_S,
  staleThresholdsJson,
} from "../src/autopilot/stale-thresholds.ts";
import { SCHEDULER_TICK_STALE_S } from "../src/autopilot/stale-thresholds.ts";
import { closeTurnSnapshotRedis } from "../src/redis/turn-snapshot.ts";
import { LIVENESS_LOG_PREFIX, parseStartupGraceS, runLiveness } from "../src/watchdog/liveness.ts";
import { createProductionLivenessDeps, createProductionWedgeDeps } from "../src/watchdog/ports.ts";
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
  console.error(`hydra-watchdog.ts: unknown subcommand '${cmd ?? ""}' (expected: liveness | wedge | thresholds)`);
}

main(process.argv.slice(2)).catch((err) => {
  // Fail-open: the timer tick must never be failed by the watchdog itself.
  const prefix = process.argv[2] === "liveness" ? LIVENESS_LOG_PREFIX : WEDGE_LOG_PREFIX;
  console.log(`${prefix} WARN ${err instanceof Error ? err.message : String(err)}`);
});
