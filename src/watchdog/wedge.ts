/**
 * watchdog/wedge.ts — the AUTOPILOT WEDGE check (issue #5095, epic #5094;
 * ADR-0040 Decision 2 shape: one pure decide + one run over injected ports).
 *
 * Ported from scripts/hydra-watchdog.sh `run_autopilot_wedge`. When the
 * autopilot `claude -p` parent freezes mid-run, neither systemd nor
 * Restart=on-failure recovers it; this check observes the OS heartbeat from
 * outside and SIGTERMs (grace, then SIGKILLs) the wedged PID.
 *
 * Heartbeat age is measured from the heartbeat FILE'S MTIME (bash `stat -c %Y`),
 * not the in-file epoch token, because it gates the irreversible SIGKILL.
 *
 * `decideWedge` is pure (no I/O, no clock, no kill). `runWedge` is the only
 * impure function, over the {@link WedgeDeps} ports. The CLI wraps `runWedge`
 * in a fail-open catch.
 */

import type { WedgeDeps, WedgeState } from "./ports.ts";

export interface WedgeConfig {
  /** systemd --user unit that owns the autopilot (a stopped unit means a human owns it). */
  unit: string;
  statePath: string;
  heartbeatPath: string;
  /** Heartbeat age (seconds) at or beyond which a live PID is wedged. */
  thresholdS: number;
  /** Seconds between SIGTERM and SIGKILL. */
  graceS: number;
}

export interface WedgeInput {
  /** `null` = the service-state probe failed (unknown). */
  serviceActive: boolean | null;
  state: WedgeState;
  pidAlive: boolean;
  /** `null` = heartbeat file missing/unreadable. */
  heartbeatAgeS: number | null;
  thresholdS: number;
}

export type WedgeVerdictKind =
  | "service-inactive"
  | "no-state"
  | "no-pid"
  | "pid-dead"
  | "heartbeat-missing"
  | "clock-skew"
  | "healthy"
  | "wedged";

export interface WedgeVerdict {
  kind: WedgeVerdictKind;
  /** The journal line (without the `hydra-autopilot-watchdog:` prefix). */
  log: string;
}

export const WEDGE_LOG_PREFIX = "hydra-autopilot-watchdog:";

/**
 * Pure verdict. Guards are evaluated in the same order as the bash block:
 * service state FIRST (a hand-launched / deliberately-stopped autopilot is
 * never killed, even with a stale heartbeat and a live PID), then state file,
 * pid, liveness, heartbeat, skew, healthy, wedged.
 */
export function decideWedge(input: WedgeInput): WedgeVerdict {
  const { serviceActive, state, pidAlive, heartbeatAgeS, thresholdS } = input;

  if (serviceActive === null) {
    return {
      kind: "service-inactive",
      log: "WARN service state unknown (probe failed); service not active as far as we can tell — leaving alone (fail-open, never fail-kill)",
    };
  }
  if (!serviceActive) {
    return {
      kind: "service-inactive",
      log: "service not active; nothing to do (hand-launched or deliberately stopped)",
    };
  }
  if (state === "missing") {
    return { kind: "no-state", log: "no state file (fresh boot or pre-bootstrap); leaving alone" };
  }
  if (state === "no-pid") {
    return { kind: "no-pid", log: "state file has no pid (fresh bootstrap in flight); leaving alone" };
  }
  if (!pidAlive) {
    return {
      kind: "pid-dead",
      log: `state PID ${state.pid} is dead (run_id=${state.runId}); bootstrap will recover on next launch — leaving alone`,
    };
  }
  if (heartbeatAgeS === null) {
    // Missing heartbeat alone is not a kill trigger — bootstrap might be
    // mid-write or heartbeat.py transiently failing.
    return {
      kind: "heartbeat-missing",
      log: `WARN heartbeat file missing (PID ${state.pid} alive); not escalating to kill`,
    };
  }
  if (heartbeatAgeS < 0) {
    return { kind: "clock-skew", log: `negative heartbeat age (${heartbeatAgeS}s); clock skew — leaving alone` };
  }
  if (heartbeatAgeS < thresholdS) {
    return {
      kind: "healthy",
      log: `healthy (heartbeat ${heartbeatAgeS}s ago, PID ${state.pid}, run_id=${state.runId}, threshold=${thresholdS}s)`,
    };
  }
  return {
    kind: "wedged",
    log: `STALE — heartbeat ${heartbeatAgeS}s ago (> ${thresholdS}s), PID ${state.pid} alive (run_id=${state.runId}) — sending SIGTERM`,
  };
}

/** Gather inputs through the ports, decide, and on `wedged` SIGTERM → grace → SIGKILL-if-alive. */
export async function runWedge(deps: WedgeDeps, config: WedgeConfig): Promise<WedgeVerdict> {
  const { host, files, clock, log } = deps;
  const say = (line: string): void => log(`${WEDGE_LOG_PREFIX} ${line}`);

  const serviceActive = await host.serviceActive(config.unit);
  const state = files.readStatePid(config.statePath);
  const pid = typeof state === "object" ? state.pid : null;
  const pidAlive = pid !== null ? host.pidAlive(pid) : false;
  const epoch = files.heartbeatEpochS(config.heartbeatPath);
  const heartbeatAgeS = epoch === null ? null : clock.nowEpochS() - epoch;

  const verdict = decideWedge({
    serviceActive,
    state,
    pidAlive,
    heartbeatAgeS,
    thresholdS: config.thresholdS,
  });
  say(verdict.log);
  if (verdict.kind !== "wedged" || pid === null) return verdict;

  if (!host.signal(pid, "SIGTERM")) {
    say(`kill -TERM ${pid} failed (process may have already exited)`);
  }
  await host.sleep(config.graceS * 1000);
  if (host.pidAlive(pid)) {
    say(`grace expired (${config.graceS}s) — PID ${pid} still alive — sending SIGKILL`);
    if (!host.signal(pid, "SIGKILL")) {
      say(`kill -KILL ${pid} failed (process exited during grace)`);
    }
  } else {
    say(`PID ${pid} exited cleanly after SIGTERM`);
  }
  return verdict;
}
