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
import { readServiceStatus } from "../host-probe/probe.ts";
import { isLivePid, signalPid } from "../process-probe.ts";

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
