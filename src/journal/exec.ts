/**
 * journal/exec.ts — the single private spawn primitive behind the **Journal
 * Adapter** seam (issue #1958).
 *
 * The FOURTH `node:child_process` boundary in `src/`, sibling to the **GitHub
 * CLI Adapter** (`src/github/exec.ts`, `gh`/`git`) and the **Host-Probe
 * Adapter** (`src/host-probe/exec.ts`, `df`/`free`/`systemctl`). Each process
 * Seam owns its OWN `node:child_process` import — this one spawns `journalctl`.
 * They are deliberately NOT collapsed onto a shared primitive (CONTEXT.md,
 * Journal Adapter): the binaries, argv, and error modes differ, and coupling
 * two Seams onto one spawn helper is the thing the Seam boundary exists to
 * prevent.
 *
 * Why one primitive
 * -----------------
 * Before this seam the `journalctl` spawn lived inline in `src/autopilot/log.ts`
 * as `runJournalctl`, re-spelling its own binary resolution, `setTimeout` +
 * `SIGTERM` timeout discipline, 1 MB output cap with a backpressure `SIGTERM`,
 * stdout buffering, and spawn-error handling — and was carved out as an
 * acknowledged exception in BOTH `github-seam-check.ts` and
 * `host-probe-seam-check.ts`. That made it the one remaining open process
 * boundary in `src/`. This module concentrates the journalctl-specific concerns
 * (binary path via the `HYDRA_AUTOPILOT_JOURNAL_CMD` override, timeout, output
 * cap, SIGTERM, spawn error modes) in one place so a format change or a new
 * error mode is a one-file edit, and removes the two seam-check carve-outs.
 *
 * Never throws
 * ------------
 * Per CLAUDE.md (this is an external-process boundary on the same footing as the
 * gh/git and host-info seams), the primitive returns a `RawJournalResult`
 * describing exactly what happened (captured text, timeout flag, truncation
 * flag, spawn error) and lets the `read.ts` accessor map it onto a typed
 * `{ ok:true; ... } | { ok:false; code }` result. The `journal-*` `code`
 * literals live on the `HydraErrorCode` union in `src/errors.ts` as
 * RESULT-OBJECT literals — there is deliberately no thrown subclass; the seam
 * returns, it does not raise.
 */

import { spawn } from "node:child_process";

import type { HydraErrorCode } from "../errors.ts";

/** 1 MB output cap — the journalctl AC ceiling lifted verbatim from issue #499. */
const JOURNAL_MAX_BYTES = 1024 * 1024;

/** Default execution timeout for a single journalctl spawn (matches the old inline 10s). */
const DEFAULT_JOURNAL_TIMEOUT_MS = 10_000;

/**
 * The subset of `HydraErrorCode` the Journal Adapter can return on its failure
 * arm. The discriminated `{ok:true; data} | {ok:false; code}` result is owned by
 * the accessor (`read.ts`'s `JournalSliceResult`), which folds this code in
 * alongside its own `invalid-row` arm — mirroring how `src/host-probe/probe.ts`
 * shapes `ProbeResult<T>` over the primitive's `host-probe-*` codes.
 */
type JournalErrorCode = Extract<HydraErrorCode, `journal-${string}`>;

/**
 * Low-level result of a single journalctl spawn — the accessor maps this onto a
 * discriminated result. Carries the captured text alongside the flags so the accessor
 * can surface a partial slice (timed-out / truncated runs still return the bytes
 * read so far, matching the old `runJournalctl` behavior the UI panel relies on).
 */
export interface RawJournalResult {
  /** UTF-8 text captured from stdout (plus any appended truncation/timeout marker). */
  text: string;
  /** True when the 1 MB output cap was hit and the child was SIGTERM'd. */
  truncated: boolean;
  /** True when the timeout fired and the child was SIGTERM'd. */
  timedOut: boolean;
  /** Set when the spawn itself failed (synchronous throw or an `error` event). */
  spawnError?: string;
}

export interface JournalExecOptions {
  /** Override the execution timeout for this single call. Defaults to {@link DEFAULT_JOURNAL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Override the output cap for this single call. Defaults to {@link JOURNAL_MAX_BYTES}. */
  maxBytes?: number;
}

/**
 * Resolve the `journalctl` binary, honoring the `HYDRA_AUTOPILOT_JOURNAL_CMD`
 * test/override hook. Tests point this at a fake shim script; production falls
 * back to `journalctl` on PATH. Returns `undefined` for the production default
 * so the caller knows whether to pass the full `--user -u ...` argv or the
 * override's compact `[unit, since, until]` argv (the shim contract).
 */
function journalCmdOverride(): string | undefined {
  return process.env.HYDRA_AUTOPILOT_JOURNAL_CMD;
}

/**
 * Resolve the per-call timeout, honoring the `HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS`
 * test/override hook. Production never sets this and gets
 * {@link DEFAULT_JOURNAL_TIMEOUT_MS}.
 */
function journalTimeoutMs(): number {
  return Number(process.env.HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS || String(DEFAULT_JOURNAL_TIMEOUT_MS));
}

/**
 * Resolve the systemd unit to read, honoring the `HYDRA_AUTOPILOT_JOURNAL_UNIT`
 * test/override hook. Production defaults to the autopilot service unit.
 */
export function journalUnit(): string {
  return process.env.HYDRA_AUTOPILOT_JOURNAL_UNIT || "hydra-autopilot.service";
}

/**
 * The private spawn primitive. NOT exported past the seam in spirit — only the
 * `read.ts` accessor should call it. Never throws; surfaces everything via
 * {@link RawJournalResult}.
 *
 * Spawns `journalctl --user -u <unit> --since <since> --until <until>` (or the
 * compact `[unit, since, until]` argv when `HYDRA_AUTOPILOT_JOURNAL_CMD`
 * overrides the binary, the shim contract). Direct exec (no shell) so the argv
 * array is passed verbatim — no shell-quoting pitfalls. The structure mirrors
 * `src/host-probe/exec.ts`'s `runProbe` and `src/github/exec.ts`'s `runExec`
 * (separate primitives — the Seams do not share code) so a reader who knows one
 * knows the others.
 *
 * Output is capped at `maxBytes` (over-cap reads SIGTERM the child and append a
 * truncation marker); execution is capped at `timeoutMs` (SIGTERM + marker).
 * All argv values are server-controlled (sanitized ISO + a fixed unit); a
 * request body can never influence them.
 */
export function runJournal(
  unit: string,
  sinceIso: string,
  untilIso: string,
  opts: JournalExecOptions = {},
): Promise<RawJournalResult> {
  const override = journalCmdOverride();
  const timeoutMs = opts.timeoutMs ?? journalTimeoutMs();
  const maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES;

  return new Promise<RawJournalResult>((resolve) => {
    const cmd = override || "journalctl";
    const args = override
      ? [unit, sinceIso, untilIso]
      : [
          "--user",
          "-u", unit,
          "--since", sinceIso,
          "--until", untilIso,
          "--no-pager",
          "--output=short-iso",
        ];

    let child;
    try {
      // shell:false is the default for spawn; argv array, no interpolation.
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      // Synchronous spawn failure (rare). Fail loud per the coding conventions.
      console.error(
        `[journal/exec] spawn threw for ${cmd} ${args.join(" ")}: ${err?.message || err}`,
      );
      resolve({
        text: `[autopilot] journalctl spawn failed: ${err?.message || err}\n`,
        truncated: false,
        timedOut: false,
        spawnError: err?.message || String(err),
      });
      return;
    }

    let buf = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;

    const finish = (extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = buf.toString("utf-8");
      if (extra) text += extra;
      resolve({ text, truncated, timedOut, spawnError });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* intentional: best-effort kill — process may already be gone */ }
      finish(
        `\n[autopilot] --- journalctl timed out after ${timeoutMs}ms ---\n`,
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - buf.length;
      if (remaining <= 0) {
        truncated = true;
        try { child.kill("SIGTERM"); } catch { /* intentional: best-effort */ }
        finish(`\n[autopilot] --- output truncated at ${maxBytes} bytes ---\n`);
        return;
      }
      const take = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      buf = Buffer.concat([buf, take]);
      if (chunk.length > remaining) {
        truncated = true;
        try { child.kill("SIGTERM"); } catch { /* intentional: best-effort */ }
        finish(`\n[autopilot] --- output truncated at ${maxBytes} bytes ---\n`);
      }
    });

    child.stderr?.on("data", () => {
      /* intentional: discard stderr — journalctl prints "No entries" etc.,
         which is information leakage we don't want in a UI panel. The exit
         code / error event surfaces real failures. */
    });

    child.on("error", (err: any) => {
      // ENOENT here means journalctl is not installed. Capture the message so
      // the accessor can classify it. Fail loud.
      spawnError = err?.message || String(err);
      console.error(
        `[journal/exec] journalctl errored (${err?.code || "unknown"}): ${err?.message || err}`,
      );
      finish(`\n[autopilot] journalctl error: ${err?.message || err}\n`);
    });

    child.on("close", () => {
      finish();
    });
  });
}

/**
 * Map a {@link RawJournalResult} onto a `journal-*` failure `code`. Centralizing
 * this is the point of the seam: the journalctl-specific error modes get ONE
 * classification, not inline closure logic. A `truncated` or `timedOut` run is
 * NOT a failure by itself — the accessor still returns the captured partial text
 * on the success arm (the UI panel renders it); this classifier only fires when
 * the spawn itself failed.
 */
export function classifyJournalFailure(raw: RawJournalResult): JournalErrorCode {
  if (raw.spawnError) return "journal-spawn-failed";
  if (raw.timedOut) return "journal-timeout";
  if (raw.truncated) return "journal-truncated";
  return "journal-spawn-failed";
}
