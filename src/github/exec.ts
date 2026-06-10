/**
 * github/exec.ts — the single private spawn primitive behind the
 * **GitHub CLI Adapter** seam (issue #896).
 *
 * Every `gh`/`git` invocation in the orchestrator funnels through here. No raw
 * `node:child_process` import is allowed to leak past this module — the `gh.ts`
 * and `git.ts` adapters are the only legitimate callers, and they expose typed,
 * result-object accessors to the rest of `src/`. This mirrors how `src/redis/`
 * owns the Redis boundary and `src/schemas/` owns the HTTP-input boundary.
 *
 * Why one primitive
 * -----------------
 * Before this seam, 18 modules each `import { execFile } from "node:child_process"`,
 * `promisify`d it, hand-built an argv, and swallowed failure with a bespoke
 * `catch`. Only `escalation.ts` honored `HYDRA_GH_BIN` and a timeout. This
 * module concentrates the binary resolution, the timeout discipline, and the
 * four error modes (binary-not-installed, auth failure, empty stdout, malformed
 * JSON) in one place so a `gh` behavior change is fixed once, fixed everywhere.
 *
 * Never throws
 * ------------
 * Per CLAUDE.md ("never throw from merge/grounding/verification" — and this is
 * an external-process boundary on the same footing), every public accessor in
 * the seam returns a discriminated `GhResult`. This primitive returns a
 * `RawExecResult` describing exactly what happened (exit code, stdout, stderr,
 * timeout flag, spawn error) and lets the adapters map it onto a typed
 * `{ ok:true; data } | { ok:false; code; stderr }`.
 *
 * The `gh`-error `code` literals live on the `HydraErrorCode` union in
 * `src/errors.ts` as RESULT-OBJECT literals — there is deliberately no thrown
 * `GhSeamError` subclass; the seam returns, it does not raise.
 */

import { spawn } from "node:child_process";

import type { HydraErrorCode } from "../errors.ts";

/** Default timeout for a single gh/git invocation. */
const DEFAULT_GH_TIMEOUT_MS = 15_000;

/** Max bytes captured from stdout/stderr each. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/**
 * The discriminated result every GitHub CLI Adapter accessor returns.
 *
 * `ok:true` carries the typed `data`. `ok:false` carries a machine-readable
 * `code` (a `gh-*` literal from `HydraErrorCode`) plus the raw `stderr` for
 * logging. Callers discriminate on `code`, NOT on `stderr` prose.
 */
export type GhResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: GhErrorCode; stderr: string };

/**
 * Type guard narrowing a `GhResult<T>` to its failure arm.
 *
 * The orchestrator's `tsconfig.json` runs `strict: false`, which turns off
 * `strictNullChecks` — and WITHOUT `strictNullChecks`, TypeScript cannot
 * discriminate a union on a boolean `ok` field via plain `if (!result.ok)`
 * control-flow narrowing (it narrows string-literal and user-guard discriminators
 * only). These two guards give callers reliable narrowing regardless of the
 * strictness setting, so accessing `.code`/`.stderr` (failure) or `.data`
 * (success) typechecks. Prefer them over `if (!result.ok)` in seam consumers.
 */
export function isGhFailure<T>(
  result: GhResult<T>,
): result is { ok: false; code: GhErrorCode; stderr: string } {
  return result.ok === false;
}

/** Type guard narrowing a `GhResult<T>` to its success arm. See {@link isGhFailure}. */
export function isGhOk<T>(result: GhResult<T>): result is { ok: true; data: T } {
  return result.ok === true;
}

/** The subset of `HydraErrorCode` the GitHub CLI Adapter can return. */
export type GhErrorCode = Extract<HydraErrorCode, `gh-${string}`>;

/** Low-level result of a single spawn — the adapters map this onto a `GhResult`. */
export interface RawExecResult {
  stdout: string;
  stderr: string;
  /** Exit code, or -1 when killed by signal / timeout / spawn failure. */
  exitCode: number;
  /** True when the timeout fired and the process was killed. */
  timedOut: boolean;
  /** Set when the spawn itself failed (e.g. ENOENT for a missing binary). */
  spawnErrorCode?: string;
}

export interface GhExecOptions {
  /** Override the timeout for this single call. Defaults to {@link DEFAULT_GH_TIMEOUT_MS}. */
  timeout?: number;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Extra environment on top of `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Max bytes captured per stream. Defaults to 10MB. */
  maxBuffer?: number;
}

/**
 * Resolve the `gh` binary, honoring the `HYDRA_GH_BIN` test/override hook.
 * Tests point this at a fake script; production falls back to `gh` on PATH.
 * This is the single home for the override that 17 of 18 callers used to lack.
 */
export function ghBin(): string {
  return process.env.HYDRA_GH_BIN || "gh";
}

/**
 * Resolve the `git` binary, honoring the `HYDRA_GIT_BIN` test/override hook.
 * Symmetric with {@link ghBin}; production falls back to `git` on PATH.
 */
export function gitBin(): string {
  return process.env.HYDRA_GIT_BIN || "git";
}

/**
 * The private spawn primitive. NOT exported past the seam — `gh.ts`/`git.ts`
 * are the only callers. Never throws; surfaces everything via {@link RawExecResult}.
 *
 * Direct exec (no shell) so an argv array is passed verbatim — no shell-quoting
 * pitfalls, matching how `escalation.ts`'s `runGh()` called `execFile`.
 */
export function runExec(
  bin: string,
  args: string[],
  opts: GhExecOptions = {},
): Promise<RawExecResult> {
  const timeout = opts.timeout ?? DEFAULT_GH_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<RawExecResult>((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      // Synchronous spawn failure (rare). Fail loud per the coding conventions.
      console.error(
        `[github/exec] spawn threw for ${bin} ${args.join(" ")}: ${err?.message || err}`,
      );
      resolve({
        stdout: "",
        stderr: err?.message || String(err),
        exitCode: -1,
        timedOut: false,
        spawnErrorCode: err?.code,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let spawnErrorCode: string | undefined;

    const killTimer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGTERM");
            } catch {
              /* intentional: process may already be gone before SIGTERM */
            }
            console.error(
              `[github/exec] timeout after ${timeout}ms — killed ${bin} ${args.join(" ")}`,
            );
          }, timeout)
        : null;
    if (killTimer && typeof killTimer.unref === "function") killTimer.unref();

    const appendCapped = (buf: string, chunk: string): string => {
      if (buf.length >= maxBuffer) return buf;
      const next = buf + chunk;
      return next.length > maxBuffer ? next.slice(0, maxBuffer) : next;
    };

    child.stdout?.on("data", (d: Buffer) => {
      stdout = appendCapped(stdout, d.toString("utf8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = appendCapped(stderr, d.toString("utf8"));
    });

    const finalize = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode, timedOut, spawnErrorCode });
    };

    child.on("error", (err: any) => {
      // ENOENT here means the binary is not installed — capture the code so the
      // adapter can map it to `gh-not-installed`. Fail loud.
      spawnErrorCode = err?.code;
      stderr = stderr + (stderr ? "\n" : "") + (err?.message || String(err));
      console.error(
        `[github/exec] ${bin} errored (${err?.code || "unknown"}): ${err?.message || err}`,
      );
      finalize(-1);
    });

    child.on("close", (code: number | null) => {
      finalize(code === null ? -1 : code);
    });
  });
}

/**
 * Map a {@link RawExecResult} onto a `gh-*` failure `code`, applied uniformly by
 * both adapters. Centralizing this is the whole point of the seam: the four
 * error modes from the issue (binary-not-installed, auth failure, empty,
 * malformed-JSON) plus timeout get ONE classification, not 18.
 *
 * `gh-empty` and `gh-malformed-json` are NOT decided here — they are
 * output-shape concerns the typed accessors raise after a successful exit.
 */
export function classifyFailure(raw: RawExecResult): GhErrorCode {
  if (raw.spawnErrorCode === "ENOENT") return "gh-not-installed";
  if (raw.timedOut) return "gh-timeout";
  // gh reports auth problems on stderr with a recognizable shape; git uses
  // "Authentication failed" / "Permission denied". Match conservatively.
  if (/\b(authentication|auth|not logged in|permission denied|403)\b/i.test(raw.stderr)) {
    return "gh-auth-failed";
  }
  return "gh-failed";
}
