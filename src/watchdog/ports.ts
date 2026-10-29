/**
 * watchdog/ports.ts — the typed ports of the watchdog CLI checks and their
 * production adapters (issue #5095; ADR-0043 D1: one typed method per read or
 * effect, never a generic exec port). Tests use an in-memory fake that
 * implements the same interfaces — no PATH-shimmed binaries.
 *
 * No `node:child_process` here: systemctl goes through the Host-Probe Adapter,
 * signals through src/process-probe.ts (a syscall, not a binary).
 */

import { readFileSync, statSync } from "node:fs";
import {
  isProbeFailure,
  probeFileLockFree,
  readServiceActiveEnterMonotonicUs,
  readServiceStatus,
  restartService,
} from "../host-probe/probe.ts";
import { isLivePid, signalPid } from "../process-probe.ts";
import { countOpenBoard } from "../autopilot/turn-snapshot/board-saturation.ts";
import { createTurnSnapshotGithub, type TurnSnapshotGithub } from "../autopilot/turn-snapshot/github-port.ts";
import { pingRedis } from "../redis/utility.ts";
import { closeTurnSnapshotRedis, getAnchorQueueLength, quietTurnSnapshotRedisErrors } from "../redis/turn-snapshot.ts";
import { parseDeliberateStopMarker, readDeliberateStop } from "../scheduler/stop-marker.ts";
import type { DeliberateStopRead, HealthRead, PendingWorkRead, SchedulerRead } from "./liveness.ts";

/** Parsed autopilot state.json: absent, present-without-pid, or the live-candidate pid + run id. */
export type WedgeState = "missing" | "no-pid" | { pid: number; runId: string };

export interface WedgeHost {
  /** `true`/`false` for the unit's active state; `null` when the probe itself failed. */
  serviceActive(unit: string): Promise<boolean | null>;
  pidAlive(pid: number): boolean;
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): boolean;
  sleep(ms: number): Promise<void>;
}

export interface WedgeFiles {
  readStatePid(path: string): WedgeState;
  /** OS-heartbeat epoch seconds (file mtime, as the bash block read it), or `null` when missing/unreadable. */
  heartbeatEpochS(path: string): number | null;
}

export interface WedgeClock {
  nowEpochS(): number;
}

export interface WedgeDeps {
  host: WedgeHost;
  files: WedgeFiles;
  clock: WedgeClock;
  log: (line: string) => void;
}

/** Parse state.json text into a {@link WedgeState}. Pure; unparseable JSON or a non-positive pid is `no-pid`. */
export function parseStatePid(raw: string): WedgeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* intentional: unparseable state.json == no usable pid (bash: jq failure -> "0") */
    return "no-pid";
  }
  const obj = (parsed ?? {}) as { pid?: unknown; run_id?: unknown };
  const pid = Number(obj.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "no-pid";
  const runId = typeof obj.run_id === "string" && obj.run_id ? obj.run_id : "unknown";
  return { pid, runId };
}

/**
 * Heartbeat epoch (seconds) from the file's mtime ONLY — the faithful port of
 * the bash block's `stat -c %Y`. Deliberately NOT readOsHeartbeatEpoch (which
 * prefers an in-file epoch token): this value gates the irreversible SIGKILL,
 * so the age source stays exactly what the bash watchdog used. `null` when the
 * file is missing/unreadable.
 */
export function readHeartbeatMtimeEpoch(path: string): number | null {
  try {
    const mtimeS = Math.floor(statSync(path).mtimeMs / 1000);
    return Number.isFinite(mtimeS) && mtimeS > 0 ? mtimeS : null;
  } catch {
    /* intentional: missing heartbeat file -> age unknown -> decideWedge logs WARN, never kills */
    return null;
  }
}

export function createProductionWedgeDeps(log: (line: string) => void): WedgeDeps {
  return {
    host: {
      async serviceActive(unit) {
        const r = await readServiceStatus(unit);
        return r.ok ? r.data === "active" : null;
      },
      pidAlive: (pid) => isLivePid(pid),
      signal: (pid, sig) => signalPid(pid, sig),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
    files: {
      readStatePid(path) {
        let raw: string;
        try {
          raw = readFileSync(path, "utf8");
        } catch {
          /* intentional: no state file is the expected fresh-boot case */
          return "missing";
        }
        return parseStatePid(raw);
      },
      heartbeatEpochS: (path) => readHeartbeatMtimeEpoch(path),
    },
    clock: { nowEpochS: () => Math.floor(Date.now() / 1000) },
    log,
  };
}

// ---------------------------------------------------------------------------
// SERVICE LIVENESS ports (issue #5096)
// ---------------------------------------------------------------------------

export interface LivenessHost {
  /** `true`/`false` for the unit's active state; `null` when the probe itself failed. */
  serviceActive(unit: string): Promise<boolean | null>;
  /** Seconds since the unit's current activation; `null` when either clock read failed. */
  activationAgeS(unit: string): Promise<number | null>;
  /** `true` when another process holds the lock; `null` when the probe failed (fail-open: not held). */
  deployLockHeld(path: string): Promise<boolean | null>;
  restartService(unit: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface LivenessHttp {
  health(): Promise<HealthRead>;
  schedulerStatus(): Promise<SchedulerRead>;
  /** POST /api/scheduler/start (NOT a service restart). */
  startScheduler(): Promise<boolean>;
  tunnelReachable(url: string): Promise<boolean>;
}

export interface LivenessRedis {
  ping(): Promise<boolean>;
  deliberateStop(): Promise<DeliberateStopRead>;
  close(): void;
}

export interface LivenessWork {
  pendingWork(): Promise<PendingWorkRead>;
}

export interface LivenessClock {
  nowMs(): number;
}

export interface LivenessDeps {
  host: LivenessHost;
  http: LivenessHttp;
  redis: LivenessRedis;
  work: LivenessWork;
  clock: LivenessClock;
  log: (line: string) => void;
}

const HTTP_TIMEOUT_MS = 5_000;
const REDIS_TIMEOUT_MS = 3_000;

/** Race `p` against a timeout; rejects with `label timed out` so callers fail closed. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** JSON body of a 2xx fetch, or `null` on a transport failure, non-2xx, or unparseable body. */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    /* intentional: a transport/parse failure IS the failed arm of the read; the verdict log names it */
    return null;
  }
}

/** Seconds since boot from /proc/uptime, or `null` when unreadable. */
function readProcUptimeUs(): number | null {
  try {
    const first = readFileSync("/proc/uptime", "utf8").split(/\s+/)[0];
    const s = Number(first);
    return Number.isFinite(s) ? Math.floor(s * 1_000_000) : null;
  } catch {
    /* intentional: unreadable uptime -> activation age unknown -> the grace guard fails open */
    return null;
  }
}

/**
 * Tunnel reachability: ANY completed HTTP response (2xx, 3xx Access redirect,
 * 4xx, 5xx) counts as reachable — the replaced bash `curl -sS` (no `-f`) did
 * the same; only a transport error/timeout (fetch rejects) is unreachable.
 */
export async function probeTunnel(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  await fetchImpl(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "manual" });
  return true;
}

/** `gh issue list --limit` for each per-label pending-work read (the bash limit). */
export const PENDING_WORK_LIST_LIMIT = 100;

export interface PendingWorkDeps {
  github: Pick<TurnSnapshotGithub, "openIssueLabelsWithLabel">;
  readQueue: () => Promise<number>;
  log: (line: string) => void;
}

/**
 * Pending-work signal: ready-for-agent / needs-research / needs-triage are each
 * read with their OWN label-filtered listing (limit 100 each, as the bash did),
 * so a board with >100 unrelated open issues cannot hide actionable ones. A
 * failed read is `ok:false` — "could not read" is never "no work" (#3794).
 */
export async function readPendingWork(deps: PendingWorkDeps): Promise<PendingWorkRead> {
  try {
    const [rfa, research, triage, queue] = await Promise.all([
      deps.github.openIssueLabelsWithLabel("ready-for-agent", PENDING_WORK_LIST_LIMIT),
      deps.github.openIssueLabelsWithLabel("needs-research", PENDING_WORK_LIST_LIMIT),
      deps.github.openIssueLabelsWithLabel("needs-triage", PENDING_WORK_LIST_LIMIT),
      deps.readQueue(),
    ]);
    const a = countOpenBoard(rfa);
    const b = countOpenBoard(research);
    const c = countOpenBoard(triage);
    for (const counts of [a, b, c]) {
      if ("reason" in counts) {
        deps.log(`WARN board read FAILED (${counts.reason}) — cannot prove no work pending`);
        return { ok: false };
      }
    }
    if ("reason" in a || "reason" in b || "reason" in c) return { ok: false };
    return { ok: true, total: a.value.readyForAgent + b.value.needsResearch + c.value.needsTriage + queue };
  } catch (err) {
    deps.log(`WARN work-signal read FAILED: ${err instanceof Error ? err.message : String(err)} — cannot prove no work pending`);
    return { ok: false };
  }
}

export interface LivenessAdapterConfig {
  baseUrl: string;
}

export function createProductionLivenessDeps(
  log: (line: string) => void,
  config: LivenessAdapterConfig,
): LivenessDeps {
  const prefix = "hydra-orchestrator-watchdog:";
  quietTurnSnapshotRedisErrors(() => {
    /* intentional: Redis errors surface as the ping/marker/queue read failing, never as stderr noise */
  });
  const github = createTurnSnapshotGithub();
  return {
    host: {
      async serviceActive(unit) {
        const r = await readServiceStatus(unit);
        if (isProbeFailure(r)) {
          log(`${prefix} WARN systemctl is-active ${unit} failed (${r.code})`);
          return null;
        }
        return r.data === "active";
      },
      async activationAgeS(unit) {
        const r = await readServiceActiveEnterMonotonicUs(unit);
        const nowUs = readProcUptimeUs();
        if (!r.ok || nowUs === null) return null;
        return Math.max(0, Math.floor((nowUs - r.data) / 1_000_000));
      },
      async deployLockHeld(path) {
        const r = await probeFileLockFree(path);
        return r.ok ? r.data.held : null;
      },
      async restartService(unit) {
        return (await restartService(unit)).ok;
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
    http: {
      async health() {
        const body = (await fetchJson(`${config.baseUrl}/api/health`)) as Record<string, unknown> | null;
        if (body === null || typeof body !== "object") return { ok: false };
        return {
          ok: true,
          status: typeof body.status === "string" ? body.status : "",
          redis: body.redis === true,
          uptimeS: Math.floor(Number(body.uptime) || 0),
          cycleRunning: body.cycle === "running",
        };
      },
      async schedulerStatus() {
        const body = (await fetchJson(`${config.baseUrl}/api/scheduler/status`)) as Record<string, unknown> | null;
        if (body === null || typeof body !== "object") return { ok: false };
        const tick = body.lastTickAt;
        return { ok: true, running: body.running === true, lastTickAt: typeof tick === "string" && tick ? tick : null };
      },
      async startScheduler() {
        return (
          (await fetchJson(`${config.baseUrl}/api/scheduler/start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })) !== null
        );
      },
      async tunnelReachable(url) {
        try {
          return await probeTunnel(url);
        } catch {
          /* intentional: an unreachable tunnel is the verdict input, not an error */
          return false;
        }
      },
    },
    redis: {
      ping: () => withTimeout(pingRedis(), REDIS_TIMEOUT_MS, "redis ping").catch(() => false),
      async deliberateStop() {
        try {
          const raw = await withTimeout(readDeliberateStop(), REDIS_TIMEOUT_MS, "deliberate-stop read");
          return parseDeliberateStopMarker(raw) !== null ? "present" : "absent";
        } catch (err) {
          log(`${prefix} WARN deliberate-stop marker read failed: ${err instanceof Error ? err.message : String(err)}`);
          return "unreadable";
        }
      },
      close: closeTurnSnapshotRedis,
    },
    work: {
      pendingWork: () =>
        readPendingWork({
          github,
          readQueue: () => withTimeout(getAnchorQueueLength("work-queue"), REDIS_TIMEOUT_MS, "work-queue read"),
          log: (line) => log(`${prefix} ${line}`),
        }),
    },
    clock: { nowMs: () => Date.now() },
    log,
  };
}
