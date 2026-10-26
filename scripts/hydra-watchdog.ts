#!/usr/bin/env -S node --no-warnings --experimental-strip-types
/**
 * hydra-watchdog.ts — one-shot watchdog CLI (issue #5095, epic #5094).
 *
 * A thin shell over src/watchdog/: parse argv, read config from env once, run
 * the named check over production ports. Never a service route — it must work
 * with the orchestrator down (ADR-0043 D2) — and never fails the timer: every
 * verdict and every internal error exits 0 (fail-open, like turn-snapshot.ts).
 *
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
import { createProductionWedgeDeps } from "../src/watchdog/ports.ts";
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
  console.error(`hydra-watchdog.ts: unknown subcommand '${cmd ?? ""}' (expected: wedge | thresholds)`);
}

main(process.argv.slice(2)).catch((err) => {
  // Fail-open: the timer tick must never be failed by the watchdog itself.
  console.log(`${WEDGE_LOG_PREFIX} WARN ${err instanceof Error ? err.message : String(err)}`);
});
