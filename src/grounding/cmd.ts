/**
 * Command-execution seam for the grounding Module (grounding/index.ts).
 *
 * Owns the three concerns that require spawning a child process or operating
 * on raw output bytes:
 *   - `truncate`      — head+tail truncation with a tail-preserving bias
 *   - `stripAnsi`     — strip CSI escape sequences before text parsing
 *   - `runCmd`        — spawn a command via execWithGroupCleanup, returning
 *                       { exitCode, stdout, stderr, durationMs }. Never throws.
 *
 * Keeping these three helpers here (rather than inlined in grounding/index.ts) lets
 * tests reach them directly — without the `_testing` escape hatch — and lets
 * callers that need only command execution import a slim surface.
 *
 * The maxBuffer-overflow contract: if either stdout or stderr overflowed the
 * 5 MB adapter limit and the process would otherwise exit 0, we force exit 1
 * so a large-but-clean run is never misread as a success.
 */

import { execWithGroupCleanup } from "../exec-with-timeout.ts";

export const CMD_TIMEOUT = 120_000; // 2 min per command (parallel tests complete in ~40s)
const OUTPUT_LIMIT = 10_000; // truncate stdout/stderr to 10KB
const RUN_CMD_MAX_BUFFER = 5 * 1024 * 1024; // 5MB — see runCmd maxBuffer-overflow note

/**
 * Truncate a string to `limit` characters using head+tail bias.
 *
 * The signal we care about most (vitest "Tests N passed" summary, tsc final
 * error counts) lives at the END of stdout. A pure head-truncate at 10 KB
 * hides it — this was the root cause of every orchestrator cycle reporting
 * "0 tests passing" from 2026-04-06 onward until the 2026-04-08 fix.
 */
export function truncate(str: string | null | undefined, limit = OUTPUT_LIMIT): string {
  if (!str || str.length <= limit) return str || "";
  const headLen = Math.floor(limit / 2);
  const tailLen = limit - headLen - 100; // reserve ~100 chars for the divider
  return (
    str.slice(0, headLen) +
    `\n... (truncated, ${str.length} total chars, keeping head + tail) ...\n` +
    str.slice(-tailLen)
  );
}

/**
 * Strip ANSI escape sequences (CSI codes: ESC [ … final byte) from a string.
 *
 * Defense in depth: any child process that ignores NO_COLOR and emits colored
 * output will have its escape codes removed before the output is passed to
 * text parsers. See the 2026-04-08 debug session — npm was passing FORCE_COLOR=1
 * through to vitest under systemd even with TERM unset.
 */
export function stripAnsi(str: string | null | undefined): string {
  if (!str) return "";
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Run a command and return `{ exitCode, stdout, stderr, durationMs }`.
 *
 * Never throws — captures all errors as non-zero exit codes. Routes through
 * `execWithGroupCleanup` so a hung child (e.g. a `npm test` that never exits)
 * reaps its entire process group on timeout, not just the direct child PID
 * (issue #226 / #844).
 */
export async function runCmd(
  cmd: string,
  args: string[],
  opts: Record<string, unknown> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  const timeout = (opts.timeout as number) || CMD_TIMEOUT;

  // Force NO_COLOR in the child env so vitest/tsc/etc. do not emit ANSI escape
  // codes that break the output parsers (parseTestCounts, parseFailingTests).
  //
  // When the orchestrator runs as a systemd service, TERM is unset, and npm
  // passes FORCE_COLOR=1 through to child processes by default — which makes
  // vitest render "Tests 633 passed" as "\x1b[2m Tests \x1b[22m ..." and the
  // regex `^\s*Tests\s+(\d+)\s+passed` fails to match. Fixed 2026-04-08.
  const childEnv = {
    ...((opts.env as Record<string, string>) || process.env),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  const result = await execWithGroupCleanup(cmd, args, {
    cwd: opts.cwd as string,
    timeout,
    env: childEnv,
    maxBuffer: RUN_CMD_MAX_BUFFER,
  });

  // maxBuffer-overflow parity (#844): the adapter truncates and resolves with
  // the real exitCode instead of throwing ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
  // Preserve the non-zero-on-overflow contract: if either stream overflowed
  // and the process would otherwise exit 0, force exit 1 so the overflow is
  // never misread as a clean success.
  const overflowed =
    result.stdout.includes(`truncated at maxBuffer=${RUN_CMD_MAX_BUFFER}`) ||
    result.stderr.includes(`truncated at maxBuffer=${RUN_CMD_MAX_BUFFER}`);
  const exitCode = overflowed && result.exitCode === 0 ? 1 : result.exitCode;

  return {
    exitCode,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    durationMs: Date.now() - start,
  };
}
