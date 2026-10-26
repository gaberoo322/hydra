/**
 * watchdog/ports.ts — the typed ports of the watchdog CLI checks and their
 * production adapters (issue #5095; ADR-0043 D1: one typed method per read or
 * effect, never a generic exec port). Tests use an in-memory fake that
 * implements the same interfaces — no PATH-shimmed binaries.
 *
 * No `node:child_process` here: systemctl goes through the Host-Probe Adapter,
 * signals through src/process-probe.ts (a syscall, not a binary).
 */

import { readFileSync } from "node:fs";
import { readServiceStatus } from "../host-probe/probe.ts";
import { isLivePid, signalPid } from "../process-probe.ts";
import { readOsHeartbeatEpoch } from "../autopilot/os-heartbeat.ts";

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
  /** OS-heartbeat epoch seconds, or `null` when missing/unreadable. */
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
      heartbeatEpochS: (path) => readOsHeartbeatEpoch(path),
    },
    clock: { nowEpochS: () => Math.floor(Date.now() / 1000) },
    log,
  };
}
