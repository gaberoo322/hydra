import { spawn } from "node:child_process";

/**
 * VLM claude-cli subprocess leaf (issue #3633) — the `runClaude` spawn /
 * stdout-stderr-accumulate / SIGKILL-timeout logic extracted verbatim from
 * `src/api/vlm.ts`. The `SpawnFn` injection seam is preserved so tests drive a
 * mocked child and NO live `claude` process launches in CI (ADR-0005 / issue
 * acceptance criterion).
 *
 * `runClaude` REJECTS its promise on spawn-failure / process-error / timeout
 * and RESOLVES regardless of exit code otherwise — it never throws
 * synchronously. The route (`src/api/vlm.ts`) catches the rejection and maps it
 * to a 502 result object, honoring never-throw-from-verification at the route
 * boundary.
 *
 * The signature `runClaude(spawnImpl, bin, args, timeoutMs)` matches the betting
 * fetcher (`web/src/lib/calibration/claude-cli-fetcher.ts`) verbatim as a named
 * convergence target — the two copies stay signature-compatible for a future
 * unification (kept as separate copies now; see design-concept rejected-alt).
 */

/**
 * Per-call deadline. Strictly greater than the betting text-fetcher's 120s
 * default (design-concept invariant): VLM image understanding via a Read-tool
 * round-trip is slower, and OpenViking indexing is a latency-tolerant
 * background workload — but still bounded so the route can never hang forever.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export type SpawnFn = typeof spawn;

export type ClaudeCliEnvelope = {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  usage?: unknown;
  total_cost_usd?: unknown;
  duration_ms?: unknown;
};

export type ClaudeCliRun = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export function resolveTimeoutMs(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Run `claude` and resolve on close REGARDLESS of exit code — ported verbatim
 * from the betting fetcher's `runClaude`. The CLI reports model/auth/quota
 * failures as an `is_error` envelope on STDOUT while exiting 1, and that
 * envelope's `.result` carries the human message; rejecting on `code !== 0`
 * before parsing would swallow it. stdin is ignored so the CLI never blocks
 * waiting on it; a timeout SIGKILLs the child and rejects.
 */
export function runClaude(
  spawnImpl: SpawnFn,
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ClaudeCliRun> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnImpl(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(
        new Error(
          `claude-cli spawn failed: ${error instanceof Error ? error.message : String(error)}`,
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
        reject(new Error(`claude-cli timed out after ${timeoutMs}ms`));
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
            `claude-cli spawn failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    });
    child.on("close", (code) => {
      finish(() => {
        resolve({ code, stdout, stderr });
      });
    });
  });
}
