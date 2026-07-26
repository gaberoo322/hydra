/**
 * claude-cli/exec.ts — the single private spawn primitive behind the **Claude
 * CLI Adapter** seam (issue #3703).
 *
 * The FIFTH `node:child_process` boundary in `src/`, sibling to the **GitHub CLI
 * Adapter** (`src/github/exec.ts`, `gh`/`git`), the **Host-Probe Adapter**
 * (`src/host-probe/exec.ts`, `df`/`free`/`systemctl`) and the **Journal
 * Adapter** (`src/journal/exec.ts`, `journalctl`). Each process Seam owns its
 * OWN `node:child_process` import — this one spawns the `claude` CLI. They are
 * deliberately NOT collapsed onto a shared primitive: the binaries, argv, and
 * error modes differ, and coupling two Seams onto one spawn helper is the thing
 * the Seam boundary exists to prevent.
 *
 * Why this seam exists
 * --------------------
 * `github-seam-check` and `host-probe-seam-check` match the `node:child_process`
 * **import**, not the spawned binary. That works while every spawn site belongs
 * to a Seam that owns a binary family — but a file that shells out to the
 * `claude` CLI belonged to NONE of them: it is neither a gh/git call nor a host
 * probe, so both ratchets flagged it with no correct adapter to migrate to. The
 * three sites (`src/vlm/claude-cli-runner.ts`, `src/glm/drainer-runner.ts`,
 * `src/api/vlm.ts`) therefore reddened `advisory-checks` on every run, draining
 * the surface of signal. Baselining them would have laundered a structural gap
 * into an allowlist and the NEXT claude spawn site would have re-reddened both
 * checks. Opening a proper Seam closes the boundary instead, and
 * `claude-cli-seam-check` freezes it shut at zero.
 *
 * What moved, and what deliberately did not
 * -----------------------------------------
 * `runClaude` (VLM, issue #3633) and `runGlmClaude` (GLM drainer, issue #3688 /
 * ADR-0032) carried byte-identical promise-wrapping spawn bodies that differed
 * only in their error label and in passing `env`/`cwd`. ONLY that body moved
 * here; both public functions keep their exported names, parameter order and
 * return contracts, so no caller needed a signature edit. The GLM env fence
 * (`buildGlmEnv`, `STRIPPED_ENV_KEYS`, `preflightBeforePr` and the ADR-0032
 * money/quota-critical invariants) is untouched — it composes the argv and env
 * and hands them here.
 *
 * The `spawnImpl` injection seam is preserved verbatim and is load-bearing: it
 * is a standing acceptance criterion of BOTH #3633 and #3688 that no live
 * `claude` process ever launches in CI. Tests inject a mock; production passes
 * {@link defaultClaudeSpawn}.
 *
 * Never throws synchronously
 * --------------------------
 * The primitive REJECTS on spawn-failure, on a child `error` event, and on
 * timeout (after SIGKILL), and RESOLVES regardless of exit code otherwise. The
 * resolve-on-non-zero-exit rule is load-bearing: the claude CLI reports
 * auth/quota/model failures as an `is_error` envelope on STDOUT while exiting
 * non-zero, and rejecting on `code !== 0` before the caller can parse that
 * envelope would swallow the human-readable diagnosis.
 */

import { spawn } from "node:child_process";

/**
 * The injectable spawn signature. Every claude-CLI caller threads one of these
 * so tests can drive a mocked child; `typeof spawn` keeps it structurally exact.
 */
export type SpawnFn = typeof spawn;

/**
 * The production spawn implementation. Callers default their injectable
 * `spawnImpl` to this rather than importing `node:child_process` themselves —
 * that indirection is what keeps this file the seam's single importer.
 */
export const defaultClaudeSpawn: SpawnFn = spawn;

/** Low-level result of one `claude` CLI run. `code` is null when killed by signal. */
export interface ClaudeCliSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ClaudeCliSpawnOptions {
  /**
   * Error-message prefix identifying the calling lane (e.g. `"claude-cli"` for
   * the VLM route, `"glm-drainer"` for the GLM lane). Preserves each caller's
   * pre-seam error wording verbatim, which their tests pin.
   */
  label: string;
  /** Environment for the child. GLM passes its fenced env; VLM inherits (undefined). */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child. */
  cwd?: string;
}

/**
 * Run the `claude` CLI and resolve on close REGARDLESS of exit code.
 *
 * stdin is ignored so the CLI never blocks waiting on it; a timeout SIGKILLs the
 * child and rejects. All argv is passed as an array (no shell), so there is no
 * shell-quoting or injection surface.
 */
export function runClaudeCli(
  spawnImpl: SpawnFn,
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  options: ClaudeCliSpawnOptions,
): Promise<ClaudeCliSpawnResult> {
  const { label } = options;
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnImpl(bin, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env,
        cwd: options.cwd,
      });
    } catch (error) {
      reject(
        new Error(
          `${label} spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentional: child may already be gone; the timeout error is what matters */
        }
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish(() => {
        reject(
          new Error(
            `${label} spawn failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    });
    child.on("close", (code) => {
      finish(() => {
        resolvePromise({ code, stdout, stderr });
      });
    });
  });
}
