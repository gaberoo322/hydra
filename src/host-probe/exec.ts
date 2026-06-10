/**
 * host-probe/exec.ts — the single private spawn primitive behind the
 * **Host-Probe Adapter** seam (issue #939).
 *
 * Sibling Seam to the **GitHub CLI Adapter** (`src/github/exec.ts`): both close
 * an external-process boundary behind one private spawn primitive, but each owns
 * its OWN `node:child_process` import. This module spawns the host-info binaries
 * (`df`, `free`, `systemctl`); the GitHub CLI Adapter spawns `gh`/`git`. They are
 * deliberately NOT collapsed onto a shared primitive — CONTEXT.md (Host-Probe
 * Adapter) calls this out: "each process Seam owns its own `node:child_process`".
 *
 * Why one primitive
 * -----------------
 * Before this seam the host-info binaries lived as raw `execFileAsync(...)`
 * calls inline in the `/api/health/deep` route handler, each re-spelling its own
 * binary name, argv, 3000ms timeout, and a `.catch(() => null)` /
 * `.catch(() => "unknown")` that swallowed every failure into a sentinel — the
 * exact silent-catch shape CLAUDE.md's fail-loud rule exists to prevent. This
 * module concentrates the binary resolution, the timeout discipline, and the
 * external-process error modes in one place.
 *
 * Never throws
 * ------------
 * Per CLAUDE.md (this is an external-process boundary on the same footing as the
 * gh/git seam), the primitive returns a `RawProbeResult` describing exactly what
 * happened (exit code, stdout, stderr, timeout flag, spawn error) and lets the
 * `probe.ts` accessors map it onto a typed
 * `{ ok:true; data } | { ok:false; code }` result. The `host-probe-*` `code`
 * literals live on the `HydraErrorCode` union in `src/errors.ts` as
 * RESULT-OBJECT literals — there is deliberately no thrown subclass; the seam
 * returns, it does not raise.
 */

import { spawn } from "node:child_process";

import type { HydraErrorCode } from "../errors.ts";

/** Default timeout for a single host-info probe (matches the old inline 3000ms). */
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/** Max bytes captured from stdout/stderr each. Host-info output is tiny; cap generously anyway. */
const DEFAULT_MAX_BUFFER = 1 * 1024 * 1024; // 1MB

/** The subset of `HydraErrorCode` the Host-Probe Adapter can return. */
export type HostProbeErrorCode = Extract<HydraErrorCode, `host-probe-${string}`>;

/**
 * The discriminated result every Host-Probe Adapter accessor returns.
 *
 * `ok:true` carries the typed `data`. `ok:false` carries a machine-readable
 * `code` (a `host-probe-*` literal from `HydraErrorCode`). Callers discriminate
 * on `code`, NOT on stderr prose.
 */
export type ProbeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: HostProbeErrorCode };

/**
 * Type guard narrowing a `ProbeResult<T>` to its failure arm.
 *
 * The orchestrator's `tsconfig.json` runs `strict: false` (no `strictNullChecks`),
 * so TypeScript cannot discriminate a union on a boolean `ok` field via plain
 * `if (!result.ok)` control-flow narrowing. These guards give callers reliable
 * narrowing regardless of the strictness setting — mirroring `isGhFailure`/
 * `isGhOk` in the GitHub CLI Adapter.
 */
export function isProbeFailure<T>(
  result: ProbeResult<T>,
): result is { ok: false; code: HostProbeErrorCode } {
  return result.ok === false;
}

/** Type guard narrowing a `ProbeResult<T>` to its success arm. See {@link isProbeFailure}. */
export function isProbeOk<T>(result: ProbeResult<T>): result is { ok: true; data: T } {
  return result.ok === true;
}

/** Low-level result of a single spawn — the accessors map this onto a `ProbeResult`. */
export interface RawProbeResult {
  stdout: string;
  stderr: string;
  /** Exit code, or -1 when killed by signal / timeout / spawn failure. */
  exitCode: number;
  /** True when the timeout fired and the process was killed. */
  timedOut: boolean;
  /** Set when the spawn itself failed (e.g. ENOENT for a missing binary). */
  spawnErrorCode?: string;
}

export interface ProbeExecOptions {
  /** Override the timeout for this single call. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeout?: number;
  /** Max bytes captured per stream. Defaults to 1MB. */
  maxBuffer?: number;
}

/**
 * Resolve the `df` binary, honoring the `HYDRA_DF_BIN` test/override hook.
 * Tests point this at a fake script; production falls back to `df` on PATH.
 */
export function dfBin(): string {
  return process.env.HYDRA_DF_BIN || "df";
}

/**
 * Resolve the `free` binary, honoring the `HYDRA_FREE_BIN` test/override hook.
 * Symmetric with {@link dfBin}; production falls back to `free` on PATH.
 */
export function freeBin(): string {
  return process.env.HYDRA_FREE_BIN || "free";
}

/**
 * Resolve the `systemctl` binary, honoring the `HYDRA_SYSTEMCTL_BIN` override.
 * Symmetric with {@link dfBin}; production falls back to `systemctl` on PATH.
 */
export function systemctlBin(): string {
  return process.env.HYDRA_SYSTEMCTL_BIN || "systemctl";
}

/**
 * The private spawn primitive. NOT exported past the seam in spirit — only the
 * `probe.ts` accessors should call it. Never throws; surfaces everything via
 * {@link RawProbeResult}.
 *
 * Direct exec (no shell) so the argv array is passed verbatim — no shell-quoting
 * pitfalls, matching how the inline host probes called `execFileAsync`. The
 * structure mirrors `src/github/exec.ts`'s `runExec` (a separate primitive — the
 * two seams do not share code) so a reader who knows one knows the other.
 */
export function runProbe(
  bin: string,
  args: string[],
  opts: ProbeExecOptions = {},
): Promise<RawProbeResult> {
  const timeout = opts.timeout ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<RawProbeResult>((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      // Synchronous spawn failure (rare). Fail loud per the coding conventions.
      console.error(
        `[host-probe/exec] spawn threw for ${bin} ${args.join(" ")}: ${err?.message || err}`,
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
              `[host-probe/exec] timeout after ${timeout}ms — killed ${bin} ${args.join(" ")}`,
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
      // accessor can map it to `host-probe-not-installed`. Fail loud.
      spawnErrorCode = err?.code;
      stderr = stderr + (stderr ? "\n" : "") + (err?.message || String(err));
      console.error(
        `[host-probe/exec] ${bin} errored (${err?.code || "unknown"}): ${err?.message || err}`,
      );
      finalize(-1);
    });

    child.on("close", (code: number | null) => {
      finalize(code === null ? -1 : code);
    });
  });
}

/**
 * Map a {@link RawProbeResult} onto a `host-probe-*` failure `code`. Centralizing
 * this is the point of the seam: the external-process error modes (binary not
 * installed, timeout, non-zero exit) get ONE classification, not three inline
 * `.catch()` arms. `host-probe-empty` is NOT decided here — it is an
 * output-shape concern the typed accessors raise after a successful exit.
 */
export function classifyProbeFailure(raw: RawProbeResult): HostProbeErrorCode {
  if (raw.spawnErrorCode === "ENOENT") return "host-probe-not-installed";
  if (raw.timedOut) return "host-probe-timeout";
  return "host-probe-failed";
}
