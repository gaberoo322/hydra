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
} from "./exec.ts";

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
    return { ok: true, data: { stdout: raw.stdout, stderr: raw.stderr } };
  }
  const code = classifyFailure(raw);
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
    console.error(
      `[github/gh] gh ${args.join(" ")} failed (${code}): ${raw.stderr.slice(0, 300)}`,
    );
    return { ok: false, code, stderr: raw.stderr };
  }

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
