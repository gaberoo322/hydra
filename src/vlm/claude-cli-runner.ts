import { runClaudeCli, type SpawnFn } from "../claude-cli/exec.ts";

/**
 * VLM claude-cli subprocess leaf (issue #3633) — the `runClaude` spawn /
 * stdout-stderr-accumulate / SIGKILL-timeout logic extracted verbatim from
 * `src/api/vlm.ts`. The `SpawnFn` injection seam is preserved so tests drive a
 * mocked child and NO live `claude` process launches in CI (ADR-0005 / issue
 * acceptance criterion).
 *
 * Since issue #3703 the promise-wrapping spawn body itself lives behind the
 * **Claude CLI Adapter** (`src/claude-cli/exec.ts`), the seam that owns the one
 * `node:child_process` import for the `claude` binary — this leaf now composes
 * that primitive and keeps `runClaude`'s signature and error wording verbatim.
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

/**
 * Re-exported from the Claude CLI Adapter so existing importers
 * (`src/vlm/index.ts` → `src/api/vlm.ts`) need no edit (issue #3703, INV-6).
 */
export type { SpawnFn };

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
  return runClaudeCli(spawnImpl, bin, args, timeoutMs, { label: "claude-cli" });
}
