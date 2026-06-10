/**
 * exec-with-timeout.ts — process-group-aware command execution with timeout.
 *
 * Replaces the standard `execFileAsync({ shell: true, timeout })` pattern
 * for commands that spawn user code (test runners, build tools). When the
 * timeout fires on `execFileAsync`, Node only signals the immediate
 * `/bin/sh -c <cmd>` child — tsx, npm-exec, node, and esbuild grandchildren
 * survive and continue consuming CPU + memory long after the orchestrator
 * has moved on. Issue #226 documented two such leaked trees totalling 9
 * stale processes from days-old autopilot cycles.
 *
 * The fix: spawn with `detached: true` so the child becomes a process-group
 * leader, then on timeout signal the entire group via the negative PID
 * (`process.kill(-pid, "SIGTERM")` → `kill -SIGTERM -<pid>` semantics).
 * After a grace window we escalate to SIGKILL on the same group.
 *
 * Result shape is a strict superset of the previous `{ stdout, stderr }`
 * destructuring used by callers, plus `exitCode`, `durationMs`, and
 * `timedOut` for callers that want to react to timeouts explicitly.
 */

import { spawn } from "node:child_process";

export interface ExecWithGroupCleanupOptions {
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Environment variables. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Total time before SIGTERM is sent to the process group. */
  timeout?: number;
  /** Grace period (ms) between SIGTERM and SIGKILL. Defaults to 5000ms. */
  killGraceMs?: number;
  /** Max bytes to capture from stdout/stderr each. Defaults to 5MB. */
  maxBuffer?: number;
  /**
   * If true, run the command through `/bin/sh -c` (matches the old
   * `execFile({ shell: true })` behaviour). If false (default), the
   * command is exec'd directly. Test runners typically want shell:true
   * so PATH lookups + `npm ...` style arguments work.
   */
  shell?: boolean;
}

export interface ExecWithGroupCleanupResult {
  stdout: string;
  stderr: string;
  /**
   * Exit code if the process exited normally, or -1 if killed by signal /
   * timeout / spawn failure. Matches the convention used elsewhere in the
   * codebase (verification.ts truncate paths, runStep error handling).
   */
  exitCode: number;
  durationMs: number;
  /** True if the timeout fired and the group was killed. */
  timedOut: boolean;
  /** The signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
}

const DEFAULT_TIMEOUT = 180_000; // 3 min — matches verification STEP_TIMEOUT
const DEFAULT_KILL_GRACE = 5_000;
const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024; // 5MB

/**
 * Spawn a command and capture its output, killing the entire process group
 * on timeout instead of just the immediate child. Never throws — failures
 * are surfaced via the result object so callers stay symmetric with the
 * existing `runStep` error-handling pattern.
 *
 * @param cmd  — executable name (resolved via PATH unless shell:true)
 * @param args — argument list. Ignored when shell:true is set; in that
 *               case the full command string is `cmd` (matches the
 *               execFileAsync({ shell: true }) coercion behaviour).
 */
export function execWithGroupCleanup(
  cmd: string,
  args: string[],
  opts: ExecWithGroupCleanupOptions = {},
): Promise<ExecWithGroupCleanupResult> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const killGrace = opts.killGraceMs ?? DEFAULT_KILL_GRACE;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const useShell = opts.shell ?? false;
  const start = Date.now();

  return new Promise<ExecWithGroupCleanupResult>((resolve) => {
    let child;
    try {
      if (useShell) {
        // Reproduce execFile({ shell: true }) semantics: join cmd + args
        // into a single shell-evaluated string. This matches what the
        // legacy verification runStep did.
        const full = [cmd, ...args].join(" ");
        child = spawn("/bin/sh", ["-c", full], {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          detached: true, // create a new process group — child is the leader
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        child = spawn(cmd, args, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (err: any) {
      resolve({
        stdout: "",
        stderr: err?.message || String(err),
        exitCode: -1,
        durationMs: Date.now() - start,
        timedOut: false,
        signal: null,
      });
      return;
    }

    // The child's PID is also the process-group leader's PGID because we
    // used detached:true. `kill(-pgid, sig)` signals every member of the
    // group, which is what we want.
    const pid = child.pid;

    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let escalateTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const truncateAppend = (
      buf: string,
      chunk: string,
      flag: { overflow: boolean },
    ): string => {
      if (flag.overflow) return buf;
      const next = buf + chunk;
      if (next.length > maxBuffer) {
        flag.overflow = true;
        return next.slice(0, maxBuffer);
      }
      return next;
    };

    const stdoutFlag = { overflow: false };
    const stderrFlag = { overflow: false };

    child.stdout?.on("data", (data: Buffer) => {
      stdout = truncateAppend(stdout, data.toString("utf8"), stdoutFlag);
      if (stdoutFlag.overflow) {
        stdoutOverflow = true;
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr = truncateAppend(stderr, data.toString("utf8"), stderrFlag);
      if (stderrFlag.overflow) {
        stderrOverflow = true;
      }
    });

    const killGroup = (signal: NodeJS.Signals): boolean => {
      if (typeof pid !== "number") return false;
      try {
        process.kill(-pid, signal);
        return true;
      } catch (err: any) {
        // ESRCH = no such process; group already gone — that is fine.
        if (err?.code !== "ESRCH") {
          console.error(
            `[exec-with-timeout] failed to ${signal} group -${pid}: ${err?.message || err}`,
          );
        }
        return false;
      }
    };

    if (timeout > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        const sent = killGroup("SIGTERM");
        if (sent) {
          console.error(
            `[exec-with-timeout] timeout after ${timeout}ms — sent SIGTERM to group -${pid} (cmd: ${cmd}${args.length > 0 ? " " + args.join(" ") : ""})`,
          );
        }
        // After grace, escalate to SIGKILL on the same group.
        escalateTimer = setTimeout(() => {
          if (settled) return;
          const sentKill = killGroup("SIGKILL");
          if (sentKill) {
            console.error(
              `[exec-with-timeout] grace expired after ${killGrace}ms — sent SIGKILL to group -${pid}`,
            );
          }
        }, killGrace);
        // Don't keep the event loop alive solely for the SIGKILL escalation.
        if (escalateTimer && typeof escalateTimer.unref === "function") {
          escalateTimer.unref();
        }
      }, timeout);
      if (killTimer && typeof killTimer.unref === "function") {
        killTimer.unref();
      }
    }

    const finalize = (exitCode: number, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);

      let finalStderr = stderr;
      if (stdoutOverflow) {
        // Mirror the truncation hint runStep already produces, so consumers
        // can spot maxBuffer hits in logs.
        stdout =
          stdout +
          `\n... (truncated at maxBuffer=${maxBuffer} bytes)`;
      }
      if (stderrOverflow) {
        finalStderr =
          finalStderr +
          `\n... (truncated at maxBuffer=${maxBuffer} bytes)`;
      }

      resolve({
        stdout,
        stderr: finalStderr,
        exitCode,
        durationMs: Date.now() - start,
        timedOut,
        signal,
      });
    };

    child.on("error", (err: any) => {
      // err message is more useful than empty stderr when spawn fails
      // outright (e.g. ENOENT). Tack it onto stderr BEFORE finalize so the
      // resolved value carries the diagnostic.
      stderr = stderr + (stderr ? "\n" : "") + (err?.message || String(err));
      finalize(-1, null);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      // `code` is null when the process was terminated by a signal.
      const exitCode = code === null ? -1 : code;
      finalize(exitCode, signal);
    });
  });
}
