/**
 * turn-snapshot/host-port.ts — `TurnSnapshotHost`, the narrow typed port for
 * the two local-host reads the passthrough collectors make (ADR-0043 slice 5,
 * #4933): the failed systemd user units (`failed_services`) and plain file
 * bytes (the direction docs, the class taxonomy). One method per read, so
 * tests hand collectors typed fixtures instead of faking binaries on PATH.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `systemctl --user list-units --type=service --state=failed --no-legend` as the collector sees it. */
interface FailedUnitsRead {
  /** False when systemctl exited non-zero or could not run (the pipeline's `pipefail` arm). */
  readonly ok: boolean;
  readonly stdout: string;
}

export interface TurnSnapshotHost {
  failedServiceUnits(): Promise<FailedUnitsRead>;
  /** A file's bytes, or `null` when it is missing or unreadable (bash `[ -r "$f" ]` false). */
  readFile(path: string): Promise<Buffer | null>;
}

const SYSTEMCTL_FAILED_UNITS_ARGS = ["--user", "list-units", "--type=service", "--state=failed", "--no-legend"];

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

// ---------------------------------------------------------------------------
// #5052 - the QA-verdict recheck's one host read, its own narrow port so the
// passthrough collectors' fakes need not grow a method they never call.
// ---------------------------------------------------------------------------

export interface QaVerdictRunner {
  /**
   * Run `bash scripts/autopilot/qa-verdict-event.sh <pr> <tier>` and return
   * its parsed stdout JSON, or `null` on a non-zero exit, a spawn failure, or
   * unparseable output (the caller omits the entry - fail closed).
   */
  runQaVerdictEvent(pr: number, tier: number): Promise<unknown>;
}

const QA_VERDICT_EVENT_TIMEOUT_MS = 90_000;
const QA_VERDICT_EVENT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/autopilot/qa-verdict-event.sh");

export function createQaVerdictRunner(): QaVerdictRunner {
  return {
    runQaVerdictEvent(pr, tier) {
      return new Promise((resolveRead) => {
        execFile("bash", [QA_VERDICT_EVENT_SCRIPT, String(pr), String(tier)], { timeout: QA_VERDICT_EVENT_TIMEOUT_MS }, (err, stdout, stderr) => {
          if (err !== null) {
            console.error(`[turn-snapshot] qa-verdict-event.sh failed for PR ${pr}:`, err.message, typeof stderr === "string" ? stderr.slice(0, 300) : "");
            resolveRead(null);
            return;
          }
          try {
            resolveRead(JSON.parse(typeof stdout === "string" ? stdout : ""));
          } catch (parseErr) {
            console.error(`[turn-snapshot] qa-verdict-event.sh output for PR ${pr} was not JSON:`, parseErr);
            resolveRead(null);
          }
        });
      });
    },
  };
}
