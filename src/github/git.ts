/**
 * github/git.ts — the `git` adapter of the **GitHub CLI Adapter** seam (issue #896).
 *
 * Sibling to `gh.ts`, split by external interface (`git` is a different binary
 * with its own argv alphabet) but riding the SAME private spawn primitive in
 * `exec.ts`. No raw `child_process` leaks past this module.
 *
 * Every accessor returns a discriminated `GhResult<T>` and NEVER throws
 * (CLAUDE.md). The `gh-*` failure codes are shared with `gh.ts` — they describe
 * the external-process boundary, not the specific binary — and are result-object
 * literals on the `HydraErrorCode` union, never thrown subclasses.
 *
 * Note on the `HYDRA_GIT_BIN` override: symmetric with `HYDRA_GH_BIN`, it lets
 * tests stub `git` the same way the escalation test stubs `gh`. Production falls
 * back to `git` on PATH.
 */

import {
  gitBin,
  runExec,
  classifyFailure,
  type GhResult,
  type GhExecOptions,
} from "./exec.ts";

/**
 * Run an arbitrary `git` argv and return its trimmed stdout on success.
 *
 * The orchestrator's `git` callers are read-shaped (`git rev-parse`,
 * `git log`, `git diff --name-only`, ...) — they want stdout, not a structured
 * parse. On a non-zero exit / spawn failure / timeout the result is the failure
 * arm with a machine-readable `code`.
 *
 * @param args — the `git` argv WITHOUT the leading `git` (e.g. `["rev-parse","HEAD"]`).
 */
export async function gitExec(
  args: string[],
  opts: GhExecOptions = {},
): Promise<GhResult<{ stdout: string; stderr: string }>> {
  const raw = await runExec(gitBin(), args, opts);
  if (raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode) {
    return { ok: true, data: { stdout: raw.stdout, stderr: raw.stderr } };
  }
  const code = classifyFailure(raw);
  console.error(
    `[github/git] git ${args.join(" ")} failed (${code}): ${raw.stderr.slice(0, 300)}`,
  );
  return { ok: false, code, stderr: raw.stderr };
}
