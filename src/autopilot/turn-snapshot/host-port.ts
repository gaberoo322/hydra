/**
 * turn-snapshot/host-port.ts — `TurnSnapshotHost`, the narrow typed port for
 * the two local-host reads the passthrough collectors make (ADR-0043 slice 5,
 * #4933): the failed systemd user units (`failed_services`) and plain file
 * bytes (the direction docs, the class taxonomy). One method per read, so
 * tests hand collectors typed fixtures instead of faking binaries on PATH.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** `systemctl --user list-units --type=service --state=failed --no-legend` as the collector sees it. */
export interface FailedUnitsRead {
  /** False when systemctl exited non-zero or could not run (the pipeline's `pipefail` arm). */
  readonly ok: boolean;
  readonly stdout: string;
}

export interface TurnSnapshotHost {
  failedServiceUnits(): Promise<FailedUnitsRead>;
  /** A file's bytes, or `null` when it is missing or unreadable (bash `[ -r "$f" ]` false). */
  readFile(path: string): Promise<Buffer | null>;
}

export const SYSTEMCTL_FAILED_UNITS_ARGS = ["--user", "list-units", "--type=service", "--state=failed", "--no-legend"];

const SYSTEMCTL_TIMEOUT_MS = 15_000;

/** The production host port: real systemctl + real filesystem. */
export function createTurnSnapshotHost(): TurnSnapshotHost {
  return {
    failedServiceUnits() {
      return new Promise((resolve) => {
        execFile("systemctl", SYSTEMCTL_FAILED_UNITS_ARGS, { timeout: SYSTEMCTL_TIMEOUT_MS }, (err, stdout) => {
          /* intentional: a failed/missing systemctl is the read's `ok: false` arm, rendered as the legacy fallback */
          resolve({ ok: err === null, stdout: typeof stdout === "string" ? stdout : "" });
        });
      });
    },
    async readFile(path) {
      try {
        return await readFile(path);
      } catch {
        /* intentional: missing/unreadable is the `null` arm — bash's `[ -r ]` false (no drift / unavailable taxonomy) */
        return null;
      }
    },
  };
}
