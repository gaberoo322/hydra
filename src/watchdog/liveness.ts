/**
 * watchdog/liveness.ts — the SERVICE LIVENESS check (issue #5096, epic #5094;
 * ADR-0040 Decision 2 shape: pure decide predicates + one run over injected ports).
 *
 * Ported from scripts/hydra-watchdog.sh `run_service_liveness` +
 * `read_pending_work`. Detects `hydra-orchestrator.service` reporting "active"
 * while silently making no progress: Redis down, /api/health unreachable or
 * not ok, scheduler stopped with work waiting, scheduler tick stale, tunnel
 * unreachable.
 *
 * Four pure predicates (none does I/O, reads a clock, or spawns) because the
 * block has gated reads/effects: {@link decideLiveness} over the cheap inputs,
 * {@link decideRedisRecovery}, {@link decidePendingWork} and {@link decideTunnel}.
 * {@link runLiveness} is the only impure function.
 */

import { isSchedulerTickStale, schedulerTickAgeS } from "../health/tick-liveness.ts";
import type { LivenessDeps } from "./ports.ts";

export const LIVENESS_LOG_PREFIX = "hydra-orchestrator-watchdog:";

/** Fresh-start grace default: the unit's activation younger than this skips the tick (issue #4415). `0` disarms. */
export const WATCHDOG_STARTUP_GRACE_S = 60;
/** The `uptime > 300` arm: a stopped scheduler younger than this is a fresh startup, left alone. */
export const SCHEDULER_START_WINDOW_S = 300;

/** Parse HYDRA_WATCHDOG_STARTUP_GRACE_SECONDS: digits only, anything else is the default. */
export function parseStartupGraceS(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return WATCHDOG_STARTUP_GRACE_S;
  return Number(raw);
}

export type HealthRead =
  | { ok: true; status: string; redis: boolean; uptimeS: number; cycleRunning: boolean }
  | { ok: false };

export type SchedulerRead =
  | { ok: true; running: boolean; lastTickAt: string | null }
  | { ok: false };

export type DeliberateStopRead = "present" | "absent" | "unreadable";

export interface LivenessInput {
  /** `null` = the service-state probe failed (treated as not active). */
  serviceActive: boolean | null;
  redisPong: boolean;
  /** `null` = activation age could not be read (fail-open: the guard is skipped). */
  activationAgeS: number | null;
  startupGraceS: number;
  /** `null` = the lock probe failed (fail-open: treated as NOT held). */
  deployLockHeld: boolean | null;
  health: HealthRead;
  scheduler: SchedulerRead;
  deliberateStop: DeliberateStopRead;
  tickAgeS: number | null | "unparseable";
  tickStaleS: number;
}

export type LivenessVerdictKind =
  | "service-inactive"
  | "redis-down"
  | "boot-grace"
  | "deploy-lock"
  | "health-unreachable"
  | "health-not-ok"
  | "health-redis-false"
  | "sched-unreachable"
  | "sched-deliberate-stop"
  | "sched-stopped-startup-window"
  | "sched-stopped-check-work"
  | "tick-null"
  | "cycle-running"
  | "tick-unparseable"
  | "clock-skew"
  | "stale"
  | "healthy";

export interface LivenessVerdict {
  kind: LivenessVerdictKind;
  /** The journal line (without the `hydra-orchestrator-watchdog:` prefix). */
  log: string;
  /** A WARN line to emit BEFORE `log` (the activation-age-unreadable note, which does not end the tick). */
  warn?: string;
}

/**
 * Pure verdict over the cheap inputs, evaluated in the bash order: service
 * state, Redis (Check 0, ahead of the boot-window guards on purpose), the two
 * boot-window guards, /health, scheduler status, tick staleness.
 */
export function decideLiveness(input: LivenessInput): LivenessVerdict {
  const { health, scheduler } = input;

  if (input.serviceActive !== true) {
    return {
      kind: "service-inactive",
      log:
        input.serviceActive === null
          ? "WARN service state unknown (probe failed); hydra-orchestrator.service is not active as far as we can tell; nothing to do"
          : "hydra-orchestrator.service is not active; nothing to do",
    };
  }
  if (!input.redisPong) {
    return {
      kind: "redis-down",
      log: "Redis container not responding (got: FAILED) — restarting hydra-docker.service",
    };
  }

  let warn: string | undefined;
  if (input.activationAgeS === null) {
    warn = "WARN could not determine hydra-orchestrator.service activation age — proceeding with liveness checks";
  } else if (input.activationAgeS < input.startupGraceS) {
    return {
      kind: "boot-grace",
      log: `service started ${input.activationAgeS}s ago (< ${input.startupGraceS}s grace) — skipping liveness restart this tick`,
    };
  }
  if (input.deployLockHeld === true) {
    return {
      kind: "deploy-lock",
      log: "deploy in progress (deploy lock held) — skipping liveness restart this tick",
      warn,
    };
  }

  if (!health.ok) {
    return { kind: "health-unreachable", log: "/api/health unreachable — restarting hydra-orchestrator.service", warn };
  }
  if (health.status !== "ok") {
    return {
      kind: "health-not-ok",
      log: `/health returned status='${health.status}' (not 'ok') — restarting hydra-orchestrator.service`,
      warn,
    };
  }
  if (!health.redis) {
    return { kind: "health-redis-false", log: "/health reports redis=false — restarting hydra-orchestrator.service", warn };
  }

  if (!scheduler.ok) {
    return {
      kind: "sched-unreachable",
      log: "/api/scheduler/status unreachable — restarting hydra-orchestrator.service",
      warn,
    };
  }
  if (!scheduler.running) {
    // Deliberate stop (issue #388): never tick the scheduler back on. An
    // unreadable marker is treated as present — the fail-open direction is NO restart.
    if (input.deliberateStop !== "absent") {
      return {
        kind: "sched-deliberate-stop",
        log:
          input.deliberateStop === "unreadable"
            ? "WARN deliberate-stop marker unreadable; scheduler stopped — leaving alone (stopReason=deliberate assumed)"
            : "scheduler stopped deliberately (stopReason=deliberate); leaving alone",
        warn,
      };
    }
    if (health.uptimeS > SCHEDULER_START_WINDOW_S) {
      return {
        kind: "sched-stopped-check-work",
        log: `scheduler stopped (uptime ${health.uptimeS}s) — checking for pending work`,
        warn,
      };
    }
    return {
      kind: "sched-stopped-startup-window",
      log: `scheduler not yet running (startup window, uptime ${health.uptimeS}s); leaving alone`,
      warn,
    };
  }

  if (input.tickAgeS === null) {
    return { kind: "tick-null", log: "scheduler running but lastTickAt is null (fresh restart); leaving alone", warn };
  }
  if (health.cycleRunning) {
    return { kind: "cycle-running", log: "cycle in progress (status=running); leaving alone", warn };
  }
  if (input.tickAgeS === "unparseable") {
    const raw = scheduler.lastTickAt ?? "";
    return { kind: "tick-unparseable", log: `could not parse lastTickAt='${raw}'`, warn };
  }
  if (input.tickAgeS < 0) {
    return { kind: "clock-skew", log: `negative age (${input.tickAgeS}s); clock skew — ignoring`, warn };
  }
  if (isSchedulerTickStale(input.tickAgeS, input.tickStaleS)) {
    return {
      kind: "stale",
      log: `STALE — lastTickAt was ${input.tickAgeS}s ago (> ${input.tickStaleS}s) and no cycle in progress. Restarting hydra-orchestrator.service`,
      warn,
    };
  }
  return {
    kind: "healthy",
    log: `healthy (lastTickAt ${input.tickAgeS}s ago, cycle=idle, redis=ok)`,
    warn,
  };
}

export type RedisRecoveryKind = "docker-recovered" | "docker-recovery-failed";

/** After restarting hydra-docker.service and re-pinging: recovered (then restart the orchestrator) or failed. */
export function decideRedisRecovery(retryPong: boolean): { kind: RedisRecoveryKind; log: string } {
  return retryPong
    ? { kind: "docker-recovered", log: "Docker containers recovered — restarting orchestrator" }
    : { kind: "docker-recovery-failed", log: "Docker recovery FAILED — manual intervention needed" };
}

export type PendingWorkRead = { ok: true; total: number } | { ok: false };
export type PendingWorkKind = "sched-stopped-no-work" | "sched-stopped-restart";

/**
 * Issue #3794 hard rule: "could not read it" is NEVER "there is none". Only a
 * successful read of zero leaves the scheduler alone; positive work OR a failed
 * read restarts it.
 */
export function decidePendingWork(
  read: PendingWorkRead,
  uptimeS = 0,
): { kind: PendingWorkKind; log: string } {
  if (read.ok && read.total === 0) {
    return { kind: "sched-stopped-no-work", log: "scheduler stopped, no work pending (board+queue=0); leaving alone" };
  }
  if (!read.ok) {
    return {
      kind: "sched-stopped-restart",
      log: `scheduler stopped and a work-signal read FAILED — cannot prove no work pending (uptime ${uptimeS}s); restarting scheduler via API (fail-safe)`,
    };
  }
  return {
    kind: "sched-stopped-restart",
    log: `scheduler stopped but ${read.total} items waiting (uptime ${uptimeS}s) — restarting scheduler via API`,
  };
}

export type TunnelKind = "tunnel-inactive" | "tunnel-ok" | "tunnel-restart";

export function decideTunnel(input: { tunnelActive: boolean; tunnelReachable: boolean }): { kind: TunnelKind; log: string | null } {
  if (!input.tunnelActive) return { kind: "tunnel-inactive", log: null };
  if (input.tunnelReachable) return { kind: "tunnel-ok", log: null };
  return {
    kind: "tunnel-restart",
    log: "tunnel unreachable externally but orchestrator healthy — restarting hydra-tunnel.service",
  };
}

export interface LivenessConfig {
  unit: string;
  dockerUnit: string;
  tunnelUnit: string;
  startupGraceS: number;
  deployLockPath: string;
  tunnelUrl: string;
  tickStaleS: number;
}

/**
 * Gather ONLY the cheap inputs through the ports, decide, then perform the
 * verdict's effect. Pending work is read only on `sched-stopped-check-work`;
 * the tunnel probe runs only on `healthy`.
 */
export async function runLiveness(deps: LivenessDeps, config: LivenessConfig): Promise<LivenessVerdict> {
  const { host, http, redis, work, clock, log } = deps;
  const say = (line: string): void => log(`${LIVENESS_LOG_PREFIX} ${line}`);
  const restart = async (unit: string): Promise<void> => {
    if (!(await host.restartService(unit))) say(`WARN restart of ${unit} FAILED`);
  };

  const serviceActive = await host.serviceActive(config.unit);
  const redisPong = serviceActive === true ? await redis.ping() : true;
  const activationAgeS = serviceActive === true && redisPong ? await host.activationAgeS(config.unit) : null;
  const deployLockHeld = serviceActive === true && redisPong ? await host.deployLockHeld(config.deployLockPath) : null;
  const gatherHttp = serviceActive === true && redisPong;
  const health: HealthRead = gatherHttp ? await http.health() : { ok: false };
  const scheduler: SchedulerRead = gatherHttp && health.ok ? await http.schedulerStatus() : { ok: false };
  const deliberateStop: DeliberateStopRead =
    gatherHttp && scheduler.ok && !scheduler.running ? await redis.deliberateStop() : "absent";
  const tickAgeS = scheduler.ok && scheduler.running ? schedulerTickAgeS(scheduler.lastTickAt, clock.nowMs()) : null;

  const verdict = decideLiveness({
    serviceActive,
    redisPong,
    activationAgeS,
    startupGraceS: config.startupGraceS,
    deployLockHeld,
    health,
    scheduler,
    deliberateStop,
    tickAgeS,
    tickStaleS: config.tickStaleS,
  });
  if (verdict.warn) say(verdict.warn);

  switch (verdict.kind) {
    case "redis-down": {
      say(verdict.log);
      await restart(config.dockerUnit);
      await host.sleep(5000);
      const recovery = decideRedisRecovery(await redis.ping());
      say(recovery.log);
      if (recovery.kind === "docker-recovered") await restart(config.unit);
      return verdict;
    }
    case "health-unreachable":
    case "health-not-ok":
    case "health-redis-false":
    case "sched-unreachable":
    case "stale":
      say(verdict.log);
      await restart(config.unit);
      return verdict;
    case "sched-stopped-check-work": {
      const uptimeS = health.ok ? health.uptimeS : 0;
      const decision = decidePendingWork(await work.pendingWork(), uptimeS);
      say(decision.log);
      if (decision.kind === "sched-stopped-restart") {
        if (!(await http.startScheduler())) say("WARN POST /api/scheduler/start FAILED");
      }
      return verdict;
    }
    case "healthy": {
      say(verdict.log);
      const tunnelActive = (await host.serviceActive(config.tunnelUnit)) === true;
      const tunnelReachable = tunnelActive ? await http.tunnelReachable(config.tunnelUrl) : true;
      const tunnel = decideTunnel({ tunnelActive, tunnelReachable });
      if (tunnel.log) say(tunnel.log);
      if (tunnel.kind === "tunnel-restart") await restart(config.tunnelUnit);
      return verdict;
    }
    default:
      say(verdict.log);
      return verdict;
  }
}
