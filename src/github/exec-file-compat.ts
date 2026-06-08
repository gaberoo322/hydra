/**
 * github/exec-file-compat.ts — a compatibility shim that adapts the **GitHub
 * CLI Adapter** seam (issue #896) to the legacy `promisify(execFile)` call
 * shape (issue #899).
 *
 * Why this exists
 * ---------------
 * Before the seam, ~18 modules each `import { execFile } from "node:child_process"`,
 * `promisify`d it, and called it as `execFileAsync(cmd, args, opts) →
 * { stdout, stderr }` (throwing on a non-zero exit / ENOENT / timeout). Most of
 * those modules ALSO expose that exact callable as an injectable
 * `deps.execFileAsync` test seam, and their tests stub it directly.
 *
 * Migrating those callers onto the seam's `ghJson`/`ghExec`/`gitExec` accessors
 * in one pass would mean rewriting every caller's parse/branch logic AND every
 * test's stub from the legacy `{ stdout, stderr }`-throwing shape to the
 * `GhResult` result-object shape — a sprawling change for a behaviour-preserving
 * migration. Instead, this shim presents the SAME `execFileAsync` signature the
 * callers already consume, but routes the spawn through the seam's single
 * `runExec` primitive. A migrated caller therefore:
 *   - drops its private `import { execFile } from "node:child_process"` (so the
 *     `github-seam-check` ratchet sees the file as clean), and
 *   - keeps its existing `deps.execFileAsync ?? <default>` injection seam and
 *     its existing parse/try-catch logic UNCHANGED — only the production default
 *     changes from `promisify(execFile)` to `execFileViaSeam`.
 *
 * What this is NOT
 * ----------------
 * This is the ONE sanctioned place the seam adapts back to a throwing shape.
 * New code should prefer the discriminated `ghJson`/`ghExec`/`gitExec`
 * accessors directly (they never throw, per CLAUDE.md) — this shim is a
 * migration aid for the pre-existing `execFileAsync`-shaped callers, not a
 * general-purpose exec. It is restricted to `gh` and `git`; any other binary
 * (e.g. `df`/`free`/`systemctl`/`journalctl`) is not part of the GitHub
 * boundary and is rejected so a caller can't smuggle an arbitrary spawn through
 * the seam.
 */

import { runExec, classifyFailure, ghBin, gitBin, type GhExecOptions } from "./exec.ts";

/** The legacy `promisify(execFile)` call signature the migrated callers consume. */
export type ExecFileAsyncLike = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Error thrown by {@link execFileViaSeam} on a process-level failure (non-zero
 * exit, timeout, missing binary). Carries the seam's machine-readable
 * `GhErrorCode` so a caller that wants to discriminate can read `err.code`
 * rather than scraping `err.message` — but the primary contract is that it
 * THROWS exactly where `promisify(execFile)` would, so existing `try/catch`
 * and `Promise.allSettled` error handling at the call sites is preserved
 * verbatim.
 */
class ExecFileSeamError extends Error {
  readonly code: string;
  readonly stderr: string;
  constructor(code: string, stderr: string, cmd: string, args: readonly string[]) {
    super(stderr?.trim() ? stderr.slice(0, 500) : `${cmd} ${args.join(" ")} failed: ${code}`);
    this.name = "ExecFileSeamError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Resolve the seam binary for a legacy `cmd`. Only `gh` and `git` belong to
 * the GitHub boundary; anything else is a programming error (the caller should
 * not be routing it through this shim).
 */
function resolveSeamBin(cmd: string): string {
  if (cmd === "gh") return ghBin();
  if (cmd === "git") return gitBin();
  throw new ExecFileSeamError(
    "gh-failed",
    `execFileViaSeam only adapts 'gh' and 'git' (got "${cmd}"); use the binary's own spawn path`,
    cmd,
    [],
  );
}

/**
 * `promisify(execFile)`-shaped adapter over the GitHub CLI Adapter seam.
 *
 * Resolves `gh`/`git` through the seam's `ghBin()`/`gitBin()` (so the
 * `HYDRA_GH_BIN`/`HYDRA_GIT_BIN` overrides apply uniformly), runs the single
 * `runExec` primitive, and maps the result back onto the legacy contract:
 *   - exit 0, no timeout, no spawn error → resolves `{ stdout, stderr }`
 *   - anything else                      → throws {@link ExecFileSeamError}
 *     carrying the seam's `classifyFailure` code.
 *
 * The `opts` shape is the subset the callers actually pass (`cwd`, `timeout`,
 * `maxBuffer`, `env`); `runExec` owns the default timeout and max-buffer.
 */
export const execFileViaSeam: ExecFileAsyncLike = async (cmd, args, opts = {}) => {
  const bin = resolveSeamBin(cmd);
  const execOpts: GhExecOptions = {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    env: opts.env,
  };
  const raw = await runExec(bin, [...args], execOpts);
  if (raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode) {
    return { stdout: raw.stdout, stderr: raw.stderr };
  }
  const code = classifyFailure(raw);
  throw new ExecFileSeamError(code, raw.stderr, cmd, args);
};
