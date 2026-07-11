/**
 * github/gh.ts — the `gh` adapter of the **GitHub CLI Adapter** seam (issue #896).
 *
 * Owns the `gh` external interface: running an argv, capturing stdout, and
 * (for read queries) JSON-parsing `--json` output into typed results. Splits
 * from `git.ts` by external interface — `gh` and `git` are different binaries
 * with different argv alphabets — but both sit on the ONE private spawn
 * primitive in `exec.ts`. No raw `child_process` leaks past this module.
 *
 * Every accessor returns a discriminated `GhResult<T>` and NEVER throws
 * (CLAUDE.md). The `gh-*` failure codes are result-object literals on the
 * `HydraErrorCode` union, not thrown subclasses.
 *
 * Migration note: `src/pattern-memory/escalation.ts` is the first caller to
 * fold its private `runGh()`/`ghBin()` onto this adapter (the tracer-bullet
 * slice). The other 17 `node:child_process`-shelling modules migrate in
 * follow-up slices.
 */

import {
  ghBin,
  runExec,
  classifyFailure,
  type GhResult,
  type GhExecOptions,
  type GhErrorCode,
} from "./exec.ts";
import {
  readGhRateLimitBackoff,
  writeGhRateLimitBackoff,
  clearGhRateLimitBackoff,
  nextGhRateLimitBackoff,
} from "../redis/oauth-backoff.ts";

/**
 * On a `gh-rate-limited` classification (issue #3137), advance the persisted
 * exponential-backoff gate and emit a structured observability warning so a
 * sustained GitHub rate-limit surfaces in the logs (and, via the persisted
 * gate, survives a restart) instead of being a silent retry storm.
 *
 * KNOWN CLI CONSTRAINT: `gh` does not surface the raw `x-ratelimit-reset` /
 * `x-ratelimit-remaining` headers, so the exact reset instant and the "quota <
 * 20%" health warning from the issue's suggested-fix list are NOT implementable
 * via the CLI. The gate is therefore keyed off the structured `rate_limit_error`
 * classification, not headers — an adaptive backoff that IS implementable
 * without them. Best-effort: NEVER throws (a Redis outage degrades to the
 * pre-#3137 no-gate behaviour).
 */
async function armGhRateLimitGate(argsJoined: string): Promise<void> {
  try {
    const prior = await readGhRateLimitBackoff();
    const failures = (prior?.failures ?? 0) + 1;
    const next = nextGhRateLimitBackoff(failures, Date.now());
    await writeGhRateLimitBackoff(next);
    const waitMs = Math.max(0, next.nextAttemptMs - Date.now());
    console.error(
      `[github/gh] gh ${argsJoined} rate-limited (gh-rate-limited) — ` +
        `consecutive=${failures}, backing off ~${Math.round(waitMs / 1000)}s ` +
        `(next attempt ${new Date(next.nextAttemptMs).toISOString()}). ` +
        `NOTE: gh hides x-ratelimit-* headers; backoff keyed off the structured error.`,
    );
  } catch (err: any) {
    // Fail open — an observability/gate failure must never break the gh call.
    console.error(
      `[github/gh] failed to arm rate-limit backoff gate (degrading to no gate): ${err?.message || err}`,
    );
  }
}

/**
 * On a SUCCESSFUL `gh` call, opportunistically clear a previously-armed
 * rate-limit gate so recovery resets the ladder (issue #3137). Only clears when
 * a gate is actually present, to avoid a Redis round-trip on every success.
 * Best-effort: NEVER throws.
 */
async function clearGhRateLimitGateOnSuccess(): Promise<void> {
  try {
    const prior = await readGhRateLimitBackoff();
    if (prior !== null) await clearGhRateLimitBackoff();
  } catch (err: any) {
    console.error(
      `[github/gh] failed to clear rate-limit backoff gate (stale gate self-expires at TTL): ${err?.message || err}`,
    );
  }
}

/**
 * Post-classification hook shared by {@link ghExec} and {@link ghJson}: arm the
 * gate on a rate-limit code, clear it on success. Fire-and-forget is deliberate
 * — the gate is a side-channel, so a `gh` result is NEVER delayed on the Redis
 * write (the same fail-open posture the seam requires).
 */
function recordGhRateLimitSignal(code: GhErrorCode | null, argsJoined: string): void {
  if (code === "gh-rate-limited") {
    void armGhRateLimitGate(argsJoined);
  } else if (code === null) {
    void clearGhRateLimitGateOnSuccess();
  }
}

/**
 * Run an arbitrary `gh` argv and return its stdout on success.
 *
 * This is the low-level escape hatch the write verbs (`gh issue create`,
 * `gh issue comment`, `gh issue reopen`, `gh label create`, ...) ride on: they
 * need the process to succeed but don't parse structured output. On a non-zero
 * exit / spawn failure / timeout the result is the failure arm with a
 * machine-readable `code`.
 *
 * @param args — the `gh` argv WITHOUT the leading `gh` (e.g. `["issue","list",...]`).
 */
export async function ghExec(
  args: string[],
  opts: GhExecOptions = {},
): Promise<GhResult<{ stdout: string; stderr: string }>> {
  const raw = await runExec(ghBin(), args, opts);
  if (raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode) {
    recordGhRateLimitSignal(null, args.join(" "));
    return { ok: true, data: { stdout: raw.stdout, stderr: raw.stderr } };
  }
  const code = classifyFailure(raw);
  recordGhRateLimitSignal(code, args.join(" "));
  console.error(
    `[github/gh] gh ${args.join(" ")} failed (${code}): ${raw.stderr.slice(0, 300)}`,
  );
  return { ok: false, code, stderr: raw.stderr };
}

/**
 * Run a `gh` read query whose `--json` output is parsed into a typed `T`.
 *
 * Adds the two output-shape error modes the raw exec can't know about:
 *   - `gh-empty`         — exit 0 but blank stdout where JSON was required
 *   - `gh-malformed-json`— stdout failed to `JSON.parse`
 *
 * The caller supplies the expected argv (already including `--json <fields>`).
 * The `T` is the caller's responsibility — this adapter does the parse and the
 * error mapping; it does not validate the shape (that is a schema concern).
 *
 * @param args — the `gh` argv WITHOUT the leading `gh`.
 */
export async function ghJson<T = unknown>(
  args: string[],
  opts: GhExecOptions = {},
): Promise<GhResult<T>> {
  const raw = await runExec(ghBin(), args, opts);
  if (raw.exitCode !== 0 || raw.timedOut || raw.spawnErrorCode) {
    const code = classifyFailure(raw);
    recordGhRateLimitSignal(code, args.join(" "));
    console.error(
      `[github/gh] gh ${args.join(" ")} failed (${code}): ${raw.stderr.slice(0, 300)}`,
    );
    return { ok: false, code, stderr: raw.stderr };
  }

  recordGhRateLimitSignal(null, args.join(" "));

  const trimmed = raw.stdout.trim();
  if (trimmed.length === 0) {
    console.error(`[github/gh] gh ${args.join(" ")} produced empty stdout (gh-empty)`);
    return { ok: false, code: "gh-empty", stderr: raw.stderr };
  }

  try {
    const data = JSON.parse(trimmed) as T;
    return { ok: true, data };
  } catch (err: any) {
    console.error(
      `[github/gh] gh ${args.join(" ")} returned malformed JSON (gh-malformed-json): ${err?.message || err}`,
    );
    return { ok: false, code: "gh-malformed-json", stderr: raw.stderr };
  }
}
